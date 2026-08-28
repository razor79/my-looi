package com.superlooi.appupdateinstaller

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.Locale

class AppUpdateInstallerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppUpdateInstaller")

    AsyncFunction("canRequestPackageInstalls") Coroutine ::canRequestInstalls

    AsyncFunction("openInstallPermissionSettings") {
      val context = requireContext()
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}")
        )
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    }

    AsyncFunction("verifyUpdateApk") Coroutine { fileUri: String, expectedSha256: String ->
      verifyUpdateApk(fileUri, expectedSha256)
    }

    AsyncFunction("installVerifiedUpdateApk") Coroutine { fileUri: String, expectedSha256: String ->
      val verified = verifyUpdateApk(fileUri, expectedSha256)
      if (!canRequestInstalls()) {
        throw SecurityException(
          "Android is not currently allowing My LOOI to request package installs. " +
            "Temporarily allow app installs for this device/source, then try again."
        )
      }

      val context = requireContext()
      val file = requirePrivateUpdateApk(fileUri)
      val contentUri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.mylooi.updateprovider",
        file
      )
      val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
        data = contentUri
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      verified
    }
  }

  private fun canRequestInstalls(): Boolean {
    val packageManager = requireContext().packageManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      packageManager.canRequestPackageInstalls()
    } else {
      true
    }
  }

  private fun verifyUpdateApk(fileUri: String, expectedSha256: String): Map<String, Any?> {
    val context = requireContext()
    val file = requirePrivateUpdateApk(fileUri)
    val expected = expectedSha256.trim().lowercase(Locale.US)
    require(SHA256_REGEX.matches(expected)) { "Expected update SHA-256 is invalid" }

    val actual = sha256(file)
    require(actual == expected) { "Downloaded APK SHA-256 does not match the GitHub release" }

    val packageManager = context.packageManager
    val archiveInfo = getArchivePackageInfo(packageManager, file)
      ?: throw IllegalArgumentException("Downloaded file is not a readable Android APK")
    val installedInfo = getInstalledPackageInfo(packageManager, context.packageName)

    require(archiveInfo.packageName == context.packageName) {
      "Downloaded APK package does not match the installed My LOOI application"
    }

    val installedVersionCode = longVersionCode(installedInfo)
    val archiveVersionCode = longVersionCode(archiveInfo)
    require(archiveVersionCode > installedVersionCode) {
      "Downloaded APK is not newer than the installed My LOOI version"
    }

    val installedSigners = signerFingerprints(installedInfo)
    val archiveSigners = signerFingerprints(archiveInfo)
    require(installedSigners.isNotEmpty() && archiveSigners.isNotEmpty()) {
      "Unable to verify the APK signing certificate"
    }
    require(archiveSigners == installedSigners) {
      "Downloaded APK is signed with a different certificate and cannot safely update this installation"
    }

    return mapOf(
      "packageName" to archiveInfo.packageName,
      "versionName" to archiveInfo.versionName,
      "versionCode" to archiveVersionCode.toDouble(),
      "installedVersionCode" to installedVersionCode.toDouble(),
      "sha256" to actual,
      "signerSha256" to archiveSigners.sorted().first()
    )
  }

  private fun requireContext() = appContext.reactContext
    ?: throw IllegalStateException("Android application context is unavailable")

  private fun requirePrivateUpdateApk(value: String): File {
    val uri = Uri.parse(value)
    val file = when (uri.scheme) {
      null, "" -> File(value)
      "file" -> File(uri.path ?: throw IllegalArgumentException("Invalid APK file URI"))
      else -> throw IllegalArgumentException("Only a private file:// APK can be installed")
    }.canonicalFile

    val cacheRoot = requireContext().cacheDir.canonicalFile
    val updatesRoot = File(cacheRoot, "updates").canonicalFile
    require(file.path.startsWith(updatesRoot.path + File.separator)) {
      "Update APK must be stored inside My LOOI's private update cache"
    }
    require(file.isFile && file.extension.equals("apk", ignoreCase = true)) {
      "Downloaded update APK is missing"
    }
    return file
  }

  @Suppress("DEPRECATION")
  private fun getArchivePackageInfo(packageManager: PackageManager, file: File): PackageInfo? {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }
    return packageManager.getPackageArchiveInfo(file.absolutePath, flags)
  }

  @Suppress("DEPRECATION")
  private fun getInstalledPackageInfo(packageManager: PackageManager, packageName: String): PackageInfo {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }
    return packageManager.getPackageInfo(packageName, flags)
  }

  @Suppress("DEPRECATION")
  private fun signerFingerprints(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val signingInfo = info.signingInfo ?: return emptySet()
      if (signingInfo.hasMultipleSigners()) signingInfo.apkContentsSigners else signingInfo.signingCertificateHistory
    } else {
      info.signatures ?: emptyArray()
    }
    return signatures.map { signature -> sha256(signature.toByteArray()) }.toSet()
  }

  @Suppress("DEPRECATION")
  private fun longVersionCode(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        if (read > 0) digest.update(buffer, 0, read)
      }
    }
    return digest.digest().toHex()
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

  private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }

  companion object {
    private val SHA256_REGEX = Regex("^[0-9a-f]{64}$")
  }
}
