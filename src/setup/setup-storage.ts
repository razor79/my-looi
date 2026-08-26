import { createMMKV } from "react-native-mmkv";

export type OptionalSetupCapability = "robot";

export type SetupSkipState = Record<OptionalSetupCapability, boolean>;

type SetupStoragePayload = {
  version: 2;
  onboardingCompleted: boolean;
  skipped: SetupSkipState;
  updatedAt: string;
};

const SETUP_STORAGE_KEY = "looi.setup.v1";
const setupStorage = createMMKV({ id: "looi.setup" });

const defaultSetupState: SetupStoragePayload = {
  version: 2,
  onboardingCompleted: false,
  skipped: { robot: false },
  updatedAt: new Date(0).toISOString(),
};

export function getSetupStorageState(): SetupStoragePayload {
  const raw = setupStorage.getString(SETUP_STORAGE_KEY);
  if (!raw) return defaultSetupState;

  try {
    const parsed = JSON.parse(raw) as {
      onboardingCompleted?: unknown;
      skipped?: Record<string, unknown>;
      updatedAt?: unknown;
    };
    const migrated: SetupStoragePayload = {
      version: 2,
      onboardingCompleted: Boolean(parsed.onboardingCompleted),
      skipped: { robot: Boolean(parsed.skipped?.robot) },
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaultSetupState.updatedAt,
    };
    if (parsed.skipped?.camera !== undefined || parsed.skipped?.calendar !== undefined) {
      setupStorage.set(SETUP_STORAGE_KEY, JSON.stringify(migrated));
    }
    return migrated;
  } catch {
    setupStorage.remove(SETUP_STORAGE_KEY);
    return defaultSetupState;
  }
}

export function setOptionalCapabilitySkipped(
  capability: OptionalSetupCapability,
  skipped: boolean
): SetupStoragePayload {
  const state = getSetupStorageState();
  const next: SetupStoragePayload = {
    ...state,
    skipped: { ...state.skipped, [capability]: skipped },
    updatedAt: new Date().toISOString(),
  };
  setupStorage.set(SETUP_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function setOnboardingCompleted(completed: boolean): SetupStoragePayload {
  const state = getSetupStorageState();
  const next: SetupStoragePayload = {
    ...state,
    onboardingCompleted: completed,
    updatedAt: new Date().toISOString(),
  };
  setupStorage.set(SETUP_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function resetSetupStorage(): void {
  setupStorage.remove(SETUP_STORAGE_KEY);
}
