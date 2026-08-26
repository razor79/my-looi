package com.superlooi.localrealtimecapture

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.sqrt

class LocalRealtimeAudioCaptureModule : Module() {
  companion object {
    private const val SAMPLE_RATE = 48_000
    private const val CHUNK_FRAMES = 1_920 // 40 ms at 48 kHz
  }

  private val running = AtomicBoolean(false)
  private val chunksEmitted = AtomicLong(0)
  private val framesCaptured = AtomicLong(0)
  private var recorder: AudioRecord? = null
  private var aec: AcousticEchoCanceler? = null
  private var ns: NoiseSuppressor? = null
  private var captureThread: Thread? = null
  @Volatile private var sessionId: Int? = null
  @Volatile private var aecEnabled = false
  @Volatile private var nsEnabled = false

  override fun definition() = ModuleDefinition {
    Name("LocalRealtimeAudioCapture")
    Events("onAudioData", "onCaptureError")

    AsyncFunction("getStatus") Coroutine ::status
    AsyncFunction("start") Coroutine ::startCaptureAndGetStatus
    AsyncFunction("stop") Coroutine ::stopCaptureAndGetStatus

    OnDestroy { stopCapture() }
  }

  private fun startCaptureAndGetStatus(): Map<String, Any?> {
    startCapture()
    return status()
  }

  private fun stopCaptureAndGetStatus(): Map<String, Any?> {
    stopCapture()
    return status()
  }

  private fun startCapture() {
    if (running.get()) return
    val context = appContext.reactContext ?: throw IllegalStateException("React context is unavailable")
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw SecurityException("RECORD_AUDIO permission is required")
    }
    if (!AcousticEchoCanceler.isAvailable()) throw IllegalStateException("Platform AcousticEchoCanceler is unavailable")
    if (!NoiseSuppressor.isAvailable()) throw IllegalStateException("Platform NoiseSuppressor is unavailable")

    val minBuffer = AudioRecord.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minBuffer <= 0) throw IllegalStateException("AudioRecord minimum buffer query failed: $minBuffer")
    val bufferBytes = max(minBuffer * 4, CHUNK_FRAMES * 2 * 4)
    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setSampleRate(SAMPLE_RATE)
      .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
      .build()
    val audioRecord = AudioRecord.Builder()
      .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
      .setAudioFormat(format)
      .setBufferSizeInBytes(bufferBytes)
      .build()
    if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
      audioRecord.release()
      throw IllegalStateException("VOICE_COMMUNICATION AudioRecord failed to initialize")
    }

    val currentSessionId = audioRecord.audioSessionId
    val echo = AcousticEchoCanceler.create(currentSessionId)
      ?: run { audioRecord.release(); throw IllegalStateException("Failed to create AcousticEchoCanceler") }
    val suppressor = NoiseSuppressor.create(currentSessionId)
      ?: run { echo.release(); audioRecord.release(); throw IllegalStateException("Failed to create NoiseSuppressor") }
    echo.enabled = true
    suppressor.enabled = true
    if (!echo.enabled || !suppressor.enabled) {
      suppressor.release()
      echo.release()
      audioRecord.release()
      throw IllegalStateException("Platform AEC/NS could not be enabled")
    }

    recorder = audioRecord
    aec = echo
    ns = suppressor
    sessionId = currentSessionId
    aecEnabled = true
    nsEnabled = true
    chunksEmitted.set(0)
    framesCaptured.set(0)
    running.set(true)

    try {
      audioRecord.startRecording()
      if (audioRecord.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw IllegalStateException("AudioRecord did not enter RECORDSTATE_RECORDING")
      }
    } catch (error: Throwable) {
      running.set(false)
      releaseNative()
      throw error
    }

    captureThread = Thread({ captureLoop(audioRecord) }, "looi-local-realtime-capture").apply {
      priority = Thread.MAX_PRIORITY
      start()
    }
  }

  private fun captureLoop(audioRecord: AudioRecord) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val pcm = ShortArray(CHUNK_FRAMES)
    var sequence = 0L
    try {
      while (running.get()) {
        val read = audioRecord.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
        if (read <= 0) {
          if (running.get()) sendCaptureError("read", "AudioRecord.read returned $read")
          continue
        }
        var energy = 0.0
        val bytes = ByteBuffer.allocate(read * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (index in 0 until read) {
          val value = pcm[index]
          bytes.putShort(value)
          val normalized = value.toDouble() / 32768.0
          energy += normalized * normalized
        }
        val rms = sqrt(energy / read.toDouble())
        sequence += 1
        chunksEmitted.incrementAndGet()
        framesCaptured.addAndGet(read.toLong())
        sendEvent("onAudioData", mapOf(
          "pcm16Base64" to Base64.encodeToString(bytes.array(), Base64.NO_WRAP),
          "sampleRate" to SAMPLE_RATE,
          "frames" to read,
          "rms" to rms,
          "sequence" to sequence,
          "timestampMs" to SystemClock.elapsedRealtime()
        ))
      }
    } catch (error: Throwable) {
      if (running.get()) sendCaptureError("capture-loop", error.message ?: error.javaClass.simpleName)
    }
  }

  @Synchronized private fun stopCapture() {
    if (!running.getAndSet(false) && recorder == null) return
    try { recorder?.stop() } catch (_: Throwable) {}
    try { captureThread?.join(500) } catch (_: Throwable) {}
    captureThread = null
    releaseNative()
  }

  private fun releaseNative() {
    try { aec?.release() } catch (_: Throwable) {}
    try { ns?.release() } catch (_: Throwable) {}
    try { recorder?.release() } catch (_: Throwable) {}
    aec = null
    ns = null
    recorder = null
    sessionId = null
    aecEnabled = false
    nsEnabled = false
  }

  private fun sendCaptureError(stage: String, message: String) {
    sendEvent("onCaptureError", mapOf("stage" to stage, "message" to message))
  }

  private fun status() = mapOf(
    "supported" to true,
    "running" to running.get(),
    "sampleRate" to SAMPLE_RATE,
    "audioSource" to "VOICE_COMMUNICATION",
    "audioSessionId" to sessionId,
    "aecAvailable" to AcousticEchoCanceler.isAvailable(),
    "aecEnabled" to aecEnabled,
    "nsAvailable" to NoiseSuppressor.isAvailable(),
    "nsEnabled" to nsEnabled,
    "chunksEmitted" to chunksEmitted.get(),
    "framesCaptured" to framesCaptured.get()
  )
}
