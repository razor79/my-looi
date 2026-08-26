import { PermissionsAndroid, Platform } from "react-native";
import {
  BleManager,
  ScanMode,
  State,
  type Device,
  type Subscription,
} from "react-native-ble-plx";
import {
  bytesToHex,
  hexToBytes,
  type LooiTransport,
  type LooiWriteOptions,
} from "@sourcebug/looi-sdk";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";

type LooiCharacteristicKey = Parameters<LooiTransport["write"]>[0];
type LooiNotificationHandler = NonNullable<
  Parameters<NonNullable<LooiTransport["startNotifications"]>>[1]
>;

const LOOI_SERVICE_UUID = "000000ff-0000-1000-8000-00805f9b34fb";
const DEFAULT_ROBOT_NAME = "LOOI Robot";
const DEFAULT_SCAN_TIMEOUT_MS = 12_000;
const DEFAULT_BLE_STATE_TIMEOUT_MS = 8_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const CHARACTERISTIC_UUIDS: Record<LooiCharacteristicKey, string> = {
  drive: "0000fed0-0000-1000-8000-00805f9b34fb",
  head: "0000fed1-0000-1000-8000-00805f9b34fb",
  light: "0000fed2-0000-1000-8000-00805f9b34fb",
  dockNotify: "0000fed9-0000-1000-8000-00805f9b34fb",
  handshakeControl: "0000feda-0000-1000-8000-00805f9b34fb",
  handshakeData: "0000fef0-0000-1000-8000-00805f9b34fb",
  rawFe00: "0000fe00-0000-1000-8000-00805f9b34fb",
};

export type ReactNativeBleLooiTransportOptions = {
  manager?: BleManager;
  deviceId?: string;
  robotName?: string;
  scanTimeoutMs?: number;
  bleStateTimeoutMs?: number;
  connectTimeoutMs?: number;
  onDisconnected?: (error?: Error) => void;
};

export type ScannedLooiRobot = {
  id: string;
  name: string;
  rssi: number | null;
  serviceUUIDs: string[];
};

type ResolvedCharacteristic = {
  serviceUuid: string;
  characteristicUuid: string;
  writableWithResponse: boolean;
  writableWithoutResponse: boolean;
  notifiable: boolean;
  indicatable: boolean;
};

export type LooiGattCharacteristicSnapshot = {
  serviceUuid: string;
  uuid: string;
  key: LooiCharacteristicKey | null;
  readable: boolean;
  writableWithResponse: boolean;
  writableWithoutResponse: boolean;
  notifiable: boolean;
  indicatable: boolean;
};

export type LooiGattSnapshot = {
  deviceId: string | null;
  services: string[];
  characteristics: LooiGattCharacteristicSnapshot[];
  availableKeys: LooiCharacteristicKey[];
  legacyHandshakeAvailable: boolean;
};

export class ReactNativeBleLooiTransport implements LooiTransport {
  private readonly manager: BleManager;
  private readonly preferredDeviceId: string | null;
  private readonly robotName: string;
  private readonly scanTimeoutMs: number;
  private readonly bleStateTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onDisconnected?: (error?: Error) => void;
  private deviceId: string | null = null;
  private disconnectSubscription: Subscription | null = null;
  private notificationSubscriptions = new Map<LooiCharacteristicKey, Subscription>();
  private resolvedCharacteristics = new Map<LooiCharacteristicKey, ResolvedCharacteristic>();
  private gattSnapshot: LooiGattSnapshot = {
    deviceId: null,
    services: [],
    characteristics: [],
    availableKeys: [],
    legacyHandshakeAvailable: false,
  };

  constructor(options: ReactNativeBleLooiTransportOptions = {}) {
    this.manager = options.manager ?? new BleManager();
    this.preferredDeviceId = options.deviceId ?? null;
    this.robotName = options.robotName ?? process.env.EXPO_PUBLIC_LOOI_ROBOT_NAME ?? DEFAULT_ROBOT_NAME;
    this.scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
    this.bleStateTimeoutMs = options.bleStateTimeoutMs ?? DEFAULT_BLE_STATE_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.onDisconnected = options.onDisconnected;
  }

