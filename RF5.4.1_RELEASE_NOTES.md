# RF5.4.1 Render backend release notes

RF5.4.1 removes database/state persistence from the normal semantic-ACK latency path while preserving durable command creation before ESP dispatch.

The common durable control path is now:
app command -> one durable DB transaction -> exact-generation ESP send -> ESP semantic ACK -> immediate app ACK -> independent command-status/state persistence.

State snapshots use one in-flight + one replaceable pending snapshot per lamp; a superseded socket generation cannot later persist/broadcast current state.

No Prisma schema migration is required.
