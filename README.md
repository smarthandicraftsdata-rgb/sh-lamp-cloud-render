# SH Lamp Render Backend — R21A RF5 Production Candidate

This backend is the RF5 ordered-transport counterpart for iOS 1.7.4 (16) and the RF5 ESP firmware.

## What RF5 adds

- Output-domain latest-wins handling for `setOutputState`, legacy `setPower`, and legacy `setBrightness`.
- Duplicate command IDs are idempotent only when their semantics are identical.
- Terminal duplicate commands cannot be revived.
- `SENT` is recorded only after the device WebSocket send callback confirms the frame was accepted by the WebSocket implementation.
- Device sends are serialized per device.
- Device inbound messages are serialized per device.
- Device ACKs are rejected if they identify the wrong device.
- Device state uses boot identity/sequence/revision ordering so stale state cannot replace newer state.
- Backpressure is checked before sending to a device socket.
- REST command-status lookup remains access-scoped to the requested lamp/device.
- App WebSocket endpoint is `/ws/app`; device endpoint is `/ws/device`.

## Database

RF5 does **not** change `prisma/schema.prisma` relative to RF4 and adds no database migration. The existing RF4 database can be used. Normal Render start still runs `prisma migrate deploy` as configured.

## Build/runtime

Node engine: `>=22 <23`.

Typical commands:

```text
npm install
npm run build
npm run start:render
```

The RF5 validation environment passed syntax/transpile checks for all 14 TypeScript files and a stricter internal TypeScript type-check using dependency stubs. A live Render deployment and live database/device WebSocket test remain mandatory release-gate tests.

Use the outer bundle `READ_ME_FIRST.md` for deployment order and hardware acceptance testing.
