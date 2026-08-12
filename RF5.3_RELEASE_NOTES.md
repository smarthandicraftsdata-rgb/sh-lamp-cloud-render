# Render backend RF5.3 — Cloud slider stability

No database migration is required.

Changes:
1. `liveCommand` frames are forwarded to the ESP with `ephemeral: true`.
2. Lamps accessible at app-WebSocket authentication are cached on that authenticated socket, eliminating one Prisma authorization query per slider frame.
3. During mixed deployment, ACK/state bursts from older RF5/RF5.1 firmware are suppressed for known ephemeral command IDs instead of performing redundant Prisma writes/broadcasts.
4. Durable commands, final slider release, semantic ACK persistence, wrong-device ACK protection, per-device send ordering and normal state persistence are unchanged.

Recommended deployment order: backend -> one RF5.3 ESP -> iOS 1.7.9 build 21.
