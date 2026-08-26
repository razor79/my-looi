const {
  AndroidConfig,
  withAndroidManifest,
  withGradleProperties,
  withInfoPlist,
} = require("expo/config-plugins");

const ANDROID_PERMISSIONS = [
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.INTERNET",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.RECORD_AUDIO",
  "android.permission.WAKE_LOCK",
];

function upsertGradleProperty(properties, key, value) {
  const existing = properties.find(
    (item) => item.type === "property" && item.key === key
  );
  if (existing) {
    existing.value = value;
  } else {
    properties.push({ type: "property", key, value });
  }
}

module.exports = function withReactNativeWebRtc(config) {
  config = withAndroidManifest(config, (androidConfig) => {
    for (const permission of ANDROID_PERMISSIONS) {
      AndroidConfig.Permissions.addPermission(
        androidConfig.modResults,
        permission
      );
    }
    return androidConfig;
  });

  config = withGradleProperties(config, (androidConfig) => {
    upsertGradleProperty(
      androidConfig.modResults,
      "android.minSdkVersion",
      "24"
    );

    // Physical target builds are 64-bit ARM only. Avoid compiling legacy
    // armeabi-v7a and emulator-only x86/x86_64 native trees on the PN50.
    upsertGradleProperty(
      androidConfig.modResults,
      "reactNativeArchitectures",
      "arm64-v8a"
    );
    return androidConfig;
  });

  // v2.1.74 intentionally does not install a custom WebRTC audio device module.
  // react-native-webrtc therefore creates its own default Android communication
  // capture/output path and applies its platform/WebRTC default AEC/NS policy.
  // This is a controlled A/B after the previous media-output/custom-recorder
  // experiments caused severe self-echo on the target phone.

  config = withInfoPlist(config, (iosConfig) => {
    iosConfig.modResults.NSMicrophoneUsageDescription ??=
      "Allow Looi to use the microphone for Realtime conversation";
    return iosConfig;
  });

  return config;
};

module.exports._test = {
  upsertGradleProperty,
};
