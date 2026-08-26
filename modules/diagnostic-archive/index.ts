import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type DiagnosticArchiveResult = {
  outputUri: string;
  entries: number;
  uncompressedBytes: number;
};

declare class DiagnosticArchiveNativeModule extends NativeModule {
  createZip(sourceDirectoryUri: string, outputFileUri: string): Promise<DiagnosticArchiveResult>;
}

let cached: DiagnosticArchiveNativeModule | null = null;

function getModule(): DiagnosticArchiveNativeModule {
  if (Platform.OS !== "android") throw new Error("Diagnostic ZIP export is available on Android only");
  cached ??= requireNativeModule<DiagnosticArchiveNativeModule>("DiagnosticArchive");
  return cached;
}

export async function createDiagnosticZip(
  sourceDirectoryUri: string,
  outputFileUri: string
): Promise<DiagnosticArchiveResult> {
  return getModule().createZip(sourceDirectoryUri, outputFileUri);
}
