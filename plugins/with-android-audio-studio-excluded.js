const ANDROID_EXCLUDED_MODULES = ["@siteed/audio-studio"];

function appendUnique(existing, values) {
  const merged = [...(Array.isArray(existing) ? existing : [])];
  for (const value of values) {
    if (!merged.includes(value)) {
      merged.push(value);
    }
  }
  return merged;
}

module.exports = function withAndroidAudioStudioExcluded(config) {
  config.autolinking = {
    ...(config.autolinking || {}),
    android: {
      ...(config.autolinking?.android || {}),
      exclude: appendUnique(config.autolinking?.android?.exclude, ANDROID_EXCLUDED_MODULES),
    },
  };

  return config;
};