  async connect(): Promise<void> {
    if (Platform.OS === "web") {
      throw new Error("LOOI BLE transport requires a native iOS or Android runtime.");
    }

    await requestAndroidBluetoothPermissions();
    await this.waitForPoweredOn();

    const device = await this.findRobotDevice();
    let connectedDevice = device;
    let adoptedExistingConnection = await this.manager.isDeviceConnected(device.id).catch(() => false);

    if (!adoptedExistingConnection) {
      try {
        connectedDevice = await this.manager.connectToDevice(device.id, {
          timeout: this.connectTimeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const connectedAfterError = await this.manager.isDeviceConnected(device.id).catch(() => false);
        if (!connectedAfterError && !/already connected/i.test(message)) throw error;
        // Android can retain the GATT link even after lifecycle cancel. Treat the
        // platform's "already connected" result as an adoptable transport state:
        // rediscover GATT and let LooiRobot reconnect its notification callbacks.
        adoptedExistingConnection = true;
        recordDiagnosticEvent("robot", "ble-existing-connection-adopted", {
          deviceId: device.id,
          reason: connectedAfterError ? "connected-after-connect-error" : "already-connected-error",
          connectError: message,
        });
      }
    } else {
      recordDiagnosticEvent("robot", "ble-existing-connection-adopted", {
        deviceId: device.id,
        reason: "manager-is-connected",
      });
    }

    this.deviceId = connectedDevice.id;
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = this.manager.onDeviceDisconnected(connectedDevice.id, (error) => {
      if (this.deviceId !== connectedDevice.id) return;
      this.deviceId = null;
      for (const subscription of this.notificationSubscriptions.values()) subscription.remove();
      this.notificationSubscriptions.clear();
      this.resolvedCharacteristics.clear();
      this.gattSnapshot = { deviceId: null, services: [], characteristics: [], availableKeys: [], legacyHandshakeAvailable: false };
      this.disconnectSubscription = null;
      const normalizedError = error instanceof Error
        ? error
        : error ? new Error(String(error)) : undefined;
      recordDiagnosticEvent("robot", "ble-link-lost", {
        deviceId: connectedDevice.id,
        error: normalizedError?.message ?? "disconnected",
      });
      this.onDisconnected?.(normalizedError);
    });

    await this.manager.discoverAllServicesAndCharacteristicsForDevice(connectedDevice.id);
    await this.discoverGatt(connectedDevice.id);
    if (adoptedExistingConnection) {
      recordDiagnosticEvent("robot", "ble-existing-connection-gatt-restored", {
        deviceId: connectedDevice.id,
        availableKeys: this.gattSnapshot.availableKeys.join(","),
      });
    }

    if (Platform.OS === "android") {
      await this.manager.requestMTUForDevice(connectedDevice.id, 185).catch((error) => {
        console.warn("[LOOI BLE] MTU request failed; continuing with default MTU", error);
      });
    }
  }

  async disconnect(): Promise<void> {
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = null;
    for (const subscription of this.notificationSubscriptions.values()) {
      subscription.remove();
    }
    this.notificationSubscriptions.clear();

    await this.manager.stopDeviceScan().catch(() => {});

    if (this.deviceId) {
      const deviceId = this.deviceId;
      this.deviceId = null;
      this.resolvedCharacteristics.clear();
      this.gattSnapshot = { deviceId: null, services: [], characteristics: [], availableKeys: [], legacyHandshakeAvailable: false };
      await this.manager.cancelDeviceConnection(deviceId).catch(() => {});
    }
  }

  hasCharacteristic(characteristicKey: LooiCharacteristicKey): boolean {
    return this.resolvedCharacteristics.has(characteristicKey);
  }

  getGattSnapshot(): LooiGattSnapshot {
    return {
      ...this.gattSnapshot,
      services: [...this.gattSnapshot.services],
      characteristics: this.gattSnapshot.characteristics.map((item) => ({ ...item })),
      availableKeys: [...this.gattSnapshot.availableKeys],
    };
  }

  async startNotifications(
    characteristicKey: LooiCharacteristicKey,
    onValue?: LooiNotificationHandler,
  ): Promise<void> {
    const deviceId = this.requireDeviceId();
    const resolved = this.requireResolvedCharacteristic(characteristicKey);

    if (!resolved.notifiable && !resolved.indicatable) {
      throw new Error(`LOOI BLE characteristic ${shortUuid(resolved.characteristicUuid)} (${characteristicKey}) does not support notifications.`);
    }

    this.notificationSubscriptions.get(characteristicKey)?.remove();

    const subscription = this.manager.monitorCharacteristicForDevice(
      deviceId,
      resolved.serviceUuid,
      resolved.characteristicUuid,
      (error, characteristic) => {
        if (error) {
          console.warn(`[LOOI BLE] Notification failed for ${characteristicKey}`, error);
          return;
        }
        if (!onValue || !characteristic?.value) return;
        const bytes = base64ToBytes(characteristic.value);
        onValue({ characteristic: characteristicKey, hex: bytesToHex(bytes), bytes });
      },
      `looi-notify-${characteristicKey}`,
    );

    this.notificationSubscriptions.set(characteristicKey, subscription);
  }

  async write(
    characteristicKey: LooiCharacteristicKey,
    payloadHex: string,
    options: LooiWriteOptions = {},
  ): Promise<void> {
    const deviceId = this.requireDeviceId();
    const resolved = this.requireResolvedCharacteristic(characteristicKey);
    const value = bytesToBase64(hexToBytes(payloadHex, options.expectedBytes ?? null));

    const prefersWithoutResponse = options.response === false;
    if (prefersWithoutResponse && resolved.writableWithoutResponse) {
      await this.manager.writeCharacteristicWithoutResponseForDevice(
        deviceId,
        resolved.serviceUuid,
        resolved.characteristicUuid,
        value,
      );
      return;
    }

    if (resolved.writableWithResponse) {
      await this.manager.writeCharacteristicWithResponseForDevice(
        deviceId,
        resolved.serviceUuid,
        resolved.characteristicUuid,
        value,
      );
      return;
    }

    if (resolved.writableWithoutResponse) {
      await this.manager.writeCharacteristicWithoutResponseForDevice(
        deviceId,
        resolved.serviceUuid,
        resolved.characteristicUuid,
        value,
      );
      return;
    }

    throw new Error(`LOOI BLE characteristic ${shortUuid(resolved.characteristicUuid)} (${characteristicKey}) is not writable.`);
  }

  private async discoverGatt(deviceId: string): Promise<void> {
    this.resolvedCharacteristics.clear();
    const services = await this.manager.servicesForDevice(deviceId);
    const characteristicSnapshots: LooiGattCharacteristicSnapshot[] = [];

    for (const service of services) {
      const characteristics = await this.manager.characteristicsForDevice(deviceId, service.uuid).catch(() => []);
      for (const characteristic of characteristics) {
        const key = findCharacteristicKey(characteristic.uuid);
        characteristicSnapshots.push({
          serviceUuid: service.uuid,
          uuid: characteristic.uuid,
          key,
          readable: Boolean(characteristic.isReadable),
          writableWithResponse: Boolean(characteristic.isWritableWithResponse),
          writableWithoutResponse: Boolean(characteristic.isWritableWithoutResponse),
          notifiable: Boolean(characteristic.isNotifiable),
          indicatable: Boolean(characteristic.isIndicatable),
        });
        if (key && !this.resolvedCharacteristics.has(key)) {
          this.resolvedCharacteristics.set(key, {
            serviceUuid: service.uuid,
            characteristicUuid: characteristic.uuid,
            writableWithResponse: Boolean(characteristic.isWritableWithResponse),
            writableWithoutResponse: Boolean(characteristic.isWritableWithoutResponse),
            notifiable: Boolean(characteristic.isNotifiable),
            indicatable: Boolean(characteristic.isIndicatable),
          });
        }
      }
    }

    const availableKeys = [...this.resolvedCharacteristics.keys()];
    this.gattSnapshot = {
      deviceId,
      services: services.map((service) => service.uuid),
      characteristics: characteristicSnapshots,
      availableKeys,
      legacyHandshakeAvailable:
        this.resolvedCharacteristics.has("handshakeControl") &&
        this.resolvedCharacteristics.has("handshakeData"),
    };

    const compact = characteristicSnapshots.map((item) => `${shortUuid(item.uuid)}${item.key ? `:${item.key}` : ""}`).join(",");
    console.log(`[LOOI BLE] GATT discovered: ${compact || "no characteristics"}`);
    recordDiagnosticEvent("robot", "ble-gatt-discovered", {
      deviceId,
      serviceCount: services.length,
      characteristics: compact,
      availableKeys: availableKeys.join(","),
      legacyHandshakeAvailable: this.gattSnapshot.legacyHandshakeAvailable,
    });
  }

  private requireResolvedCharacteristic(characteristicKey: LooiCharacteristicKey): ResolvedCharacteristic {
    const resolved = this.resolvedCharacteristics.get(characteristicKey);
    if (resolved) return resolved;
    throw new Error(`LOOI BLE characteristic ${shortUuid(CHARACTERISTIC_UUIDS[characteristicKey])} (${characteristicKey}) is not exposed by this robot firmware.`);
  }

  private async waitForPoweredOn(): Promise<void> {
    const currentState = await this.manager.state();
    if (currentState === State.PoweredOn) return;

    if (Platform.OS === "android" && currentState === State.PoweredOff) {
      await this.manager.enable().catch(() => {});
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let subscription: Subscription | null = null;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        subscription?.remove();
        reject(new Error(`Bluetooth did not become ready within ${this.bleStateTimeoutMs}ms`));
      }, this.bleStateTimeoutMs);

      subscription = this.manager.onStateChange((nextState) => {
        if (nextState !== State.PoweredOn || settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription?.remove();
        resolve();
      }, true);
    });
  }

