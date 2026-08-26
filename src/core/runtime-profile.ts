import { Platform } from "react-native";

export type RuntimeProfile = {
  isAndroidEmulator: boolean;
  allowsWakewordAutostart: boolean;
};

export function getRuntimeProfile(): RuntimeProfile {
  const isEmulator = isAndroidEmulator();
  const forceWakeword = process.env.EXPO_PUBLIC_LOOI_ENABLE_EMULATOR_WAKEWORD === "1";
  const disableWakeword = process.env.EXPO_PUBLIC_LOOI_DISABLE_WAKEWORD_AUTOSTART === "1";

  return {
    isAndroidEmulator: isEmulator,
    allowsWakewordAutostart: !disableWakeword && (!isEmulator || forceWakeword),
  };
}

export function isAndroidEmulator(): boolean {
  if (Platform.OS !== "android") return false;

  const constants = Platform.constants as Record<string, unknown>;
  const values = [
    constants.Brand,
    constants.Fingerprint,
    constants.Manufacturer,
    constants.Model,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return values.some((value) =>
    ["emulator", "generic", "goldfish", "ranchu", "sdk_gphone"].some((needle) =>
      value.includes(needle)
    )
  );
}
