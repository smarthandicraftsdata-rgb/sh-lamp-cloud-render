# R21A RF2 handover/cloud stability notes

- Absolute cloud controls (`setPower`, `setBrightness`, `setFadeMode`, `setTimer`) now use a 6-second maximum lifetime.
- New absolute commands supersede older unacknowledged commands of the same action.
- Legacy queued absolute controls older than 6 seconds are expired before reconnect replay.
- `COMMAND_TTL_SECONDS` remains an environment ceiling for backward compatibility; RF2 applies the stricter real-time control lifetime in code.
- No database migration is required.