  private async findRobotDevice(): Promise<Device> {
    if (this.preferredDeviceId) {
      const connected = await this.manager.connectedDevices([LOOI_SERVICE_UUID]).catch(() => []);
      const connectedMatch = connected.find((device) => device.id === this.preferredDeviceId);
      if (connectedMatch) return connectedMatch;

      const known = await this.manager.devices([this.preferredDeviceId]).catch(() => []);
      if (known[0]) return known[0];
      return {
        id: this.preferredDeviceId,
        name: this.robotName,
        localName: this.robotName,
        serviceUUIDs: [LOOI_SERVICE_UUID],
      } as Device;
    }

    const connected = await this.manager.connectedDevices([LOOI_SERVICE_UUID]).catch(() => []);
    const connectedMatch = connected.find((device) => this.isTargetRobot(device)) ?? connected[0];
    if (connectedMatch) return connectedMatch;

    console.log(`[LOOI BLE] Scanning for ${this.robotName} by name or LOOI service`);

    return new Promise<Device>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        void this.manager.stopDeviceScan().finally(callback);
      };

      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`LOOI robot not found within ${this.scanTimeoutMs}ms`)));
      }, this.scanTimeoutMs);

      this.manager
        .startDeviceScan(
          null,
          {
            allowDuplicates: false,
            scanMode: Platform.OS === "android" ? ScanMode.LowLatency : undefined,
          },
          (error, device) => {
            if (error) {
              clearTimeout(timeout);
              finish(() => reject(error));
              return;
            }
            if (!device || !this.isTargetRobot(device)) return;
            clearTimeout(timeout);
            finish(() => resolve(device));
          },
        )
        .catch((error) => {
          clearTimeout(timeout);
          finish(() => reject(error));
        });
    });
  }

  private isTargetRobot(device: Device): boolean {
    return isLikelyLooiRobot(device, this.robotName);
  }

  private requireDeviceId(): string {
    if (!this.deviceId) {
      throw new Error("LOOI BLE device is not connected.");
    }
    return this.deviceId;
  }
}

