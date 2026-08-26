package com.superlooi.realtimeaudioroute

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RealtimeAudioRouteModule : Module() {
  private var active = false
  private var lastRouteRequestAccepted: Boolean? = null
  private var modeBeforeActivation: Int? = null
  private var modeChangedByModule = false
  private var lastModeRestoreApplied: Boolean? = null

  // Read-only ownership diagnostics. These counters describe only mutations
  // performed by this module, making it possible to spot a speaker route that
  // reappears later while active=false without changing routing behavior.
  private var deviceMutationSequence = 0
  private var lastDeviceMutation: String? = null
  private var lastDeviceMutationAtMs: Long? = null
  private var lastDeviceBeforeMutation: Int? = null
  private var lastDeviceAfterMutation: Int? = null
  private var modeMutationSequence = 0
  private var lastModeMutation: String? = null
  private var lastModeMutationAtMs: Long? = null
  private var lastModeBeforeMutation: Int? = null
  private var lastModeAfterMutation: Int? = null

  private val relevantEffectCatalog: String by lazy {
    runCatching {
      val effects = AudioEffect.queryEffects() ?: emptyArray()
      effects
        .filter { descriptor ->
          descriptor.type == AudioEffect.EFFECT_TYPE_AEC ||
            descriptor.type == AudioEffect.EFFECT_TYPE_NS ||
            descriptor.type == AudioEffect.EFFECT_TYPE_AGC
        }
        .joinToString(";") { descriptor -> effectDescriptorSummary(descriptor) }
    }.getOrElse { error -> "query-error:${error.javaClass.simpleName}" }
  }

  override fun definition() = ModuleDefinition {
    Name("RealtimeAudioRoute")

    AsyncFunction("activateSpeakerRoute") Coroutine ::activateSpeakerRoute
    AsyncFunction("ensureSpeakerRoute") Coroutine ::ensureSpeakerRoute
    AsyncFunction("deactivateSpeakerRoute") Coroutine ::deactivateSpeakerRoute
    AsyncFunction("getStatus") Coroutine ::getStatus
  }

  private suspend fun activateSpeakerRoute(): Map<String, Any?> {
    val audioManager = requireAudioManager()

    // Select the Android communication topology without touching WebRTC's
    // AudioDeviceModule, recorder source, AEC or NS. v2.1.82+ invokes this
    // before WebRTC capture so MODE_IN_COMMUNICATION and the built-in speaker
    // already exist when the default VOICE_COMMUNICATION AudioRecord is made.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw IllegalStateException(
        "Built-in speaker routing requires Android 12+ setCommunicationDevice()"
      )
    }

    if (!active) {
      modeBeforeActivation = audioManager.mode
      modeChangedByModule = false
      lastModeRestoreApplied = null
    }

    ensureCommunicationMode(audioManager)

    return try {
      lastRouteRequestAccepted = selectBuiltInSpeaker(audioManager)
      active = lastRouteRequestAccepted == true
      if (!active) rollbackCommunicationMode(audioManager)
      status(audioManager)
    } catch (error: Throwable) {
      rollbackCommunicationMode(audioManager)
      throw error
    }
  }

  private suspend fun ensureSpeakerRoute(): Map<String, Any?> {
    val audioManager = requireAudioManager()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return status(audioManager)

    if (active) {
      ensureCommunicationMode(audioManager)
      try {
        lastRouteRequestAccepted = selectBuiltInSpeaker(audioManager)
        active = lastRouteRequestAccepted == true
        if (!active) rollbackCommunicationMode(audioManager)
      } catch (error: Throwable) {
        rollbackCommunicationMode(audioManager)
        throw error
      }
    }
    return status(audioManager)
  }

  private suspend fun deactivateSpeakerRoute(): Map<String, Any?> {
    val audioManager = requireAudioManager()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val speakerSelected =
        audioManager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
      if (active || speakerSelected || lastRouteRequestAccepted == true) {
        val beforeType = audioManager.communicationDevice?.type
        audioManager.clearCommunicationDevice()
        recordDeviceMutation(
          "clear-communication-device",
          beforeType,
          audioManager.communicationDevice?.type
        )
      }
    }

    active = false
    lastRouteRequestAccepted = null
    restorePreviousMode(audioManager)
    return status(audioManager)
  }

  private suspend fun getStatus(): Map<String, Any?> = status(requireAudioManager())

  private fun requireAudioManager(): AudioManager {
    val context = appContext.reactContext
      ?: throw IllegalStateException("Android React context is unavailable")
    return context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: throw IllegalStateException("Android AudioManager is unavailable")
  }

  private fun ensureCommunicationMode(audioManager: AudioManager) {
    if (audioManager.mode == AudioManager.MODE_IN_COMMUNICATION) return
    if (modeBeforeActivation == null) modeBeforeActivation = audioManager.mode
    val beforeMode = audioManager.mode
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    recordModeMutation("set-mode-in-communication", beforeMode, audioManager.mode)
    modeChangedByModule = true
    lastModeRestoreApplied = null
  }

  private fun rollbackCommunicationMode(audioManager: AudioManager) {
    active = false
    lastRouteRequestAccepted = false
    restorePreviousMode(audioManager)
  }

  private fun restorePreviousMode(audioManager: AudioManager) {
    if (!modeChangedByModule) {
      lastModeRestoreApplied = null
      return
    }

    val previousMode = modeBeforeActivation
    if (previousMode != null && audioManager.mode == AudioManager.MODE_IN_COMMUNICATION) {
      val beforeMode = audioManager.mode
      audioManager.mode = previousMode
      recordModeMutation("restore-previous-mode", beforeMode, audioManager.mode)
      lastModeRestoreApplied = true
    } else {
      // Do not overwrite a mode another Android audio owner may have selected.
      lastModeRestoreApplied = false
    }
    modeChangedByModule = false
  }

  private fun selectBuiltInSpeaker(audioManager: AudioManager): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    if (audioManager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
      return true
    }
    val speaker = audioManager.availableCommunicationDevices.firstOrNull {
      it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    } ?: throw IllegalStateException("Built-in speaker is unavailable for communication audio")
    val beforeType = audioManager.communicationDevice?.type
    val accepted = audioManager.setCommunicationDevice(speaker)
    recordDeviceMutation(
      "set-built-in-speaker",
      beforeType,
      audioManager.communicationDevice?.type
    )
    return accepted
  }

  private fun recordDeviceMutation(name: String, beforeType: Int?, afterType: Int?) {
    deviceMutationSequence += 1
    lastDeviceMutation = name
    lastDeviceMutationAtMs = System.currentTimeMillis()
    lastDeviceBeforeMutation = beforeType
    lastDeviceAfterMutation = afterType
  }

  private fun recordModeMutation(name: String, beforeMode: Int, afterMode: Int) {
    modeMutationSequence += 1
    lastModeMutation = name
    lastModeMutationAtMs = System.currentTimeMillis()
    lastModeBeforeMutation = beforeMode
    lastModeAfterMutation = afterMode
  }

  private fun status(audioManager: AudioManager): Map<String, Any?> {
    val communicationDevice = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.communicationDevice
    } else null
    val communicationDevices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.availableCommunicationDevices
    } else emptyList()
    val speakerAvailable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationDevices.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
    } else false
    @Suppress("DEPRECATION")
    val speakerphoneOn = audioManager.isSpeakerphoneOn
    val speakerSelected = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    } else false

    val captureDiagnostics = captureDiagnostics(audioManager)

    return mapOf(
      "supported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
      "active" to active,
      "sdkInt" to Build.VERSION.SDK_INT,
      "mode" to audioManager.mode,
      "modeName" to modeName(audioManager.mode),
      "modeMatchesCommunication" to (audioManager.mode == AudioManager.MODE_IN_COMMUNICATION),
      "modeChangedByModule" to modeChangedByModule,
      "modeBeforeActivation" to modeBeforeActivation,
      "modeBeforeActivationName" to modeBeforeActivation?.let { modeName(it) },
      "modeRestoreApplied" to lastModeRestoreApplied,
      "routeStrategy" to "mode-in-communication-plus-set-communication-device",
      "routeRequestAccepted" to lastRouteRequestAccepted,
      "speakerSelected" to speakerSelected,
      "speakerphoneOn" to speakerphoneOn,
      "communicationDeviceType" to communicationDevice?.type,
      "communicationDeviceTypeName" to communicationDevice?.let { deviceTypeName(it.type) },
      "communicationDeviceName" to communicationDevice?.productName?.toString(),
      "speakerDeviceAvailable" to speakerAvailable,
      "availableCommunicationDeviceTypes" to communicationDevices
        .joinToString(",") { deviceTypeName(it.type) },
      "routeOwnershipMismatch" to (!active && speakerSelected),
      "activeRouteMismatch" to (active && !speakerSelected),
      "deviceMutationSequence" to deviceMutationSequence,
      "lastDeviceMutation" to lastDeviceMutation,
      "lastDeviceMutationAtMs" to lastDeviceMutationAtMs,
      "lastDeviceBeforeMutation" to lastDeviceBeforeMutation,
      "lastDeviceBeforeMutationName" to lastDeviceBeforeMutation?.let { deviceTypeName(it) },
      "lastDeviceAfterMutation" to lastDeviceAfterMutation,
      "lastDeviceAfterMutationName" to lastDeviceAfterMutation?.let { deviceTypeName(it) },
      "modeMutationSequence" to modeMutationSequence,
      "lastModeMutation" to lastModeMutation,
      "lastModeMutationAtMs" to lastModeMutationAtMs,
      "lastModeBeforeMutation" to lastModeBeforeMutation,
      "lastModeBeforeMutationName" to lastModeBeforeMutation?.let { modeName(it) },
      "lastModeAfterMutation" to lastModeAfterMutation,
      "lastModeAfterMutationName" to lastModeAfterMutation?.let { modeName(it) },
    ) + captureDiagnostics
  }

  private fun captureDiagnostics(audioManager: AudioManager): Map<String, Any?> {
    val configurations = runCatching { audioManager.activeRecordingConfigurations }
      .getOrElse { emptyList() }
    val primary = configurations.firstOrNull {
      it.clientAudioSource == MediaRecorder.AudioSource.VOICE_COMMUNICATION
    } ?: configurations.firstOrNull()

    val clientEffects = if (primary != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching { primary.clientEffects }.getOrElse { emptyList() }
    } else emptyList()
    val streamEffects = if (primary != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching { primary.effects }.getOrElse { emptyList() }
    } else emptyList()

    val primaryAudioSource = if (primary != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching { primary.audioSource }.getOrNull()
    } else null
    val primarySilenced = if (primary != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching { primary.isClientSilenced }.getOrNull()
    } else null

    val primaryDevice = primary?.audioDevice
    val primaryClientFormat = primary?.clientFormat
    val primaryDeviceFormat = primary?.format

    return mapOf(
      "activeRecordingCount" to configurations.size,
      "voiceCommunicationRecordingCount" to configurations.count {
        it.clientAudioSource == MediaRecorder.AudioSource.VOICE_COMMUNICATION
      },
      "recordingConfigSummary" to configurations.joinToString(";") { config ->
        recordingConfigurationSummary(config)
      },
      "primaryRecordingSessionId" to primary?.clientAudioSessionId,
      "primaryClientAudioSource" to primary?.clientAudioSource,
      "primaryClientAudioSourceName" to primary?.clientAudioSource?.let { audioSourceName(it) },
      "primaryAudioSource" to primaryAudioSource,
      "primaryAudioSourceName" to primaryAudioSource?.let { audioSourceName(it) },
      "primaryInputDeviceType" to primaryDevice?.type,
      "primaryInputDeviceTypeName" to primaryDevice?.let { deviceTypeName(it.type) },
      "primaryInputDeviceName" to primaryDevice?.productName?.toString(),
      "primaryClientSilenced" to primarySilenced,
      "primaryClientFormat" to primaryClientFormat?.let { audioFormatSummary(it) },
      "primaryDeviceFormat" to primaryDeviceFormat?.let { audioFormatSummary(it) },
      "primaryClientEffects" to effectListSummary(clientEffects),
      "primaryStreamEffects" to effectListSummary(streamEffects),
      "primaryClientHasAec" to hasEffect(clientEffects, AudioEffect.EFFECT_TYPE_AEC),
      "primaryStreamHasAec" to hasEffect(streamEffects, AudioEffect.EFFECT_TYPE_AEC),
      "primaryClientHasNs" to hasEffect(clientEffects, AudioEffect.EFFECT_TYPE_NS),
      "primaryStreamHasNs" to hasEffect(streamEffects, AudioEffect.EFFECT_TYPE_NS),
      "primaryClientHasAgc" to hasEffect(clientEffects, AudioEffect.EFFECT_TYPE_AGC),
      "primaryStreamHasAgc" to hasEffect(streamEffects, AudioEffect.EFFECT_TYPE_AGC),
      "platformAecAvailable" to AcousticEchoCanceler.isAvailable(),
      "platformNsAvailable" to NoiseSuppressor.isAvailable(),
      "platformAgcAvailable" to AutomaticGainControl.isAvailable(),
      "platformPreprocessorCatalog" to relevantEffectCatalog,
    )
  }

  private fun recordingConfigurationSummary(config: android.media.AudioRecordingConfiguration): String {
    val streamSource = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching { audioSourceName(config.audioSource) }.getOrDefault("unknown")
    } else "n/a"
    val silenced = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching { config.isClientSilenced }.getOrNull()
    } else null
    val streamEffects = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching { effectListShort(config.effects) }.getOrDefault("error")
    } else "n/a"
    return buildString {
      append("sid=").append(config.clientAudioSessionId)
      append(",client=").append(audioSourceName(config.clientAudioSource))
      append(",stream=").append(streamSource)
      append(",dev=").append(config.audioDevice?.let { deviceTypeName(it.type) } ?: "unknown")
      append(",silenced=").append(silenced ?: "n/a")
      append(",fx=").append(streamEffects)
    }
  }

  private fun audioFormatSummary(format: AudioFormat): String =
    "sr=${format.sampleRate},ch=${format.channelCount},enc=${format.encoding},mask=${format.channelMask}"

  private fun hasEffect(
    effects: List<AudioEffect.Descriptor>,
    type: java.util.UUID
  ): Boolean = effects.any { it.type == type }

  private fun effectListShort(effects: List<AudioEffect.Descriptor>): String =
    if (effects.isEmpty()) "none" else effects.joinToString(",") { effectTypeName(it.type) }

  private fun effectListSummary(effects: List<AudioEffect.Descriptor>): String =
    if (effects.isEmpty()) "none" else effects.joinToString(";") { effectDescriptorSummary(it) }

  private fun effectDescriptorSummary(descriptor: AudioEffect.Descriptor): String =
    "${effectTypeName(descriptor.type)}:${descriptor.name}@${descriptor.implementor}[${descriptor.uuid}]"

  private fun effectTypeName(type: java.util.UUID): String = when (type) {
    AudioEffect.EFFECT_TYPE_AEC -> "AEC"
    AudioEffect.EFFECT_TYPE_NS -> "NS"
    AudioEffect.EFFECT_TYPE_AGC -> "AGC"
    else -> type.toString()
  }

  private fun audioSourceName(source: Int): String = when (source) {
    MediaRecorder.AudioSource.DEFAULT -> "DEFAULT"
    MediaRecorder.AudioSource.MIC -> "MIC"
    MediaRecorder.AudioSource.VOICE_UPLINK -> "VOICE_UPLINK"
    MediaRecorder.AudioSource.VOICE_DOWNLINK -> "VOICE_DOWNLINK"
    MediaRecorder.AudioSource.VOICE_CALL -> "VOICE_CALL"
    MediaRecorder.AudioSource.CAMCORDER -> "CAMCORDER"
    MediaRecorder.AudioSource.VOICE_RECOGNITION -> "VOICE_RECOGNITION"
    MediaRecorder.AudioSource.VOICE_COMMUNICATION -> "VOICE_COMMUNICATION"
    MediaRecorder.AudioSource.UNPROCESSED -> "UNPROCESSED"
    MediaRecorder.AudioSource.VOICE_PERFORMANCE -> "VOICE_PERFORMANCE"
    else -> "source-$source"
  }

  private fun modeName(mode: Int): String = when (mode) {
    AudioManager.MODE_NORMAL -> "normal"
    AudioManager.MODE_RINGTONE -> "ringtone"
    AudioManager.MODE_IN_CALL -> "in-call"
    AudioManager.MODE_IN_COMMUNICATION -> "in-communication"
    else -> "unknown-$mode"
  }

  private fun deviceTypeName(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "built-in-earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "built-in-speaker"
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built-in-mic"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired-headset"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired-headphones"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth-sco"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth-a2dp"
    AudioDeviceInfo.TYPE_USB_DEVICE -> "usb-device"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb-headset"
    else -> "type-$type"
  }
}
