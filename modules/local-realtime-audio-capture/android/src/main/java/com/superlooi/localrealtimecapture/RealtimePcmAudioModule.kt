package com.superlooi.localrealtimecapture

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Experimental app-owned Realtime PCM transport.
 *
 * Capture uses VOICE_COMMUNICATION, 16 kHz mono PCM16 and an explicit platform
 * AcousticEchoCanceler bound to the live AudioRecord session. AudioRecord is
 * started before AEC attachment so the effect binds to an active recording
 * session. No app-level AGC or NoiseSuppressor is added in this path.
 *
 * Playback is app-owned 24 kHz mono PCM16 through a streaming AudioTrack with
 * USAGE_VOICE_COMMUNICATION + CONTENT_TYPE_SPEECH. A fresh track is used for
 * each assistant turn so playback-head position can be used for precise
 * WebSocket conversation.item.truncate on barge-in.
 */
class RealtimePcmAudioModule : Module() {
  companion object {
    private const val CAPTURE_RATE = 16_000
    private const val PLAYBACK_RATE = 24_000
    private const val CAPTURE_CHUNK_FRAMES = 640 // 40 ms @ 16 kHz
    private const val BYTES_PER_SAMPLE = 2
    private const val PLAYBACK_POLL_MS = 10L
  }

  private val captureRunning = AtomicBoolean(false)
  private val captureChunks = AtomicLong(0)
  private var recorder: AudioRecord? = null
  private var aec: AcousticEchoCanceler? = null
  private var captureThread: Thread? = null
  @Volatile private var captureSessionId: Int? = null
  @Volatile private var aecEnabled = false

  private val playbackLock = Any()
  private val playbackQueue = LinkedBlockingQueue<ByteArray>()
  private var playbackTrack: AudioTrack? = null
  private var playbackThread: Thread? = null
  private val playbackRunning = AtomicBoolean(false)
  private val playbackFinishRequested = AtomicBoolean(false)
  @Volatile private var playbackWrittenFrames = 0L
  @Volatile private var playbackTurnStartedAtMs = 0L

  override fun definition() = ModuleDefinition {
    Name("RealtimePcmAudio")
    Events("onAudioData", "onCaptureError", "onPlaybackDrained", "onPlaybackError")

    AsyncFunction("startCapture") { startCaptureAndStatus() }
    AsyncFunction("stopCapture") { stopCaptureAndStatus() }
    AsyncFunction("getStatus") { status() }

    Function("beginPlayback") { beginPlayback() }
    Function("enqueuePlayback") { pcm24Base64: String -> enqueuePlayback(pcm24Base64) }
    Function("finishPlayback") { finishPlayback() }
    Function("stopPlayback") { stopPlaybackAndStatus() }
    Function("getPlayedDurationMs") { currentPlayedDurationMs() }

    OnDestroy {
      stopCapture()
      stopPlayback()
    }
  }

  private fun startCaptureAndStatus(): Map<String, Any?> {
    startCapture()
    return status()
  }

  private fun stopCaptureAndStatus(): Map<String, Any?> {
    stopCapture()
    return status()
  }

  @Synchronized private fun startCapture() {
    if (captureRunning.get()) return
    val context = appContext.reactContext ?: throw IllegalStateException("React context is unavailable")
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw SecurityException("RECORD_AUDIO permission is required")
    }
    if (!AcousticEchoCanceler.isAvailable()) {
      throw IllegalStateException("Platform AcousticEchoCanceler is unavailable")
    }

    val minBuffer = AudioRecord.getMinBufferSize(
      CAPTURE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minBuffer <= 0) throw IllegalStateException("AudioRecord minimum buffer query failed: $minBuffer")
    val bufferBytes = max(minBuffer * 2, CAPTURE_CHUNK_FRAMES * BYTES_PER_SAMPLE * 4)
    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setSampleRate(CAPTURE_RATE)
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

    // Use the stable ordering required by this Android audio stack:
    // start VOICE_COMMUNICATION recording first, then attach/enable hardware AEC
    // to the already-live audio session. Enabling AEC before startRecording was
    // observed physically to correlate with intermittent severely attenuated PCM.
    try {
      audioRecord.startRecording()
      if (audioRecord.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw IllegalStateException("AudioRecord did not enter RECORDSTATE_RECORDING")
      }
    } catch (error: Throwable) {
      try { audioRecord.release() } catch (_: Throwable) {}
      throw error
    }

