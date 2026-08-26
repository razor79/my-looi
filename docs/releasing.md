# Public release checklist

Before the first GitHub commit or any public release:

1. Run the source/privacy gate:

   ```bash
   node scripts/pnpm-lock-graph-audit.mjs
   pnpm test
   pnpm run motion:safety-test
   pnpm run ble:lifecycle-test
   pnpm run vosk:emergency-stop-test
   pnpm run motion:cliff-test
   pnpm run realtime:pcm-types-test
   ```

2. Review repository contents before committing:

   ```bash
   git status --short
   git ls-files
   git ls-files --others --exclude-standard
   ```

3. Confirm no local `.env`, diagnostics, logs, APK/AAB files, private notes, credentials, personal paths, device MAC addresses, or private images are present.

4. Build the Android release and require a real Gradle `BUILD SUCCESSFUL`.

5. Audit the exact APK intended for publication:

   ```bash
   bash scripts/public-apk-audit.sh output/android/my-looi-arm64.apk
   ```

6. Review `THIRD_PARTY_NOTICES.md` and the bundled dependency/model inventory. Do not redistribute an optional model unless its model-weight license is known to permit redistribution.

7. Publish source and binary artifacts only after both the source audit and APK audit pass.
