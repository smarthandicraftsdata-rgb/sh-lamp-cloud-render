# SH Lamp Cloud WebSocket Protocol v1

Use secure WebSockets on Render:

- Android: `wss://YOUR-SERVICE.onrender.com/ws/app`
- ESP32: `wss://YOUR-SERVICE.onrender.com/ws/device`

The server first sends:

```json
{"type":"authRequired","connection":"app","protocolVersion":1}
```

## Android authentication

```json
{"type":"auth","token":"ACCESS_TOKEN"}
```

The server replies with `authOk` and the accessible device snapshot.

### Android command

```json
{
  "type":"command",
  "lampId":"SH-A31F92",
  "commandId":"android-unique-command-id",
  "action":"setBrightness",
  "value":70
}
```

## ESP32 authentication

```json
{
  "type":"auth",
  "lampId":"SH-A31F92",
  "deviceSecret":"DEVICE_SECRET"
}
```

### ESP32 state report

```json
{
  "type":"state",
  "power":true,
  "brightness":70,
  "fadeMode":0,
  "timerRemaining":0,
  "firmwareVersion":"R9-TEST"
}
```

### Server command to ESP32

```json
{
  "type":"deviceCommand",
  "commandId":"cmd-...",
  "action":"setBrightness",
  "value":70,
  "expiresAt":"2026-07-27T12:00:00.000Z"
}
```

### ESP32 acknowledgement

```json
{
  "type":"ack",
  "commandId":"cmd-...",
  "success":true,
  "state":{"power":true,"brightness":70,"fadeMode":0,"timerRemaining":0}
}
```

Both clients should send every 30–60 seconds:

```json
{"type":"heartbeat"}
```

The server also uses WebSocket ping/pong to terminate dead connections.
