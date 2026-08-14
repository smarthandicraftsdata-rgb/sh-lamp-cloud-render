# RF5.4.3 Cloud Final Reliability

This release keeps RF5.4.2 device-generation/in-flight semantics and adds observability needed for the physical Cloud-final-command failure.

- ACK logs now include `error` and `ignoredReason`.
- Device-send logs include remaining command TTL at socket acceptance (`expires_in`).
- No Prisma schema change.
- The iOS RF5.4.3 client may reissue a failed newest durable ordered intent with a fresh commandId while preserving controller/session/sequence/value. Each retry therefore receives a fresh durable TTL without permitting duplicate physical execution.