export async function scanLooiRobotCandidates(options: {
  scanTimeoutMs?: number;
  robotName?: string;
} = {}): Promise<ScannedLooiRobot[]> {
  if (Platform.OS === "web") return [];

  await requestAndroidBluetoothPermissions();

  const manager = new BleManager();
  const robotName = options.robotName ?? process.env.EXPO_PUBLIC_LOOI_ROBOT_NAME ?? DEFAULT_ROBOT_NAME;
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;

  try {
    await waitForManagerPoweredOn(manager, DEFAULT_BLE_STATE_TIMEOUT_MS);

    return await new Promise<ScannedLooiRobot[]>((resolve, reject) => {
      const candidates = new Map<string, ScannedLooiRobot>();
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        void manager.stopDeviceScan().finally(callback);
      };
      const timeout = setTimeout(() => {
        finish(() => resolve([...candidates.values()].sort(compareScannedRobots)));
      }, scanTimeoutMs);

      manager
        .startDeviceScan(
          null,
          {
            allowDuplicates: false,
            scanMode: Platform.OS === "android" ? ScanMode.LowLatency : undefined,
          },
          (error, device) => {
            if (error) {
              clearTimeout(timeout);
              finish(() => reject(error));
              return;
            }
            if (!device || !isLikelyLooiRobot(device, robotName)) return;
            candidates.set(device.id, toScannedRobot(device));
          },
        )
        .catch((error) => {
          clearTimeout(timeout);
          finish(() => reject(error));
        });
    });
  } finally {
    await manager.destroy().catch(() => {});
  }
}

