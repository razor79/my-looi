const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const MODEL_DIRS = ["vosk-command-ru", "vosk-command-uk", "vosk-command-en"];

module.exports = function withVoskCommandModels(config) {
  return withDangerousMod(config, [
    "android",
    async (androidConfig) => {
      const projectRoot = androidConfig.modRequest.projectRoot;
      const androidRoot = androidConfig.modRequest.platformProjectRoot;
      const sourceRoot = path.join(projectRoot, ".build-assets", "vosk");
      const assetsRoot = path.join(androidRoot, "app", "src", "main", "assets");
      fs.mkdirSync(assetsRoot, { recursive: true });

      for (const modelDir of MODEL_DIRS) {
        const source = path.join(sourceRoot, modelDir);
        const destination = path.join(assetsRoot, modelDir);
        if (!fs.existsSync(source)) {
          throw new Error(
            `Missing Vosk command model ${modelDir}. Run scripts/download-vosk-command-models.sh before expo prebuild.`
          );
        }
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(source, destination, { recursive: true, dereference: true });
      }

      return androidConfig;
    },
  ]);
};
