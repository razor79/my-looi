import * as FileSystem from "expo-file-system/legacy";
import { createDiagnosticZip } from "../../modules/diagnostic-archive";
import { buildDiagnosticLogText, recordDiagnosticEvent } from "./diagnostic-log";

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeCombinedDiagnosticExport(): Promise<string> {
  const cacheRoot = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!cacheRoot) throw new Error("Diagnostic export directory is unavailable");

  const exportId = `looi-diagnostics-${safeTimestamp()}`;
  const stagingRoot = `${cacheRoot}${exportId}/`;
  const outputUri = `${cacheRoot}${exportId}.zip`;

  await FileSystem.deleteAsync(stagingRoot, { idempotent: true }).catch(() => undefined);
  await FileSystem.makeDirectoryAsync(stagingRoot, { intermediates: true });
  await FileSystem.writeAsStringAsync(`${stagingRoot}looi-diagnostic.log`, buildDiagnosticLogText());
  await FileSystem.writeAsStringAsync(
    `${stagingRoot}README.txt`,
    [
      "LOOI diagnostic package",
      `exportedAt=${new Date().toISOString()}`,
      "",
      "looi-diagnostic.log: sanitized application diagnostic log.",
      "Local-ASR microphone WAV capture was retired in v2.1.105 and is no longer collected.",
      "API keys, tokens and passwords are not intentionally included.",
      "",
    ].join("\n")
  );

  try {
    const result = await createDiagnosticZip(stagingRoot, outputUri);
    recordDiagnosticEvent("diagnostic", "combined-export-created", {
      entries: result.entries,
      uncompressedBytes: result.uncompressedBytes,
      microphoneAudioIncluded: false,
    });
    return result.outputUri;
  } finally {
    await FileSystem.deleteAsync(stagingRoot, { idempotent: true }).catch(() => undefined);
  }
}
