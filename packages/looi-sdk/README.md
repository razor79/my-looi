# @sourcebug/looi-sdk

`@sourcebug/looi-sdk` is an early TypeScript SDK for LOOI Robot. It wraps
low-level BLE characteristic writes in a small, transport-independent robot
control API.

The React Native application in the My LOOI repository is a consumer of the
SDK, not part of its public API. Connecting a physical robot is optional for the
application's voice and memory features.

## Scope

The current SDK provides:

1. movement commands: forward, backward, left, right, and stop;
2. repeated movement for press-and-hold controls or a virtual joystick;
3. head positions: up, center, and down;
4. light control;
5. dock-state notifications;
6. raw BLE characteristic writes for protocol experiments.

The package is written in TypeScript and exports its type definitions.

## Installation

Inside this monorepo:

```bash
pnpm add @sourcebug/looi-sdk@workspace:*
```

After publication to npm:

```bash
pnpm add @sourcebug/looi-sdk
```

## Quick example

```ts
import { LooiRobot, WebBluetoothLooiTransport } from "@sourcebug/looi-sdk";

const robot = new LooiRobot(new WebBluetoothLooiTransport());

await robot.connect({
  onDock: ({ docked, raw }) => {
    console.log("Dock state", docked, raw.hex);
  },
});

await robot.move("forward");
robot.startMoveLoop("left");
await robot.stop();
await robot.setHead("center");
await robot.setLight(true);

await robot.writeRaw("fe00", "00100000010032030a0001ff00010a3203ff0003", {
  response: true,
});
```

## Core API

### `LooiRobot`

The high-level robot client. It accepts any transport that implements
`LooiTransport`.

- `connect(options?)`: connect and perform the default handshake.
- `disconnect()`: disconnect and clean up movement loops.
- `move(direction)`: send one movement command.
- `startMoveLoop(direction, intervalMs?)`: repeatedly send movement commands.
- `stopMoveLoop()`: stop the repeated movement loop.
- `stop()`: send the stop command.
- `setHead(direction)`: set the head position.
- `setLight(enabled)`: turn the light on or off.
- `writeRaw(characteristic, hex, options?)`: write to a raw characteristic.

### `WebBluetoothLooiTransport`

A browser Web Bluetooth transport for Chrome, Edge, and other compatible
environments. It is primarily intended for protocol validation and early SDK
testing.

The React Native app implements its BLE transport in the app layer and connects
it to `LooiRobot` through the same `LooiTransport` interface.

### `LooiTransport`

The transport interface separates high-level robot behavior from a concrete
BLE implementation. A transport provides connection, disconnection, writing,
and notification subscription.

## Exports

- `LooiRobot`
- `WebBluetoothLooiTransport`
- `normalizeHex()`
- `hexToBytes()`
- `bytesToHex()`
- `createInitTimeHex()`
- `LOOI_MOVE_VALUES`
- `LOOI_HEAD_VALUES`
- `LOOI_LIGHT_VALUES`
- `LooiTransport`
- `LooiMoveDirection`
- `LooiHeadDirection`
- `LooiWriteOptions`
- `LooiRawNotification`
- `LooiDockEvent`
- `LooiConnectOptions`
- `LooiRobotOptions`

## Design principles

- Expose high-level behavior so consumers do not need every BLE protocol detail.
- Run the default handshake after `connect()`.
- Surface dock-state changes through `onDock`.
- Reserve `writeRaw()` for operations that do not yet have a high-level API.
- Keep the core independent of Web Bluetooth, React Native BLE, and Node bridges.

## Development

```bash
cd packages/looi-sdk
pnpm check
pnpm build
```
