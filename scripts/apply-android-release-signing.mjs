import { readFileSync, writeFileSync } from "node:fs";

const buildGradle = process.argv[2];
if (!buildGradle) {
  throw new Error("Usage: node scripts/apply-android-release-signing.mjs <android/app/build.gradle>");
}

const marker = "// MY_LOOI_RELEASE_SIGNING_V1";
const source = readFileSync(buildGradle, "utf8");
if (source.includes(marker)) {
  console.log("My LOOI release signing is already configured in generated Gradle file.");
  process.exit(0);
}

const snippet = `

${marker}
def myLooiReleaseKeystore = System.getenv("MY_LOOI_RELEASE_KEYSTORE")
def myLooiReleaseStorePassword = System.getenv("MY_LOOI_RELEASE_STORE_PASSWORD")
def myLooiReleaseKeyAlias = System.getenv("MY_LOOI_RELEASE_KEY_ALIAS")
def myLooiReleaseKeyPassword = System.getenv("MY_LOOI_RELEASE_KEY_PASSWORD")

if (!myLooiReleaseKeystore || !myLooiReleaseStorePassword || !myLooiReleaseKeyAlias || !myLooiReleaseKeyPassword) {
    throw new GradleException("My LOOI release signing environment is incomplete")
}

android {
    signingConfigs {
        myLooiRelease {
            storeFile file(myLooiReleaseKeystore)
            storePassword myLooiReleaseStorePassword
            keyAlias myLooiReleaseKeyAlias
            keyPassword myLooiReleaseKeyPassword
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.myLooiRelease
        }
    }
}
`;

writeFileSync(buildGradle, source.replace(/\s*$/, "") + snippet + "\n");
console.log("Configured generated Android release build to use the persistent My LOOI signing key.");
