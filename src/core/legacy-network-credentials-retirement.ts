import * as SecureStore from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";

const LEGACY_SERVER_URL_KEY = "looi.server-url.v1";
const LEGACY_API_TOKEN_KEY = "looi.api-token.v1";
const legacyServerStorage = createMMKV({ id: "looi.server-config" });
let retired = false;

/**
 * One-way local migration for installs that predate the local-first runtime.
 * No legacy server module is imported and no network request is possible.
 */
export async function retireLegacyNetworkCredentials(): Promise<void> {
  if (retired) return;
  retired = true;
  const hadUrl = Boolean(legacyServerStorage.getString(LEGACY_SERVER_URL_KEY));
  legacyServerStorage.remove(LEGACY_SERVER_URL_KEY);
  await SecureStore.deleteItemAsync(LEGACY_API_TOKEN_KEY).catch(() => undefined);
  recordDiagnosticEvent("app", "legacy-network-credentials-retired", { hadUrl });
}
