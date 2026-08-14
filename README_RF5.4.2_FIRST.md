# RF5.4.2 Render — read first

This folder is a full Render backend drop-in based on the supplied RF5.4.1 CompileFix1 source.
It fixes the post-hardware same-command WS/REST redispatch defect.

Deployment order once the complete three-component RF5.4.2 set exists:

1. Render RF5.4.2
2. ESP RF5.4.2
3. iOS RF5.4.2
4. Repeat the physical BLE -> LAN -> Cloud -> LAN -> BLE handover and rapid Cloud-tap tests.

No Prisma migration is required by this backend revision.

Useful new log line:

`RF5.4.2 CMD inflight_join id=... lamp=... generation=... terminalAck=...`

Seeing `inflight_join` for a REST hedge is expected. Seeing a second `device_send` for the same
command ID on the same generation is NOT expected.
