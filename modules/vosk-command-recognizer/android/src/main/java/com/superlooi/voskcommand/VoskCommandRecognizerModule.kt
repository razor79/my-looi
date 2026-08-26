package com.superlooi.voskcommand

import android.content.res.AssetManager
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

class VoskCommandRecognizerModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()
  private val queuedChunks = AtomicInteger(0)
  private val resetGeneration = AtomicInteger(0)
  private val resetCount = AtomicInteger(0)
  private val samplesSinceReset = AtomicLong(0)
  private val emergencySamplesSinceReset = AtomicLong(0)
  private val emergencyArmGeneration = AtomicInteger(0)
  private val sessionCounter = AtomicInteger(0)

  private var model: Model? = null
  private var recognizer: Recognizer? = null
  // A second recognizer shares the same acoustic model but has a tiny STOP-only
  // grammar. It is fed before the normal command recognizer so emergency STOP
  // does not wait behind the 5k+ phrase driving grammar.
  private var emergencyRecognizer: Recognizer? = null
  private var currentLanguage: String = ""
  private var currentAssetDir: String = ""
  private var currentGrammar: String = "[]"
  private var currentEmergencyGrammar: String = "[]"
  private var lastPartial: String = ""
  private var lastEmergencyPartial: String = ""
  private var lastEmergencyUnknownEventAtMs: Long = 0L
  private var lastEmergencyHealthEventAtMs: Long = 0L
  @Volatile private var emergencyArmed: Boolean = false
  private var sequence: Int = 0
  @Volatile private var currentSessionId: Int = 0
  @Volatile private var appliedResetGeneration: Int = 0

  override fun definition() = ModuleDefinition {
    Name("VoskCommandRecognizer")

    Events("onCommandResult", "onEmergencyStop", "onEmergencyUnknown", "onEmergencyHealth", "onModelReady", "onRecognizerError", "onRecognizerState")

    // Keep v1.1.36 recognizer lifecycle semantics. prepare() is intentionally
    // not routed through the PCM executor; v1.1.38 adds observability only.
    AsyncFunction("prepare") { language: String, assetDir: String, grammarJson: String, emergencyGrammarJson: String ->
      prepareRecognizer(language, assetDir, grammarJson, emergencyGrammarJson)
    }

    AsyncFunction("setGrammar") { grammarJson: String ->
      emergencyArmed = false
      emergencyArmGeneration.incrementAndGet()
      currentGrammar = grammarJson
      recognizer?.setGrammar(grammarJson)
      recognizer?.reset()
      emergencyRecognizer?.reset()
      lastPartial = ""
      lastEmergencyPartial = ""
      lastEmergencyUnknownEventAtMs = 0L
      lastEmergencyHealthEventAtMs = 0L
      val generation = resetGeneration.incrementAndGet()
      val count = resetCount.incrementAndGet()
      appliedResetGeneration = generation
      samplesSinceReset.set(0)
      emergencySamplesSinceReset.set(0)
      sendRecognizerState("reset-applied", "set-grammar", generation, count, queuedChunks.get(), 0L, true)
    }

    AsyncFunction("armEmergency") { reason: String ->
      // v1.1.41: a STOP recognizer is a per-motion safety primitive. Invalidate
      // any previously queued emergency PCM immediately, then reset + arm on
      // the same serial native executor. JS awaits this before the first BLE
      // drive write, so the first spoken STOP starts from a clean decoder state.
      emergencyArmed = false
      val armGeneration = emergencyArmGeneration.incrementAndGet()
      val task = executor.submit<Boolean> {
        val started = SystemClock.elapsedRealtime()
        if (emergencyArmGeneration.get() != armGeneration) return@submit false
        val emergency = emergencyRecognizer ?: return@submit false
        emergency.reset()
        lastEmergencyPartial = ""
        lastEmergencyUnknownEventAtMs = 0L
        lastEmergencyHealthEventAtMs = 0L
        emergencySamplesSinceReset.set(0)
        if (emergencyArmGeneration.get() != armGeneration) return@submit false
        emergencyArmed = true
        sendRecognizerState(
          "emergency-armed",
          reason,
          appliedResetGeneration,
          resetCount.get(),
          queuedChunks.get(),
          SystemClock.elapsedRealtime() - started,
          true
        )
        true
      }
      task.get()
    }

    AsyncFunction("disarmEmergency") { reason: String ->
      // Flip the gate before queueing the reset so any PCM arriving during the
      // transition is excluded from the emergency decoder. Generation fencing
      // also rejects emergency PCM that was queued under the previous arm.
      emergencyArmed = false
      emergencyArmGeneration.incrementAndGet()
      val task = executor.submit<Unit> {
        val started = SystemClock.elapsedRealtime()
        emergencyRecognizer?.reset()
        lastEmergencyPartial = ""
        lastEmergencyUnknownEventAtMs = 0L
        lastEmergencyHealthEventAtMs = 0L
        emergencySamplesSinceReset.set(0)
        sendRecognizerState(
          "emergency-disarmed",
          reason,
          appliedResetGeneration,
          resetCount.get(),
          queuedChunks.get(),
          SystemClock.elapsedRealtime() - started,
          true
        )
      }
      task.get()
    }

    Function("feedSamples") { samples: List<Double> ->
      if (samples.isEmpty() || recognizer == null) return@Function
      // Copy on the JS call thread, decode on the same dedicated serial native
      // worker used by v1.1.36. No generation fence/drop logic is used here.
      val pcm = FloatArray(samples.size)
      for (i in samples.indices) {
        pcm[i] = (min(1.0, max(-1.0, samples[i])) * 32767.0).toFloat()
      }
      val feedEmergencyGeneration = if (emergencyArmed) emergencyArmGeneration.get() else 0
      queuedChunks.incrementAndGet()
      executor.execute {
        val started = SystemClock.elapsedRealtime()
        try {
          val active = recognizer ?: return@execute
          val fedSamples = samplesSinceReset.addAndGet(pcm.size.toLong())
          val rms16 = calculateRms(pcm)

          // Emergency decoding is active only for a specific motion arm. The
          // generation captured on the JS/native call thread fences queued PCM
          // from before arm/disarm transitions out of the fresh STOP decoder.
          val emergencyIsCurrent =
            feedEmergencyGeneration != 0 &&
            emergencyArmed &&
            feedEmergencyGeneration == emergencyArmGeneration.get()
          val emergency = if (emergencyIsCurrent) emergencyRecognizer else null
          if (emergency != null) {
            val emergencyFedSamples = emergencySamplesSinceReset.addAndGet(pcm.size.toLong())
            val emergencyStarted = SystemClock.elapsedRealtime()
            val emergencyEndpoint = emergency.acceptWaveForm(pcm, pcm.size)
            val emergencyJson = if (emergencyEndpoint) emergency.result else emergency.partialResult
            val emergencyKey = if (emergencyEndpoint) "text" else "partial"
            val emergencyText = try {
              JSONObject(emergencyJson).optString(emergencyKey, "").trim()
            } catch (_: Throwable) {
              ""
            }
            val emergencyProcessingMs = SystemClock.elapsedRealtime() - emergencyStarted
            val emergencyNow = SystemClock.elapsedRealtime()
            if (emergencyNow - lastEmergencyHealthEventAtMs >= 500L) {
              lastEmergencyHealthEventAtMs = emergencyNow
              sendEvent(
                "onEmergencyHealth",
                mapOf(
                  "armed" to emergencyArmed,
                  "armGeneration" to feedEmergencyGeneration,
                  "partialText" to emergencyText,
                  "endpoint" to emergencyEndpoint,
                  "processingMs" to emergencyProcessingMs,
                  "sessionId" to currentSessionId,
                  "samplesSinceEmergencyReset" to emergencyFedSamples,
                  "queuedChunks" to queuedChunks.get(),
                  "rms16" to rms16
                )
              )
            }
            if (emergencyText == "[unk]") {
              val now = SystemClock.elapsedRealtime()
              // Unknown output is useful to diagnose a spoken STOP that was heard
              // acoustically but rejected by the tiny grammar. Keep it rate-limited
              // so normal motor/background noise cannot flood the JS bridge/log.
              if (now - lastEmergencyUnknownEventAtMs >= 1_000L) {
                lastEmergencyUnknownEventAtMs = now
                sendEvent(
                  "onEmergencyUnknown",
                  mapOf(
                    "text" to emergencyText,
                    "partial" to !emergencyEndpoint,
                    "processingMs" to emergencyProcessingMs,
                    "sessionId" to currentSessionId,
                    "samplesSinceEmergencyReset" to emergencyFedSamples,
                    "queuedChunks" to queuedChunks.get(),
                    "rms16" to rms16
                  )
                )
              }
            } else if (emergencyText.isNotEmpty() &&
              (emergencyEndpoint || emergencyText != lastEmergencyPartial)) {
              lastEmergencyPartial = if (emergencyEndpoint) "" else emergencyText
              sendEvent(
                "onEmergencyStop",
                mapOf(
                  "text" to emergencyText,
                  "partial" to !emergencyEndpoint,
                  "processingMs" to emergencyProcessingMs,
                  "sessionId" to currentSessionId,
                  "samplesSinceEmergencyReset" to emergencyFedSamples,
                  "queuedChunks" to queuedChunks.get(),
                  "rms16" to rms16
                )
              )
            }
          }

          val normalStarted = SystemClock.elapsedRealtime()
          val endpoint = active.acceptWaveForm(pcm, pcm.size)
          val json = if (endpoint) active.result else active.partialResult
          val key = if (endpoint) "text" else "partial"
          val text = try {
            JSONObject(json).optString(key, "").trim()
          } catch (_: Throwable) {
            ""
          }
          val common = mutableMapOf<String, Any>(
            "sessionId" to currentSessionId,
            "resetGeneration" to appliedResetGeneration,
            "samplesSinceReset" to fedSamples,
            "queuedChunks" to queuedChunks.get(),
            "droppedChunks" to 0,
            "endpoint" to endpoint,
            "rms16" to rms16,
            // Keep this metric comparable with prior builds: normal recognizer
            // processing time excludes the new emergency recognizer overhead.
            "processingMs" to (SystemClock.elapsedRealtime() - normalStarted)
          )
          if (endpoint) {
            lastPartial = ""
            sequence += 1
            common["text"] = text
            common["partial"] = false
            common["sequence"] = sequence
            sendEvent("onCommandResult", common)
          } else if (text.isNotEmpty() && text != lastPartial) {
            lastPartial = text
            sequence += 1
            common["text"] = text
            common["partial"] = true
            common["sequence"] = sequence
            sendEvent("onCommandResult", common)
          }
        } catch (error: Throwable) {
          sendError("feed", error)
        } finally {
          queuedChunks.decrementAndGet()
        }
      }
    }

    Function("reset") { reason: String, resetEmergency: Boolean ->
      if (resetEmergency) {
        emergencyArmed = false
        emergencyArmGeneration.incrementAndGet()
      }
      // Normal command resets preserve the tiny emergency recognizer unless the
      // caller explicitly requests an emergency reset. This prevents a STOP
      // spoken immediately after motor start from being erased by the normal
      // post-command reset. The serial executor ordering remains v1.1.36-style.
      val generation = resetGeneration.incrementAndGet()
      val count = resetCount.incrementAndGet()
      sendRecognizerState("reset-requested", reason, generation, count, queuedChunks.get(), 0L, resetEmergency)
      executor.execute {
        val started = SystemClock.elapsedRealtime()
        try {
          recognizer?.reset()
          lastPartial = ""
          appliedResetGeneration = generation
          samplesSinceReset.set(0)
          if (resetEmergency) {
            emergencyRecognizer?.reset()
            lastEmergencyPartial = ""
            lastEmergencyUnknownEventAtMs = 0L
            lastEmergencyHealthEventAtMs = 0L
            emergencySamplesSinceReset.set(0)
          }
          sendRecognizerState(
            "reset-applied",
            reason,
            generation,
            count,
            queuedChunks.get(),
            SystemClock.elapsedRealtime() - started,
            resetEmergency
          )
        } catch (error: Throwable) {
          sendError("reset", error)
        }
      }
      generation
    }

    Function("unload") {
      executor.execute {
        closeRecognizer()
        currentLanguage = ""
        currentAssetDir = ""
      }
    }

    Function("getStatus") {
      mapOf(
        "ready" to (recognizer != null),
        "language" to currentLanguage,
        "queuedChunks" to queuedChunks.get(),
        "sessionId" to currentSessionId,
        "resetGeneration" to appliedResetGeneration,
        "resetCount" to resetCount.get(),
        "droppedChunks" to 0,
        "samplesSinceReset" to samplesSinceReset.get(),
        "emergencySamplesSinceReset" to emergencySamplesSinceReset.get(),
        "emergencyArmed" to emergencyArmed,
        "emergencyArmGeneration" to emergencyArmGeneration.get()
      )
    }

    OnDestroy {
      executor.execute { closeRecognizer() }
      executor.shutdown()
    }
  }

  private fun prepareRecognizer(language: String, assetDir: String, grammarJson: String, emergencyGrammarJson: String) {
    val context = appContext.reactContext ?: throw IllegalStateException("React context unavailable")
    val started = SystemClock.elapsedRealtime()
    val destination = File(context.filesDir, "vosk-command-models/$assetDir")
    val cached = destination.exists() && destination.list()?.isNotEmpty() == true

    if (!cached) {
      destination.parentFile?.mkdirs()
      copyAssetTree(context.assets, assetDir, destination)
    }

    if (currentLanguage != language || currentAssetDir != assetDir || model == null) {
      closeRecognizer()
      model = Model(destination.absolutePath)
      currentLanguage = language
      currentAssetDir = assetDir
    } else {
      recognizer?.close()
      recognizer = null
      emergencyRecognizer?.close()
      emergencyRecognizer = null
    }

    currentGrammar = grammarJson
    currentEmergencyGrammar = emergencyGrammarJson
    recognizer = Recognizer(model, 16000.0f, grammarJson).also {
      it.setWords(true)
      it.setPartialWords(false)
      it.setEndpointerMode(Recognizer.EndpointerMode.SHORT)
      // Restored v1.1.36 command behavior after the v1.1.37 600 ms endpoint
      // experiment regressed repeated driving control on the physical robot.
      it.setEndpointerDelays(3.0f, 0.26f, 5.0f)
    }
    emergencyRecognizer = Recognizer(model, 16000.0f, emergencyGrammarJson).also {
      it.setWords(false)
      it.setPartialWords(false)
      it.setEndpointerMode(Recognizer.EndpointerMode.SHORT)
      // Endpoint is only a fallback: JS executes emergency STOP on a matching
      // partial. Keep finalization short for cases where only final text appears.
      it.setEndpointerDelays(3.0f, 0.12f, 3.0f)
    }
    lastPartial = ""
    lastEmergencyPartial = ""
    lastEmergencyUnknownEventAtMs = 0L
    lastEmergencyHealthEventAtMs = 0L
    emergencyArmed = false
    emergencyArmGeneration.incrementAndGet()
    sequence = 0
    currentSessionId = sessionCounter.incrementAndGet()
    resetGeneration.set(0)
    resetCount.set(0)
    appliedResetGeneration = 0
    samplesSinceReset.set(0)
    emergencySamplesSinceReset.set(0)

    sendEvent(
      "onModelReady",
      mapOf(
        "language" to language,
        "assetDir" to assetDir,
        "loadMs" to (SystemClock.elapsedRealtime() - started),
        "cached" to cached,
        "sessionId" to currentSessionId,
        "resetGeneration" to appliedResetGeneration
      )
    )
    sendRecognizerState("ready", "prepare", appliedResetGeneration, resetCount.get(), queuedChunks.get(), 0L)
  }

  private fun closeRecognizer() {
    try { recognizer?.close() } catch (_: Throwable) {}
    recognizer = null
    try { emergencyRecognizer?.close() } catch (_: Throwable) {}
    emergencyRecognizer = null
    try { model?.close() } catch (_: Throwable) {}
    model = null
    lastPartial = ""
    lastEmergencyPartial = ""
    lastEmergencyUnknownEventAtMs = 0L
    lastEmergencyHealthEventAtMs = 0L
    emergencyArmed = false
    emergencyArmGeneration.incrementAndGet()
    emergencySamplesSinceReset.set(0)
  }

  private fun calculateRms(pcm: FloatArray): Double {
    if (pcm.isEmpty()) return 0.0
    var sumSquares = 0.0
    for (sample in pcm) {
      val value = sample.toDouble()
      sumSquares += value * value
    }
    return sqrt(sumSquares / pcm.size.toDouble())
  }

  private fun sendRecognizerState(
    state: String,
    reason: String,
    generation: Int,
    count: Int,
    queueDepth: Int,
    processingMs: Long,
    emergencyReset: Boolean = false
  ) {
    sendEvent(
      "onRecognizerState",
      mapOf(
        "state" to state,
        "reason" to reason,
        "sessionId" to currentSessionId,
        "resetGeneration" to generation,
        "resetCount" to count,
        "queuedChunks" to queueDepth,
        "droppedChunks" to 0,
        "samplesSinceReset" to samplesSinceReset.get(),
        "emergencySamplesSinceReset" to emergencySamplesSinceReset.get(),
        "emergencyArmed" to emergencyArmed,
        "emergencyArmGeneration" to emergencyArmGeneration.get(),
        "emergencyReset" to emergencyReset,
        "processingMs" to processingMs
      )
    )
  }

  private fun copyAssetTree(assetManager: AssetManager, assetPath: String, destination: File) {
    val children = assetManager.list(assetPath) ?: emptyArray()
    if (children.isEmpty()) {
      destination.parentFile?.mkdirs()
      assetManager.open(assetPath).use { input ->
        FileOutputStream(destination).use { output -> input.copyTo(output, 1024 * 1024) }
      }
      return
    }

    destination.mkdirs()
    for (child in children) {
      copyAssetTree(assetManager, "$assetPath/$child", File(destination, child))
    }
  }

  private fun sendError(stage: String, error: Throwable) {
    sendEvent(
      "onRecognizerError",
      mapOf(
        "stage" to stage,
        "message" to (error.message ?: error.javaClass.simpleName)
      )
    )
  }
}
