# SH Lamp R21A Multipath Foundation — READ FIRST

Date: 2026-08-11
Status: controlled test candidate, NOT yet production release

## Why this build exists
R21A is the safe first migration toward seamless BLE + Local Wi-Fi + Cloud control. It is deliberately additive: it keeps the control logic that is already working and adds the realtime/routing foundation around it.

## What is preserved
- Existing ESP GPIO4 lamp/TTP2 output behavior.
- Existing FFE1 BLE binary control opcodes and FFE2 Wi-Fi provisioning/status behavior.
- Existing HTTP API on port 80, including power/brightness/fade/timer/power-mode/status endpoints.
- Existing Render cloud device/app WebSocket command flow.
- Existing timer/fade/power-mode lamp logic.
- Existing battery estimator and low-battery protection.
- FINAL cutoff threshold: 2.903 V, 2 confirmation windows.
- Emergency threshold: 2.700 V.
- FINAL recovery threshold: 3.600 V and existing qualification behavior.
- Existing five-blink FINAL warning behavior.
- Existing iOS Build Fix 2 optimistic field holds and live timer countdown.

## What R21A adds
### ESP firmware
- BLE becomes available immediately at startup.
- Saved Wi-Fi joins in the background instead of blocking initial BLE availability.
- Repeated Wi-Fi authentication/handshake failures can still escalate to the stronger radio recovery path.
- A connected BLE control session is never intentionally silenced by that recovery path.
- New Local WebSocket server on port 81.
- Local WebSocket commands currently support setPower, setBrightness, setFadeMode, setTimer and requestState.
- Local realtime state is event-driven and uses the same proven lamp setters as BLE/HTTP/cloud.
- `bootId`, persistent `bootSequence`, and `stateRevision` are included in LAN/cloud/status state.
- Timer-only cancellation and timer completion now generate authoritative state revisions even if brightness was already zero.

### iOS 1.7.0
- Keeps BLE, Local Wi-Fi and Cloud availability separate from the currently selected command route.
- Uses BLE when it is healthy/near; uses LAN when BLE becomes weak; Cloud remains remote fallback.
- BLE RSSI is sampled every 3 seconds while connected.
- Hysteresis prevents BLE/LAN route flapping:
  - while on BLE: remain until approximately <= -82 dBm
  - while on LAN: return to BLE only when approximately >= -70 dBm
  - initial neutral choice: BLE at approximately >= -78 dBm
  These are test thresholds, not yet final production tuning values.
- New persistent Local WebSocket to the ESP on port 81.
- If that socket is already healthy, local commands use it immediately.
- If it is not healthy, the existing HTTP path is used; there is no WebSocket connection handshake in the user's button-press path.
- Existing 2-second HTTP status polling remains only as an old-firmware/socket-failure fallback. It is skipped while Local WebSocket is healthy.
- Realtime LAN/cloud states use boot/revision ordering so an older version cannot overwrite a newer one.
- Timer tracking is updated only after an incoming versioned state is accepted.
- Persisted live ordering tokens are cleared on app startup and relearned from live sources, protecting against an ESP/NVS reset.

### Render backend
- Existing command and retry behavior is unchanged.
- Device state schema accepts optional `bootId`, `bootSequence`, `stateRevision`.
- Those fields are returned to the app from persisted raw device state.
- No Prisma migration is required for R21A.

## Deliberately NOT enabled yet
R21A does NOT yet add aggressive BLE+LAN command racing / micro-hedging. It also does not change the existing BLE control payload to carry universal command IDs/revisions. Those should be a later R21B step only after this foundation is proven on real hardware.

R21A also does not replace the existing Bonjour `NetServiceBrowser` implementation yet. Network.framework/NWBrowser migration is deferred so discovery behavior is not changed at the same time as transport behavior.

## Deployment order
1. Deploy the R21A Render backend.
2. Flash R21A firmware to ONE test lamp only.
3. Verify serial boot and basic BLE/Wi-Fi/cloud operation.
4. Build/install iOS 1.7.0 via Codemagic.
5. Run the test matrix below.
6. Do not roll R21A to all lamps until the matrix passes.

## Expected cold-boot serial sequence
You should see lines similar to:
- `R21A startup: BLE available immediately; Wi-Fi joins in background`
- BLE advertising/startup messages
- `R21A preparing Wi-Fi attempt 1 ...`
- `R21A Wi-Fi authentication active; BLE control remains available`
- on success: router IP + mDNS + cloud authentication
- `R21A local realtime WebSocket started on port 81`

If repeated auth failures occur, a later attempt may show:
- `R21A Wi-Fi hard radio reset after repeated auth failures`
- and, only if no BLE client is currently connected, a temporary BLE-quiet recovery message.

## Required test matrix
### A. Cold boot — 15 complete power removals
For every boot record:
- time until lamp appears over BLE
- whether BLE control works while Wi-Fi is still joining
- Wi-Fi attempt number that succeeds
- disconnect reason for each failure, especially 204
- time until Cloud authenticates

### B. All routes available, phone near lamp
- Automatic route should prefer BLE when strong.
- ON/OFF must be immediate.
- Brightness drag must remain smooth.
- LAN and Cloud state must converge without UI jumps.

### C. Walk away while on same Wi-Fi
- BLE RSSI should fall.
- Route should move to Local Wi-Fi without screen refresh/jump.
- Route should not rapidly bounce BLE <-> LAN.
- Power and brightness should remain responsive.

### D. Turn iPhone Bluetooth off
- Local Wi-Fi should take over automatically when on same LAN.
- No second button press should be required.

### E. Leave the lamp LAN / use another network
- Cloud should become the available route.
- Power/brightness/timer/fade should still work.

### F. Return near lamp
- BLE reconnects.
- Once BLE is clearly healthy again, Automatic route may return to BLE without changing lamp state.

### G. Timer regression
- Set 60, 30, 15, cancel across BLE/LAN/Cloud.
- Countdown must keep moving every second.
- No stale 15m/30m preset jump.
- If timer expires while lamp is already logically OFF, every route must still converge to timer=0.

### H. Battery regression
- Values should converge across BLE/LAN/Cloud.
- No route change should make battery jump backward because of an older full-state packet.
- Do not intentionally force unsafe deep discharge merely to test cutoff.

### I. Power-mode regression
- Balanced / Maximum Backup / BLE Only / Touch Only behavior must remain as before.
- Power-mode switching remains nearby-only in the iOS app for safety.

### J. Old-firmware compatibility
With an R20E6/R20E5 lamp (no port-81 socket):
- iOS 1.7.0 must still control it through existing BLE/HTTP/cloud paths.

## Rollback
Because R21A is additive, rollback is simple:
- ESP: flash the known-working R20E6/R20E5 firmware.
- iOS: reinstall Build Fix 2.
- Backend: the R21A backend is backward-compatible because the new state fields are optional.

## Validation already performed here
- Full iOS Swift source: `swiftc -parse` PASS.
- Backend TypeScript source: TypeScript 5.8.3 syntax transpilation PASS.
- Firmware: lexical delimiter and preprocessor-balance checks PASS.
- Validated battery thresholds and key low-battery functions compared against R20E6; safety constants and core FINAL sequence are unchanged.

## Validation that still MUST happen on your hardware/toolchain
- Arduino compile with your installed ESP32 core and arduinoWebSockets library.
- Flash/serial test on ESP32-C3 Super Mini.
- Codemagic/Xcode Release compile and signing.
- Real iPhone route-handover testing.
- Live Render deployment and multi-hour stability test.

Do not call R21A production-ready until those tests pass.
