package com.superlooi.diagnosticarchive

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class DiagnosticArchiveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DiagnosticArchive")

    AsyncFunction("createZip") { sourceDirectoryUri: String, outputFileUri: String ->
      createZip(sourceDirectoryUri, outputFileUri)
    }
  }

  private fun createZip(sourceDirectoryUri: String, outputFileUri: String): Map<String, Any?> {
    val sourceDirectory = fileFromUri(sourceDirectoryUri)
    val outputFile = fileFromUri(outputFileUri)
    if (!sourceDirectory.exists() || !sourceDirectory.isDirectory) {
      throw IllegalArgumentException("Diagnostic source directory does not exist: ${sourceDirectory.path}")
    }

    val sourceCanonical = sourceDirectory.canonicalFile
    val outputCanonical = outputFile.canonicalFile
    if (outputCanonical.path.startsWith(sourceCanonical.path + File.separator)) {
      throw IllegalArgumentException("Diagnostic ZIP output must be outside the source directory")
    }

    outputCanonical.parentFile?.mkdirs()
    if (outputCanonical.exists() && !outputCanonical.delete()) {
      throw IllegalStateException("Unable to replace diagnostic ZIP: ${outputCanonical.path}")
    }

    var entries = 0
    var uncompressedBytes = 0L
    ZipOutputStream(BufferedOutputStream(FileOutputStream(outputCanonical))).use { zip ->
      sourceCanonical.walkTopDown()
        .filter { it.isFile }
        .sortedBy { it.relativeTo(sourceCanonical).invariantSeparatorsPath }
        .forEach { file ->
          val relative = file.relativeTo(sourceCanonical).invariantSeparatorsPath
          zip.putNextEntry(ZipEntry(relative))
          BufferedInputStream(FileInputStream(file)).use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              if (read == 0) continue
              zip.write(buffer, 0, read)
              uncompressedBytes += read.toLong()
            }
          }
          zip.closeEntry()
          entries += 1
        }
    }

    return mapOf(
      "outputUri" to outputFileUri,
      "entries" to entries,
      "uncompressedBytes" to uncompressedBytes
    )
  }

  private fun fileFromUri(value: String): File {
    val uri = Uri.parse(value)
    return when (uri.scheme) {
      null, "" -> File(value)
      "file" -> File(uri.path ?: throw IllegalArgumentException("Invalid file URI: $value"))
      else -> throw IllegalArgumentException("Only file:// diagnostic paths are supported: $value")
    }
  }
}