async function requestAndroidBluetoothPermissions(): Promise<void> {
  if (Platform.OS !== "android") return;

  const permissions =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const result = await PermissionsAndroid.requestMultiple(permissions);
  const denied = permissions.filter((permission) => result[permission] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied.length > 0) {
    throw new Error(`Bluetooth permissions denied: ${denied.join(", ")}`);
  }
}

async function waitForManagerPoweredOn(manager: BleManager, timeoutMs: number): Promise<void> {
  const currentState = await manager.state();
  if (currentState === State.PoweredOn) return;

  if (Platform.OS === "android" && currentState === State.PoweredOff) {
    await manager.enable().catch(() => {});
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscription: Subscription | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription?.remove();
      reject(new Error(`Bluetooth did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    subscription = manager.onStateChange((nextState) => {
      if (nextState !== State.PoweredOn || settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription?.remove();
      resolve();
    }, true);
  });
}

function findCharacteristicKey(uuid: string): LooiCharacteristicKey | null {
  const normalized = uuid.toLowerCase();
  for (const [key, expected] of Object.entries(CHARACTERISTIC_UUIDS) as Array<[LooiCharacteristicKey, string]>) {
    if (normalized === expected.toLowerCase() || shortUuid(normalized) === shortUuid(expected)) {
      return key;
    }
  }
  return null;
}

function shortUuid(uuid: string): string {
  const normalized = uuid.toLowerCase();
  const fullMatch = normalized.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
  return fullMatch?.[1] ?? normalized;
}

function isLikelyLooiRobot(device: Device, robotName: string): boolean {
  const advertisedName = device.name ?? device.localName ?? "";
  if (advertisedName === robotName) return true;
  if (advertisedName.toLowerCase().includes("looi")) return true;
  return Boolean(device.serviceUUIDs?.some((uuid) => uuid.toLowerCase() === LOOI_SERVICE_UUID));
}

function toScannedRobot(device: Device): ScannedLooiRobot {
  return {
    id: device.id,
    name: device.name ?? device.localName ?? "LOOI Robot",
    rssi: device.rssi ?? null,
    serviceUUIDs: device.serviceUUIDs ?? [],
  };
}

function compareScannedRobots(left: ScannedLooiRobot, right: ScannedLooiRobot): number {
  return (right.rssi ?? -999) - (left.rssi ?? -999);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = new Map(Array.from(BASE64_ALPHABET, (char, index) => [char, index]));

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triplet = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    output += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
    output += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 0x3f] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triplet & 0x3f] : "=";
  }

  return output;
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, "");
  const bytes: number[] = [];

  for (let index = 0; index < clean.length; index += 4) {
    const first = BASE64_LOOKUP.get(clean[index]) ?? 0;
    const second = BASE64_LOOKUP.get(clean[index + 1]) ?? 0;
    const third = BASE64_LOOKUP.get(clean[index + 2]) ?? 0;
    const fourth = BASE64_LOOKUP.get(clean[index + 3]) ?? 0;
    const triplet = (first << 18) | (second << 12) | (third << 6) | fourth;

    bytes.push((triplet >> 16) & 0xff);
    if (index + 2 < clean.length) bytes.push((triplet >> 8) & 0xff);
    if (index + 3 < clean.length) bytes.push(triplet & 0xff);
  }

  return new Uint8Array(bytes);
}
