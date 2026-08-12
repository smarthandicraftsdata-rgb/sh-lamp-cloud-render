# R21A RF5 Backend Release Notes

RF5 keeps the RF4 account/device WebSocket architecture and tightens ordering and acknowledgement semantics.

The most important rule is that a command is not treated as complete merely because Render placed a frame on a device socket. The ESP must return the matching semantic ACK. Duplicate command IDs are accepted only for the same semantic command, latest-wins grouping is enforced in the output/fade/timer domains, and per-device send/receive queues prevent backend-local reordering.

No Prisma schema change or new migration is required compared with RF4.
