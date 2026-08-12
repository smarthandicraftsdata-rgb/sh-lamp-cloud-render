# SH Lamp R21A RF4 — Handover Ordering + Cloud Recovery
Date: 2026-08-11

## Why RF4 exists
RF2 hardware testing exposed two separate problems during BLE -> LAN -> Cloud -> LAN transitions:

1. iOS could allow an older asynchronous control task to fall back after a newer user intent had already been applied. Example: an older ON local verification sees the newer OFF state, decides ON failed, and then re-sends ON over BLE/Cloud.
2. The ESP device WebSocket could remain cloud=OFFLINE while router Wi-Fi remained CONNECTED after the normal bounded RF2 reconnect episode.

The RF2 serial log also showed multiple simultaneous Local WebSocket clients (#0/#1/#2), so the app's local realtime aliases are deduplicated in RF4.

## RF4 app changes (iOS 1.7.3)
- Per-lamp, per-field latest-intent generations for power, brightness, fade, timer, and power mode.
- A superseded task is forbidden from falling through to another transport.
- Cloud -> LAN handover fence for unacknowledged cloud mutations.
- The fence releases immediately when the matching *latest* ESP cloud ACK arrives.
- Backend RF4 control TTL is 2 s; app fence is 2.25 s for REST/unacknowledged commands.
- Account WebSocket is explicitly rebound when the iPhone changes cellular <-> Wi-Fi.
- Cloud ping failure now forces reconnect; reconnect tasks are single/cancellable.
- Only the real backend endpoint /ws/app is attempted.
- A cloud route is considered healthy only when the app WebSocket is authenticated AND the backend says that lamp is online.
- Local realtime host aliases are deduplicated after lamp identity is known, and an already-healthy socket wins to prevent IP <-> mDNS oscillation.
- Local WebSocket remains STATE/EVENT ONLY. Local commands remain on the proven HTTP endpoints.

## RF4 firmware changes
RF4 includes all RF3 boot/BLE fixes:
- BLE remains available while Wi-Fi authentication fails/retries.
- Successful STA association supersedes a stale earlier 204 HANDSHAKE_TIMEOUT event.
- Hard Wi-Fi recovery is not repeated on every later attempt.

RF4 adds only cloud-transport recovery around RF3:
- If router Wi-Fi is CONNECTED but cloud remains unauthenticated/offline continuously for 35 s, rebuild the WebSocketsClient transport.
- Hard cloud transport restart has a 30 s cooldown.
- This does not restart Wi-Fi and does not modify lamp state.

## Backend changes
- setPower / setBrightness / setFadeMode / setTimer cloud lifetime: max 2 s.
- Same-action cloud commands remain latest-wins.
- Ephemeral live slider command lifetime: 1.5 s.
- requestState keeps up to 10 s.
- Old cloud controls cannot replay several seconds later across a LAN handover.

## Deliberately unchanged
- PWM / physical lamp output
- fade engine
- brightness target logic
- normal timer setter
- BLE FFE1 control protocol
- local HTTP command API
- R20E battery estimator
- FINAL <= 2.903 V x2
- emergency <= 2.700 V
- recovery >= 3.600 V held 60 s
- Local WebSocket mutation remains disabled

## Deployment order
1. Deploy the RF4 Render backend.
2. Flash RF4 firmware to ONE test lamp.
3. Build/install iOS 1.7.3.
4. Repeat: BLE -> walk away to LAN -> Wi-Fi OFF to Cloud -> Wi-Fi ON back to LAN.

## Required test
While on Cloud, press ON/OFF once, then turn phone Wi-Fi on. When LAN is promoted, the first local ON/OFF must match the latest user intent. Rapid ON/OFF taps must never be re-applied out of order.

For device cloud recovery, if router Wi-Fi stays connected while the cloud socket is stuck, expect after prolonged offline state:
`R21A RF4: hard-restarting cloud WebSocket transport after prolonged offline state`
followed by a new secure connection/authentication attempt.

This is a controlled test candidate. It has static/syntax/regression checks but still requires Codemagic/Xcode and real ESP/router/Render testing before production release.
