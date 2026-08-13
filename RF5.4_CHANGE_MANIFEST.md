# RF5.4 Render backend change manifest

Primary changed control-path files:

- `src/commandService.ts`
  - one output supersession domain for toggle/setOutputState/setPower/setBrightness
  - exact same-ID WS+REST coalescing
  - same-ID idempotency bound to user/device/action/value
  - short bounded per-device DB ingress lane only; socket I/O happens outside the lane
  - 2 s current-control TTL propagated as `expiresAtEpochSec`

- `src/websocketHub.ts`
  - authoritative ESP socket generation numbers
  - outbound frame bound to exact socket+generation
  - stale generation cannot mutate current online/state/ACK state
  - durable sends are not serialized behind an earlier WebSocket callback
  - each send callback has a 300 ms health budget
  - live brightness has one in-flight + one replaceable pending latest slot
  - app lamp-access cache is time bounded
  - current controls are not silently retried by the old 5 s housekeeping path

No Prisma schema migration is required by RF5.4.
