package com.superlooi.localfaceattention

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import android.util.Range
import android.util.Size
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.max

class LocalFaceAttentionModule : Module() {
  private val lock = Any()
  private val detectorBusy = AtomicBoolean(false)
  private val framesAnalyzed = AtomicLong(0)
  private var running = false
  private var cameraId: String? = null
  private var lensFacingName = "unknown"
  private var sensorOrientation = 0
  private var cameraDevice: CameraDevice? = null
  private var captureSession: CameraCaptureSession? = null
  private var imageReader: ImageReader? = null
  private var cameraThread: HandlerThread? = null
  private var cameraHandler: Handler? = null
  private var targetFpsRange: Range<Int>? = null
  private var detector: FaceDetector? = null
  private var pendingDetectorClose: FaceDetector? = null
  private var lastAnalysisAtMs = 0L

  override fun definition() = ModuleDefinition {
    Name("LocalFaceAttention")
    Events("onFaceFrame", "onFaceAttentionError")

    AsyncFunction("start") Coroutine ::startCamera
    AsyncFunction("stop") Coroutine ::stopCameraAndStatus
    AsyncFunction("getStatus") Coroutine ::status

    OnDestroy {
      stopCamera()
    }
  }

  private fun context(): Context = appContext.reactContext?.applicationContext
    ?: throw IllegalStateException("Android application context is unavailable")

  private fun hasPermission(): Boolean = ContextCompat.checkSelfPermission(
    context(),
    Manifest.permission.CAMERA
  ) == PackageManager.PERMISSION_GRANTED


  private fun createDetector(): FaceDetector {
    val options = FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setMinFaceSize(0.12f)
      .enableTracking()
      .build()
    return FaceDetection.getClient(options)
  }

  private fun selectTargetFpsRange(characteristics: CameraCharacteristics): Range<Int>? {
    val ranges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
      ?.toList()
      .orEmpty()
    return ranges.firstOrNull { it.lower == 15 && it.upper == 15 }
      ?: ranges.filter { it.upper <= 20 }.maxByOrNull { it.upper }
  }

  private fun stopCameraAndStatus(): Map<String, Any?> {
    stopCamera()
    return status()
  }

  private fun startCamera(): Map<String, Any?> {
    synchronized(lock) {
      if (running) return status()
      if (!hasPermission()) throw SecurityException("Camera permission is required for local face attention")

      val manager = context().getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val selected = selectCamera(manager)
        ?: throw IllegalStateException("No camera is available")

      cameraId = selected.first
      lensFacingName = selected.second
      val characteristics = manager.getCameraCharacteristics(selected.first)
      sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
      targetFpsRange = selectTargetFpsRange(characteristics)
      detector = createDetector()

      val thread = HandlerThread("my-looi-face-attention")
      thread.start()
      cameraThread = thread
      cameraHandler = Handler(thread.looper)
      lastAnalysisAtMs = 0L
      framesAnalyzed.set(0)

      val analysisSize = selectAnalysisSize(characteristics)
      val reader = ImageReader.newInstance(
        analysisSize.width,
        analysisSize.height,
        ImageFormat.YUV_420_888,
        2
      )
      imageReader = reader
      reader.setOnImageAvailableListener({ source ->
        val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
        analyze(image)
      }, cameraHandler)

      running = true
      try {
        manager.openCamera(selected.first, cameraStateCallback, cameraHandler)
      } catch (error: Throwable) {
        running = false
        stopCameraLocked()
        throw error
      }
      return status()
    }
  }

  private fun selectAnalysisSize(characteristics: CameraCharacteristics): Size {
    val sizes = characteristics
      .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
      ?.getOutputSizes(ImageFormat.YUV_420_888)
      ?.toList()
      .orEmpty()
    if (sizes.isEmpty()) return Size(ANALYSIS_WIDTH, ANALYSIS_HEIGHT)
    val targetArea = ANALYSIS_WIDTH * ANALYSIS_HEIGHT
    return sizes.minByOrNull { size -> abs(size.width * size.height - targetArea) } ?: sizes.first()
  }

