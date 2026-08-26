# Robot BLE integration

The Android app uses `react-native-ble-plx` through Expo config plugins. Native permission/configuration changes should be made through `app.json` or config plugins rather than generated prebuild output.

Settings provides manual robot discovery. After a successful selection, the saved device is reused for foreground reconnects.

Useful development overrides:

- `EXPO_PUBLIC_LOOI_DISABLE_ROBOT_AUTOCONNECT=1` disables saved reconnect attempts.
- `EXPO_PUBLIC_LOOI_ROBOT_NAME=<name>` overrides the advertised-name filter.

The local robot protocol implementation is in `src/device-tools/` and `packages/looi-sdk/`.
