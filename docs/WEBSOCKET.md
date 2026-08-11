# SH Lamp Cloud WebSocket Protocol — realtime stability revision

Secure endpoints:

- App: `wss://YOUR-SERVICE.onrender.com/ws/app`
- ESP32: `wss://YOUR-SERVICE.onrender.com/ws/device`

The server first sends `authRequired`. The app authenticates with an access token; the ESP32 authenticates with its lamp ID and device secret.

## App authentication

```json
{"type":"auth","token":"ACCESS_TOKEN"}
```

`authOk` includes the currently accessible device snapshots. Persisted telemetry is normalized so battery fields are available directly even when the database stored them in `rawJson`.

## Durable app command

Use for discrete actions and the final value of a continuous control:

```json
{
  "type":"command",
  "lampId":"SH-A31F92",
  "commandId":"ios-unique-command-id",
  "action":"setBrightness",
  "value":70
}
```

Durable actions: `toggle`, `setPower`, `setBrightness`, `setFadeMode`, `setTimer`, `identify`, `requestState`.

The server persists the command, dispatches it if the device is online, and otherwise leaves it queued until expiry. Safe idempotent SENT commands (`setPower`, `setBrightness`, `setFadeMode`, `setTimer`, `requestState`) are replayed with the same `commandId` after a device reconnect.

## Ephemeral live command

Use only for intermediate high-rate UI motion such as brightness-slider drag:

```json
{
  "type":"liveCommand",
  "lampId":"SH-A31F92",
  "commandId":"ios-live-unique-id",
  "action":"setBrightness",
  "value":63
}
```

`liveCommand` is forwarded directly to an online ESP32 and is not stored as a database command. The app must send one final durable `command` when the drag ends. This keeps the lamp responsive without filling the command table with slider frames.

## ESP32 state report

```json
{
  "type":"state",
  "power":true,
  "brightness":70,
  "fadeMode":2,
  "timerRemaining":842,
  "powerMode":"BALANCED",
  "runtimeState":"ACTIVE",
  "batteryValid":true,
  "batteryPercent":74,
  "batteryVoltageMv":3880,
  "batteryCharging":false,
  "firmwareVersion":"TTP2-WIFI-BLE-R20E5-SYNC-20260811"
}
```

The server broadcasts a normalized realtime event:

```json
{
  "type":"state",
  "lampId":"SH-A31F92",
  "online":true,
  "state":{
    "power":true,
    "brightness":70,
    "fadeMode":2,
    "timerRemaining":842,
    "updatedAt":"2026-08-11T10:30:00.000Z",
    "batteryValid":true,
    "batteryPercent":74,
    "batteryVoltageMv":3880
  }
}
```

Clients should derive a countdown deadline from `timerRemaining` + the state timestamp instead of waiting for one cloud packet every second.

## ESP32 acknowledgement

```json
{
  "type":"ack",
  "commandId":"ios-unique-command-id",
  "success":true,
  "state":{
    "power":true,
    "brightness":70,
    "fadeMode":2,
    "timerRemaining":842,
    "batteryValid":true,
    "batteryPercent":74
  }
}
```

Durable ACKs update the command status. ACKs for ephemeral live commands are accepted as live state confirmations even though no command row exists.

## Heartbeats

Both app and device connections use WebSocket ping/pong. The ESP32 also sends its existing application heartbeat. Dead sockets are terminated and reconnected.
