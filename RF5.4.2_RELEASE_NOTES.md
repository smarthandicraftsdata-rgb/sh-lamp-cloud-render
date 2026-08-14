# SH Lamp Render RF5.4.2 — post-hardware correction

Base: `sh-lamp-cloud-render-r21a-rf5.4.1-CompileFix1`
Date: 2026-08-13

## Why this revision exists

RF5.4.1 correctly added durable ingress, generation binding, ACK-before-secondary-persistence,
latest-wins supersession, user-bound command IDs, bounded state persistence and device TTLs.
Hardware testing then exposed one remaining backend transport race: a WS command could finish its
`socket.send()` callback, causing the short-lived `commandDispatches` promise to be removed; a
same-command REST hedge arriving afterward could find the already-created Prisma row and dispatch
the same command ID to the device again.

## RF5.4.2 correction

`WebSocketHub` now owns a bounded generation-bound durable in-flight table.

Invariant:

`(lampId, commandId)` is associated with the exact authenticated device generation before the
socket send is allowed to run. A successful send remains owned after the send callback returns.
A same-ID WS/REST hedge on the same generation joins the existing operation instead of calling
`socket.send()` again.

Release conditions:

- validated semantic ACK, after terminal command status is visible in PostgreSQL;
- command expiry;
- exact device-generation loss/replacement;
- immediate send failure (because no bytes were accepted, allowing a retry/hedge).

ACK-before-DB race protection:

When an ACK is validated, the entry is marked terminal immediately. It remains as an in-memory
ACK tombstone while the asynchronous Prisma ACK-status write is pending. If that write fails, the
tombstone remains until expiry, preventing a REST hedge from reopening physical redispatch.

Reconnect handling:

A real device generation loss releases old-generation ownership only while the command is still
unacknowledged, so an unexpired command can be recovered on the new authenticated generation.
A validated ACK tombstone deliberately survives a reconnect while its asynchronous DB status write
is pending; this closes the ACK -> reconnect -> REST hedge race. `flushPendingCommands()` also
passes through the durable guard.

Capacity handling is fail-closed: RF5.4.2 never evicts a live in-flight ownership entry merely to
make room. If the bounded table is full, a new unique durable dispatch is refused instead of
weakening same-ID idempotency.

The existing non-mutating `requestState` backend retry is preserved, but a terminal ACK blocks
that retry as well.

## Preserved RF5.4.1 behavior

- durable DB row exists before device delivery;
- latest-wins output group still includes `toggle`;
- duplicate command ownership still includes `userId`;
- device sends remain bound to an exact socket generation;
- ACK is forwarded to the issuing app before secondary Prisma state persistence;
- state persistence remains one in-flight + one replaceable latest slot;
- slider/live frame queue remains bounded/latest-only;
- command expiry is sent to the ESP (`expiresAt` and `expiresAtEpochSec`);
- no Prisma schema change or migration.

## Files changed

Behavioral change: `src/websocketHub.ts`

Version-label-only change: `src/commandService.ts`

All other TypeScript source files are byte-for-byte identical to the supplied RF5.4.1 CompileFix1
base.
