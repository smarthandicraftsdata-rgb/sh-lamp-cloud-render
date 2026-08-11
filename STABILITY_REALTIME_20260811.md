# Render realtime stability revision — 2026-08-11

This revision is designed to match SH Lamp iOS 1.6.0 and ESP32 R20E5 sync candidate.

Changes:
- Accepts `liveCommand` for ephemeral brightness-slider frames without DB command-row spam.
- Durable `command` flow remains persisted and acknowledged.
- ACKs for ephemeral commands are accepted and broadcast as state confirmation instead of being rejected as unknown IDs.
- Device battery/power-mode/runtime fields are accepted in state/ACK payloads.
- Persisted `rawJson` telemetry is normalized back into live app state.
- Reconnect flush includes safe idempotent `SENT` commands as well as `PENDING` commands.
- Connected devices also get a 5-second ACK-timeout retry for idempotent `SENT` commands, using the same `commandId`; toggle/identify are never auto-replayed.
- Expired `PENDING` and `SENT` commands are marked expired.
- Duplicate durable `commandId` submissions are treated idempotently when device/action/value match.

No Prisma migration is required for this revision; extended telemetry continues to be stored in the existing `rawJson` field.
