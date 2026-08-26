import fs from "node:fs";
import assert from "node:assert/strict";

const db = fs.readFileSync("src/memory/local-memory-database.ts", "utf8");
const service = fs.readFileSync("src/backup/local-memory-backup-storage.ts", "utf8");
const settings = fs.readFileSync("src/backup/backup-storage-settings.ts", "utf8");
const native = fs.readFileSync(
  "modules/backup-storage-access/android/src/main/java/com/superlooi/backupstorageaccess/BackupStorageAccessModule.kt",
  "utf8"
);
const gradle = fs.readFileSync("modules/backup-storage-access/android/build.gradle", "utf8");
const ui = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");
const rootPackage = fs.readFileSync("package.json", "utf8");
const modulePackage = fs.readFileSync("modules/backup-storage-access/package.json", "utf8");
const moduleConfig = fs.readFileSync("modules/backup-storage-access/expo-module.config.json", "utf8");
const manifest = fs.readFileSync("modules/backup-storage-access/android/src/main/AndroidManifest.xml", "utf8");

assert.match(db, /withExclusiveTransactionAsync/);
assert.match(db, /DELETE FROM conversation_messages/);
assert.match(db, /DELETE FROM conversation_sessions/);
assert.match(db, /DELETE FROM memories/);
assert.match(db, /validateLocalMemoryBackup/);
assert.match(db, /BACKUP_PROFILE_BLOCKED_KEY/);

assert.match(service, /super-looi-memory-backup-v1\.json/);
assert.match(service, /exportLocalMemoryBackup/);
assert.match(service, /restoreLocalMemoryBackup/);
assert.match(service, /BackupStorageAccess\.selectFolder/);
assert.match(service, /BackupStorageAccess\.writeTextFile/);
assert.match(service, /BackupStorageAccess\.readTextFile/);
assert.doesNotMatch(service, /oauth|access.?token|drive\.appdata|googleapis/i);
assert.doesNotMatch(settings, /oauth|access.?token|client.?id/i);

assert.match(native, /Intent\.ACTION_OPEN_DOCUMENT_TREE/);
assert.match(native, /FLAG_GRANT_PERSISTABLE_URI_PERMISSION/);
assert.match(native, /takePersistableUriPermission/);
assert.match(native, /persistedUriPermissions/);
assert.match(native, /DocumentsContract\.createDocument/);
assert.match(native, /buildChildDocumentsUriUsingTree/);
assert.match(native, /openOutputStream\(target, "rwt"\)/);
assert.match(native, /AsyncFunction\("writeTextFile"\) Coroutine/);
assert.match(native, /AsyncFunction\("readTextFile"\) Coroutine/);
assert.doesNotMatch(native, /CredentialManager|AuthorizationClient|GoogleId|drive\.appdata/);
assert.doesNotMatch(gradle, /credentials|googleid|play-services-auth/i);
assert.match(gradle, /built-in Storage Access Framework only/);

assert.match(rootPackage, /"nativeModulesDir": "\.\/modules"/);
assert.match(rootPackage, /backup-storage-access-foundation\.test\.mjs/);
assert.match(modulePackage, /"peerDependencies"/);
assert.match(modulePackage, /"expo": "\*"/);
assert.match(moduleConfig, /com\.superlooi\.backupstorageaccess\.BackupStorageAccessModule/);
assert.match(manifest, /<manifest/);
assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);

assert.match(ui, /Память и backup/);
assert.match(ui, /Выбрать папку/);
assert.match(ui, /restoreLocalMemoryFromSelectedFolder/);
assert.doesNotMatch(ui, /Google Web OAuth Client ID|Войти через Google|appDataFolder/);

assert.equal(fs.existsSync("modules/google-account-auth"), false, "legacy Google OAuth native module must be removed");
assert.equal(fs.existsSync("src/google"), false, "legacy Google Drive API service must be removed");

console.log("Android SAF backup storage foundation behavior: PASS");