  private fun selectCamera(manager: CameraManager): Pair<String, String>? {
    var fallback: Pair<String, String>? = null
    for (id in manager.cameraIdList) {
      val facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING)
      val name = when (facing) {
        CameraCharacteristics.LENS_FACING_FRONT -> "front"
        CameraCharacteristics.LENS_FACING_BACK -> "back"
        CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
        else -> "unknown"
      }
      if (fallback == null) fallback = id to name
      if (facing == CameraCharacteristics.LENS_FACING_FRONT) return id to name
    }
    return fallback
  }

  private val cameraStateCallback = object : CameraDevice.StateCallback() {
    override fun onOpened(camera: CameraDevice) {
      synchronized(lock) {
        if (!running) {
          camera.close()
          return
        }
        cameraDevice = camera
        createCaptureSession(camera)
      }
    }

    override fun onDisconnected(camera: CameraDevice) {
      camera.close()
      synchronized(lock) {
        if (cameraDevice === camera) cameraDevice = null
        running = false
      }
      emitError("camera-disconnected", "Camera disconnected")
    }

    override fun onError(camera: CameraDevice, error: Int) {
      camera.close()
      synchronized(lock) {
        if (cameraDevice === camera) cameraDevice = null
        running = false
      }
      emitError("camera-open", "Camera error $error")
    }
  }

  @Suppress("DEPRECATION")
  private fun createCaptureSession(camera: CameraDevice) {
    val reader = imageReader ?: return
    camera.createCaptureSession(
      listOf(reader.surface),
      object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(session: CameraCaptureSession) {
          synchronized(lock) {
            if (!running || cameraDevice !== camera) {
              session.close()
              return
            }
            captureSession = session
            try {
              val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(reader.surface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                targetFpsRange?.let { set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
              }.build()
              session.setRepeatingRequest(request, null, cameraHandler)
            } catch (error: Throwable) {
              emitError("capture-start", error.message ?: error.javaClass.simpleName)
            }
          }
        }

        override fun onConfigureFailed(session: CameraCaptureSession) {
          session.close()
          emitError("capture-configure", "Could not configure local face-attention capture")
        }
      },
      cameraHandler
    )
  }

  private fun analyze(image: Image) {
    if (!running) {
      image.close()
      return
    }

    val now = System.currentTimeMillis()
    if (now - lastAnalysisAtMs < MIN_ANALYSIS_INTERVAL_MS || !detectorBusy.compareAndSet(false, true)) {
      image.close()
      return
    }
    lastAnalysisAtMs = now

    val activeDetector = detector
    if (activeDetector == null) {
      detectorBusy.set(false)
      image.close()
      return
    }

    val rotation = imageRotationDegrees()
    val input = try {
      InputImage.fromMediaImage(image, rotation)
    } catch (error: Throwable) {
      detectorBusy.set(false)
      image.close()
      emitError("input-image", error.message ?: error.javaClass.simpleName)
      return
    }

    activeDetector.process(input)
      .addOnSuccessListener { faces ->
        framesAnalyzed.incrementAndGet()
        if (running) emitFaces(faces, image.width, image.height, rotation)
      }
      .addOnFailureListener { error ->
        emitError("face-detection", error.message ?: error.javaClass.simpleName)
      }
      .addOnCompleteListener {
        image.close()
        detectorBusy.set(false)
        synchronized(lock) {
          val pending = pendingDetectorClose
          pendingDetectorClose = null
          try { pending?.close() } catch (_: Throwable) {}
        }
      }
  }

  private fun emitFaces(faces: List<Face>, rawWidth: Int, rawHeight: Int, rotation: Int) {
    val rotated = rotation == 90 || rotation == 270
    val width = max(1, if (rotated) rawHeight else rawWidth).toFloat()
    val height = max(1, if (rotated) rawWidth else rawHeight).toFloat()
    val primary = faces.maxByOrNull { it.boundingBox.width().toLong() * it.boundingBox.height().toLong() }
    val normalized = primary?.let { face ->
      val rect = face.boundingBox
      val left = (rect.left / width).coerceIn(0f, 1f)
      val top = (rect.top / height).coerceIn(0f, 1f)
      val right = (rect.right / width).coerceIn(0f, 1f)
      val bottom = (rect.bottom / height).coerceIn(0f, 1f)
      mapOf(
        "left" to left,
        "top" to top,
        "right" to right,
        "bottom" to bottom,
        "centerX" to ((left + right) / 2f),
        "centerY" to ((top + bottom) / 2f),
        "width" to (right - left).coerceAtLeast(0f),
        "height" to (bottom - top).coerceAtLeast(0f)
      )
    }

    sendEvent("onFaceFrame", mapOf(
      "timestampMs" to System.currentTimeMillis(),
      "faceCount" to faces.size,
      "primary" to normalized
    ))
  }

  @Suppress("DEPRECATION")
  private fun imageRotationDegrees(): Int {
    val activity = appContext.currentActivity
    val displayRotation = activity?.windowManager?.defaultDisplay?.rotation ?: Surface.ROTATION_0
    val deviceDegrees = when (displayRotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
    return if (lensFacingName == "front") {
      (sensorOrientation + deviceDegrees) % 360
    } else {
      (sensorOrientation - deviceDegrees + 360) % 360
    }
  }

  private fun stopCamera() {
    synchronized(lock) {
      running = false
      stopCameraLocked()
    }
  }

  private fun stopCameraLocked() {
    try { captureSession?.stopRepeating() } catch (_: Throwable) {}
    try { captureSession?.abortCaptures() } catch (_: Throwable) {}
    try { captureSession?.close() } catch (_: Throwable) {}
    captureSession = null
    try { cameraDevice?.close() } catch (_: Throwable) {}
    cameraDevice = null
    try { imageReader?.close() } catch (_: Throwable) {}
    imageReader = null

    val thread = cameraThread
    cameraHandler = null
    cameraThread = null
    try { thread?.quitSafely() } catch (_: Throwable) {}

    val detectorToClose = detector
    detector = null
    if (detectorToClose != null) {
      if (detectorBusy.get() && pendingDetectorClose == null) {
        pendingDetectorClose = detectorToClose
      } else {
        try { detectorToClose.close() } catch (_: Throwable) {}
      }
    }
    targetFpsRange = null
    // Do not clear detectorBusy here: an in-flight ML Kit task still owns its Image.
    // Its completion listener is the only place that releases that image and gate,
    // then closes the detector that belonged to the stopped camera session.
  }

  private fun emitError(stage: String, message: String) {
    sendEvent("onFaceAttentionError", mapOf("stage" to stage, "message" to message))
  }

  private fun status(): Map<String, Any?> = mapOf(
    "supported" to true,
    "running" to running,
    "permissionGranted" to hasPermission(),
    "cameraId" to cameraId,
    "lensFacing" to lensFacingName,
    "framesAnalyzed" to framesAnalyzed.get(),
    "analysisWidth" to ANALYSIS_WIDTH,
    "analysisHeight" to ANALYSIS_HEIGHT,
    "targetFps" to targetFpsRange?.upper
  )

  companion object {
    private const val ANALYSIS_WIDTH = 640
    private const val ANALYSIS_HEIGHT = 480
    private const val MIN_ANALYSIS_INTERVAL_MS = 140L
  }
}
