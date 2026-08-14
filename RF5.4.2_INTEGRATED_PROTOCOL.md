# RF5.4.2 integrated protocol

This backend is based on the user's later RF5.4.1 CompileFix1 backend, with the
RF5.4.2 DEEPFIX2 command-lifecycle hardening and the final integrated iOS/ESP
live-control contract.

Key invariant: `liveCommand` is accepted only for ordered absolute
`setOutputState`. Legacy `setBrightness`, relative `toggle`, timer, fade and
identify may not enter the replaceable live slot.

Durable same-ID ownership remains generation-bound until ACK/terminal state or
unacknowledged generation loss. Slow DB preparation uses a replaceable latest
pending intent per command domain and serial audit persistence.

No Prisma schema migration is required.