    val echo = AcousticEchoCanceler.create(currentSessionId)
      ?: run {
        try { audioRecord.stop() } catch (_: Throwable) {}
        audioRecord.release()
        throw IllegalStateException("Failed to create AcousticEchoCanceler")
      }
    echo.enabled = true
    if (!echo.enabled) {
      echo.release()
      try { audioRecord.stop() } catch (_: Throwable) {}
      audioRecord.release()
      throw IllegalStateException("Platform AcousticEchoCanceler could not be enabled")
    }

    recorder = audioRecord
    aec = echo
    captureSessionId = currentSessionId
    aecEnabled = true
    captureChunks.set(0)
    captureRunning.set(true)

    captureThread = Thread({ captureLoop(audioRecord) }, "looi-realtime-pcm-capture").apply {
      priority = Thread.MAX_PRIORITY
      start()
    }
  }

  private fun captureLoop(audioRecord: AudioRecord) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val pcm = ShortArray(CAPTURE_CHUNK_FRAMES)
    var sequence = 0L
    try {
      while (captureRunning.get()) {
        val read = audioRecord.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
        if (read <= 0) {
          if (captureRunning.get()) sendEvent("onCaptureError", mapOf("stage" to "read", "message" to "AudioRecord.read returned $read"))
          continue
        }
        val bytes = ByteBuffer.allocate(read * BYTES_PER_SAMPLE).order(ByteOrder.LITTLE_ENDIAN)
        var energy = 0.0
        for (index in 0 until read) {
          val value = pcm[index]
          bytes.putShort(value)
          val normalized = value.toDouble() / 32768.0
          energy += normalized * normalized
        }
        sequence += 1
        captureChunks.incrementAndGet()
        sendEvent("onAudioData", mapOf(
          "pcm16Base64" to Base64.encodeToString(bytes.array(), Base64.NO_WRAP),
          "sampleRate" to CAPTURE_RATE,
          "frames" to read,
          "rms" to sqrt(energy / max(1, read).toDouble()),
          "sequence" to sequence,
          "timestampMs" to SystemClock.elapsedRealtime()
        ))
      }
    } catch (error: Throwable) {
      if (captureRunning.get()) {
        sendEvent("onCaptureError", mapOf("stage" to "capture-loop", "message" to (error.message ?: error.javaClass.simpleName)))
      }
    }
  }

  @Synchronized private fun stopCapture() {
    if (!captureRunning.getAndSet(false) && recorder == null) return
    try { recorder?.stop() } catch (_: Throwable) {}
    try { captureThread?.join(500) } catch (_: Throwable) {}
    captureThread = null
    releaseCaptureNative()
  }

  private fun releaseCaptureNative() {
    try { aec?.enabled = false } catch (_: Throwable) {}
    try { aec?.release() } catch (_: Throwable) {}
    try { recorder?.release() } catch (_: Throwable) {}
    aec = null
    recorder = null
    captureSessionId = null
    aecEnabled = false
  }

  private fun beginPlayback() {
    synchronized(playbackLock) {
      stopPlaybackLocked()
      playbackQueue.clear()
      playbackWrittenFrames = 0L
      playbackTurnStartedAtMs = SystemClock.elapsedRealtime()
      playbackFinishRequested.set(false)
      ensurePlaybackLocked()
    }
  }

  private fun enqueuePlayback(pcm24Base64: String) {
    if (pcm24Base64.isBlank()) return
    val bytes = Base64.decode(pcm24Base64, Base64.DEFAULT)
    if (bytes.isEmpty()) return
    synchronized(playbackLock) {
      ensurePlaybackLocked()
      playbackQueue.offer(bytes)
    }
  }

  private fun finishPlayback() {
    playbackFinishRequested.set(true)
  }

  private fun stopPlaybackAndStatus(): Map<String, Any?> {
    val playedMs = currentPlayedDurationMs()
    stopPlayback()
    return mapOf("playedDurationMs" to playedMs)
  }

  private fun stopPlayback() {
    synchronized(playbackLock) {
      stopPlaybackLocked()
    }
  }

  private fun stopPlaybackLocked() {
    playbackRunning.set(false)
    playbackFinishRequested.set(false)
    playbackQueue.clear()
    val worker = playbackThread
    playbackThread = null
    worker?.interrupt()
    val track = playbackTrack
    playbackTrack = null
    if (track != null) {
      try { track.pause() } catch (_: Throwable) {}
      try { track.flush() } catch (_: Throwable) {}
      try { track.stop() } catch (_: Throwable) {}
      try { track.release() } catch (_: Throwable) {}
    }
  }

  private fun ensurePlaybackLocked() {
    if (playbackTrack != null && playbackRunning.get()) return
    val minBuffer = AudioTrack.getMinBufferSize(
      PLAYBACK_RATE,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minBuffer <= 0) throw IllegalStateException("AudioTrack minimum buffer query failed: $minBuffer")
    val bufferBytes = max(minBuffer, 2_400)
    val track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(PLAYBACK_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build()
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(bufferBytes)
      .build()
    if (track.state != AudioTrack.STATE_INITIALIZED) {
      track.release()
      throw IllegalStateException("Realtime PCM AudioTrack failed to initialize")
    }
    playbackTrack = track
    playbackWrittenFrames = 0L
    if (playbackTurnStartedAtMs == 0L) playbackTurnStartedAtMs = SystemClock.elapsedRealtime()
    playbackRunning.set(true)
    track.play()
    playbackThread = Thread({ playbackLoop(track) }, "looi-realtime-pcm-playback").apply {
      priority = Thread.MAX_PRIORITY
      start()
    }
  }

  private fun playbackLoop(track: AudioTrack) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    try {
      while (playbackRunning.get()) {
        val bytes = try { playbackQueue.poll(PLAYBACK_POLL_MS, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { null }
        if (bytes != null) {
          var offset = 0
          while (playbackRunning.get() && offset < bytes.size) {
            val written = track.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_BLOCKING)
            if (written <= 0) throw IllegalStateException("AudioTrack.write returned $written")
            offset += written
            playbackWrittenFrames += written / BYTES_PER_SAMPLE
          }
        } else if (playbackFinishRequested.get() && playbackQueue.isEmpty()) {
          val playedFrames = playbackHeadFrames(track)
          if (playedFrames >= playbackWrittenFrames) {
            val playedMs = framesToMs(playedFrames)
            playbackFinishRequested.set(false)
            sendEvent("onPlaybackDrained", mapOf("playedDurationMs" to playedMs))
            // Keep the track alive until the strategy begins the next turn or
            // explicitly stops it; this avoids racing the final callback.
          }
        }
      }
    } catch (error: Throwable) {
      if (playbackRunning.get()) {
        sendEvent("onPlaybackError", mapOf("message" to (error.message ?: error.javaClass.simpleName)))
      }
    }
  }

  private fun playbackHeadFrames(track: AudioTrack): Long {
    // Realtime turns are short enough that unsigned 32-bit playback-head wrap is
    // not a practical concern. Preserve the unsigned value for correctness.
    return track.playbackHeadPosition.toLong() and 0xffffffffL
  }

  private fun currentPlayedDurationMs(): Long {
    val track = playbackTrack ?: return 0L
    return try { framesToMs(playbackHeadFrames(track)) } catch (_: Throwable) { 0L }
  }

  private fun framesToMs(frames: Long): Long = (frames * 1000L) / PLAYBACK_RATE.toLong()

  private fun status() = mapOf(
    "supported" to true,
    "captureRunning" to captureRunning.get(),
    "captureSampleRate" to CAPTURE_RATE,
    "audioSource" to "VOICE_COMMUNICATION",
    "audioSessionId" to captureSessionId,
    "aecAvailable" to AcousticEchoCanceler.isAvailable(),
    "aecEnabled" to aecEnabled,
    "noiseSuppressorExplicit" to false,
    "captureChunks" to captureChunks.get(),
    "playbackRunning" to playbackRunning.get(),
    "playbackSampleRate" to PLAYBACK_RATE,
    "playedDurationMs" to currentPlayedDurationMs(),
    "playbackQueuedChunks" to playbackQueue.size
  )
}
