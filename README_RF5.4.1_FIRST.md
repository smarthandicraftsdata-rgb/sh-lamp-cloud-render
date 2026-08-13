# Deploy RF5.4.1 Render backend

Deploy this backend before flashing the RF5.4.1 ESP and before installing iOS 1.8.1 (23).

No Prisma schema migration is introduced by RF5.4.1.

Main changes:
- durable latest-wins ingress uses one DB transaction for supersede + insert on the common path;
- same-ID WS/REST hedge is coalesced and cross-user command-ID reuse is rejected;
- device sends bind to the exact authenticated WebSocket generation;
- no durable per-lamp send callback promise chain that can head-of-line block newer commands;
- slider traffic has one in-flight + one replaceable latest slot;
- device command expiry is forwarded to ESP as numeric epoch deadline;
- normal semantic ACK is forwarded to the issuing user's app socket before state persistence;
- command status persistence is independent of state persistence so REST hedges can observe ACK quickly;
- device state persistence is latest-only, bounded, and socket-generation-aware;
- `toggle` is included in the output latest-wins domain;
- old backend control retry that waited longer than the control TTL is not present.

Build command remains `prisma generate && tsc -p tsconfig.json` on Render.
