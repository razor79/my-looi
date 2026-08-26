import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import {
  DEFAULT_VAD_MODEL_DIR,
  DEFAULT_VAD_MODEL_FILE,
  resolveSherpaModelDir,
} from "./sherpa-models";

const BUNDLED_VAD_MODEL = require("@/assets/models/sherpa-onnx/vad/silero_vad.onnx");

async function fileReady(uri: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  return Boolean(info.exists && (info.size ?? 0) > 0);
}

async function ensureDir(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }
}

async function installBundledAsset(assetModule: number, destination: string): Promise<boolean> {
  if (await fileReady(destination)) return false;

  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync();
  const source = asset.localUri ?? asset.uri;
  if (!source) {
    throw new Error(`Bundled model asset is unavailable: ${destination}`);
  }

  await ensureDir(destination.slice(0, destination.lastIndexOf("/") + 1));
  await FileSystem.copyAsync({ from: source, to: destination });
  return true;
}

export async function installBundledSherpaModels(): Promise<{ vadInstalled: boolean }> {
  const vadDir = resolveSherpaModelDir(
    process.env.EXPO_PUBLIC_SHERPA_VAD_MODEL_DIR || DEFAULT_VAD_MODEL_DIR
  );
  const vadFile = process.env.EXPO_PUBLIC_SHERPA_VAD_MODEL_FILE || DEFAULT_VAD_MODEL_FILE;

  return {
    vadInstalled: await installBundledAsset(BUNDLED_VAD_MODEL, `${vadDir}${vadFile}`),
  };
}
