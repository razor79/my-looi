package com.superlooi.backupstorageaccess

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.ByteArrayOutputStream

class BackupStorageAccessModule : Module() {
  private var pendingFolderPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("BackupStorageAccess")

    AsyncFunction("selectFolder") { promise: Promise ->
      if (pendingFolderPromise != null) {
        promise.reject("ERR_STORAGE_BUSY", "Another folder picker is already active", null)
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_STORAGE_ACTIVITY", "Folder selection requires an active Android activity", null)
        return@AsyncFunction
      }

      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
      }
      pendingFolderPromise = promise
      try {
        activity.startActivityForResult(intent, FOLDER_REQUEST_CODE)
      } catch (error: Exception) {
        pendingFolderPromise = null
        promise.reject("ERR_STORAGE_PICKER", error.message, error)
      }
    }

    AsyncFunction("inspectFolder") Coroutine { treeUri: String ->
      inspectFolder(Uri.parse(requireTreeUri(treeUri)))
    }

    AsyncFunction("inspectFile") Coroutine { treeUri: String, fileName: String ->
      val tree = Uri.parse(requireTreeUri(treeUri))
      findChild(tree, requireFileName(fileName))?.let { queryFileMetadata(it.uri, it.name) }
    }

    AsyncFunction("writeTextFile") Coroutine { treeUri: String, fileName: String, content: String ->
      val tree = Uri.parse(requireTreeUri(treeUri))
      ensurePersistedPermission(tree, requireWrite = true)
      val safeName = requireFileName(fileName)
      val resolver = requireResolver()
      val existing = findChild(tree, safeName)
      val target = existing?.uri ?: DocumentsContract.createDocument(
        resolver,
        rootDocumentUri(tree),
        "application/json",
        safeName
      ) ?: throw IllegalStateException("Selected storage provider could not create the backup file")

      val bytes = content.toByteArray(Charsets.UTF_8)
      resolver.openOutputStream(target, "rwt")?.use { stream ->
        stream.write(bytes)
        stream.flush()
      } ?: throw IllegalStateException("Selected storage provider could not open the backup file for writing")

      queryFileMetadata(target, safeName).toMutableMap().apply {
        this["size"] = bytes.size.toDouble()
      }
    }

    AsyncFunction("writePrivateFile") Coroutine { treeUri: String, fileName: String, mimeType: String, sourceFileUri: String ->
      val tree = Uri.parse(requireTreeUri(treeUri))
      ensurePersistedPermission(tree, requireWrite = true)
      val safeName = requireFileName(fileName)
      val safeMime = mimeType.trim().ifEmpty { "application/octet-stream" }
      require(safeMime.length <= 120 && !safeMime.any { it.isWhitespace() }) { "Invalid MIME type" }
      val source = requirePrivateFile(sourceFileUri)
      val resolver = requireResolver()
      val existing = findChild(tree, safeName)
      val target = existing?.uri ?: DocumentsContract.createDocument(
        resolver,
        rootDocumentUri(tree),
        safeMime,
        safeName
      ) ?: throw IllegalStateException("Selected storage provider could not create the file")

      var bytes = 0L
      resolver.openOutputStream(target, "rwt")?.use { output ->
        BufferedInputStream(FileInputStream(source)).use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (read == 0) continue
            output.write(buffer, 0, read)
            bytes += read.toLong()
          }
        }
        output.flush()
      } ?: throw IllegalStateException("Selected storage provider could not open the file for writing")

      queryFileMetadata(target, safeName).toMutableMap().apply {
        this["size"] = bytes.toDouble()
      }
    }

    AsyncFunction("readTextFile") Coroutine { treeUri: String, fileName: String, maxBytes: Int ->
      val tree = Uri.parse(requireTreeUri(treeUri))
      ensurePersistedPermission(tree, requireWrite = false)
      val safeName = requireFileName(fileName)
      require(maxBytes in 1..MAX_NATIVE_READ_BYTES) { "maxBytes is outside the supported range" }
      val child = findChild(tree, safeName)
        ?: throw IllegalStateException("Backup file not found in the selected folder")
      val resolver = requireResolver()
      val output = ByteArrayOutputStream()
      resolver.openInputStream(child.uri)?.use { stream ->
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
          val read = stream.read(buffer)
          if (read < 0) break
          total += read
          if (total > maxBytes) {
            throw IllegalStateException("Backup file exceeds the allowed size")
          }
          output.write(buffer, 0, read)
        }
      } ?: throw IllegalStateException("Selected storage provider could not open the backup file for reading")
      val bytes = output.toByteArray()
      mapOf(
        "file" to queryFileMetadata(child.uri, child.name),
        "content" to bytes.toString(Charsets.UTF_8),
        "bytes" to bytes.size
      )
    }

    AsyncFunction("releaseFolder") Coroutine { treeUri: String ->
      val uri = Uri.parse(requireTreeUri(treeUri))
      try {
        requireResolver().releasePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
      } catch (_: SecurityException) {
        // The grant may already have been removed by Android/provider settings.
      }
    }

    OnActivityResult { activity, payload ->
      if (payload.requestCode != FOLDER_REQUEST_CODE) return@OnActivityResult
      val promise = pendingFolderPromise ?: return@OnActivityResult
      pendingFolderPromise = null

      val data = payload.data
      val uri = data?.data
      if (payload.resultCode != Activity.RESULT_OK || uri == null) {
        promise.reject("ERR_STORAGE_CANCELLED", "Folder selection was cancelled", null)
        return@OnActivityResult
      }

      try {
        val persistableFlags = data.flags and (
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
        val hasRead = persistableFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0
        val hasWrite = persistableFlags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0
        if (!hasRead || !hasWrite) {
          promise.reject(
            "ERR_STORAGE_PERMISSION",
            "Selected folder did not grant persistent read/write access",
            null
          )
          return@OnActivityResult
        }
        activity.contentResolver.takePersistableUriPermission(uri, persistableFlags)
        promise.resolve(inspectFolder(uri))
      } catch (error: Exception) {
        promise.reject("ERR_STORAGE_PERMISSION", error.message, error)
      }
    }

    OnActivityDestroys {
      pendingFolderPromise?.reject(
        "ERR_STORAGE_ACTIVITY_DESTROYED",
        "Android activity was destroyed while selecting a backup folder",
        null
      )
      pendingFolderPromise = null
    }
  }

  private data class ChildDocument(
    val uri: Uri,
    val name: String
  )

  private fun requireResolver(): ContentResolver =
    appContext.reactContext?.contentResolver
      ?: throw IllegalStateException("Android ContentResolver is unavailable")

  private fun requireTreeUri(value: String): String {
    val trimmed = value.trim()
    require(trimmed.startsWith("content://")) { "A valid Android document-tree URI is required" }
    return trimmed
  }

  private fun requireFileName(value: String): String {
    val trimmed = value.trim()
    require(trimmed.isNotEmpty()) { "Backup file name is required" }
    require(trimmed.length <= 160) { "Backup file name is too long" }
    require(!trimmed.contains('/') && !trimmed.contains('\\')) { "Backup file name must not contain path separators" }
    return trimmed
  }

  private fun requirePrivateFile(value: String): File {
    val uri = Uri.parse(value)
    val file = when (uri.scheme) {
      null, "" -> File(value)
      "file" -> File(uri.path ?: throw IllegalArgumentException("Invalid private file URI"))
      else -> throw IllegalArgumentException("Only private file:// sources are supported")
    }.canonicalFile
    val context = appContext.reactContext
      ?: throw IllegalStateException("Android application context is unavailable")
    val roots = listOf(context.cacheDir.canonicalFile, context.filesDir.canonicalFile)
    require(roots.any { root -> file.path == root.path || file.path.startsWith(root.path + File.separator) }) {
      "Only My LOOI private cache/files can be copied to external storage"
    }
    require(file.isFile) { "Private source file does not exist" }
    return file
  }

  private fun rootDocumentUri(treeUri: Uri): Uri = DocumentsContract.buildDocumentUriUsingTree(
    treeUri,
    DocumentsContract.getTreeDocumentId(treeUri)
  )

  private fun ensurePersistedPermission(treeUri: Uri, requireWrite: Boolean) {
    val permission = requireResolver().persistedUriPermissions.firstOrNull { it.uri == treeUri }
      ?: throw SecurityException("Access to the selected backup folder is no longer available. Select the folder again.")
    if (!permission.isReadPermission || (requireWrite && !permission.isWritePermission)) {
      throw SecurityException("The selected backup folder no longer has the required read/write permission. Select it again.")
    }
  }

  private fun inspectFolder(treeUri: Uri): Map<String, Any?> {
    ensurePersistedPermission(treeUri, requireWrite = false)
    val resolver = requireResolver()
    val displayName = queryDisplayName(rootDocumentUri(treeUri))
    val authority = treeUri.authority
    val packageManager = appContext.reactContext?.packageManager
    val providerName = if (authority != null && packageManager != null) {
      packageManager.resolveContentProvider(authority, 0)?.loadLabel(packageManager)?.toString()
    } else null
    val permission = resolver.persistedUriPermissions.firstOrNull { it.uri == treeUri }
    return mapOf(
      "uri" to treeUri.toString(),
      "displayName" to displayName,
      "providerName" to providerName,
      "canRead" to (permission?.isReadPermission == true),
      "canWrite" to (permission?.isWritePermission == true)
    )
  }

  private fun queryDisplayName(documentUri: Uri): String? {
    val resolver = requireResolver()
    resolver.query(
      documentUri,
      arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
      null,
      null,
      null
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        val index = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        if (index >= 0 && !cursor.isNull(index)) return cursor.getString(index)
      }
    }
    return null
  }

  private fun findChild(treeUri: Uri, fileName: String): ChildDocument? {
    val resolver = requireResolver()
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
      treeUri,
      DocumentsContract.getTreeDocumentId(treeUri)
    )
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE
    )
    resolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
      val idIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      val mimeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
      while (cursor.moveToNext()) {
        if (idIndex < 0 || nameIndex < 0) continue
        val name = cursor.getString(nameIndex) ?: continue
        val mime = if (mimeIndex >= 0 && !cursor.isNull(mimeIndex)) cursor.getString(mimeIndex) else null
        if (name == fileName && mime != DocumentsContract.Document.MIME_TYPE_DIR) {
          val documentId = cursor.getString(idIndex) ?: continue
          return ChildDocument(
            DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId),
            name
          )
        }
      }
    }
    return null
  }

  private fun queryFileMetadata(uri: Uri, fallbackName: String): Map<String, Any?> {
    val resolver = requireResolver()
    var name = fallbackName
    var modifiedTime: Long? = null
    var size: Long? = null
    resolver.query(
      uri,
      arrayOf(
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_SIZE
      ),
      null,
      null,
      null
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val modifiedIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        val sizeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
        if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) modifiedTime = cursor.getLong(modifiedIndex)
        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
      }
    }
    return mapOf(
      "uri" to uri.toString(),
      "name" to name,
      "modifiedTime" to modifiedTime?.toDouble(),
      "size" to size?.toDouble()
    )
  }

  companion object {
    private const val FOLDER_REQUEST_CODE = 0x4C42
    private const val MAX_NATIVE_READ_BYTES = 32 * 1024 * 1024
  }
}
