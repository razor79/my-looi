package com.superlooi.backgroundprocessexit

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BackgroundProcessExitModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  private var pendingExit: Runnable? = null
  private var scheduledAtElapsedMs: Long? = null
  private var scheduledDelayMs: Long? = null

  override fun definition() = ModuleDefinition {
    Name("BackgroundProcessExit")

    AsyncFunction("scheduleExit") Coroutine { delayMs: Long ->
      require(delayMs in MIN_DELAY_MS..MAX_DELAY_MS) {
        "Background process exit delay must be between $MIN_DELAY_MS and $MAX_DELAY_MS ms"
      }
      scheduleExit(delayMs)
    }

    AsyncFunction("cancelExit") Coroutine ::cancelExitAndGetStatus
    AsyncFunction("getStatus") Coroutine ::status
    AsyncFunction("consumePreviousExitMarker") Coroutine ::consumePreviousExitMarker
  }

  private fun scheduleExit(delayMs: Long): Map<String, Any?> {
    cancelExit()

    val applicationContext = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("Android application context is unavailable")
    val preferences = applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    val scheduledPid = Process.myPid()
    val runnable = Runnable {
      pendingExit = null
      scheduledAtElapsedMs = null
      scheduledDelayMs = null

      // Commit synchronously immediately before process death so the next cold
      // launch can prove that the prior process exited through this policy.
      preferences.edit()
        .putLong(KEY_LAST_EXIT_EPOCH_MS, System.currentTimeMillis())
        .putInt(KEY_LAST_EXIT_PID, scheduledPid)
        .commit()

      Process.killProcess(scheduledPid)
    }

    pendingExit = runnable
    scheduledAtElapsedMs = SystemClock.elapsedRealtime()
    scheduledDelayMs = delayMs
    handler.postDelayed(runnable, delayMs)
    return status()
  }

  private fun cancelExit() {
    pendingExit?.let { handler.removeCallbacks(it) }
    pendingExit = null
    scheduledAtElapsedMs = null
    scheduledDelayMs = null
  }

  private fun cancelExitAndGetStatus(): Map<String, Any?> {
    cancelExit()
    return status()
  }

  private fun status(): Map<String, Any?> {
    val now = SystemClock.elapsedRealtime()
    val scheduledAt = scheduledAtElapsedMs
    val delay = scheduledDelayMs
    val remaining = if (scheduledAt != null && delay != null) {
      (scheduledAt + delay - now).coerceAtLeast(0L)
    } else null

    return mapOf(
      "supported" to true,
      "pid" to Process.myPid(),
      "scheduled" to (pendingExit != null),
      "scheduledDelayMs" to delay,
      "remainingMs" to remaining
    )
  }

  private fun consumePreviousExitMarker(): Map<String, Any?>? {
    val context = appContext.reactContext?.applicationContext ?: return null
    val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    val epochMs = preferences.getLong(KEY_LAST_EXIT_EPOCH_MS, 0L)
    if (epochMs <= 0L) return null
    val previousPid = preferences.getInt(KEY_LAST_EXIT_PID, -1)
    preferences.edit()
      .remove(KEY_LAST_EXIT_EPOCH_MS)
      .remove(KEY_LAST_EXIT_PID)
      .apply()
    return mapOf(
      "epochMs" to epochMs,
      "pid" to previousPid
    )
  }

  companion object {
    private const val MIN_DELAY_MS = 1_000L
    private const val MAX_DELAY_MS = 30_000L
    private const val PREFERENCES_NAME = "super_looi_background_process_exit"
    private const val KEY_LAST_EXIT_EPOCH_MS = "last_intentional_exit_epoch_ms"
    private const val KEY_LAST_EXIT_PID = "last_intentional_exit_pid"
  }
}
