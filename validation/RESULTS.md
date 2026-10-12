# Validation — 12 October 2026

Input: sh-lamp-cloud-render-rf7-p2b-shadow-auth (1).zip.
Output: complete RF7 project with session recovery and five-minute ping, version 0.1.1.

## Passed locally

- Clean dependency install from the lockfile using Node 22.23.3.
- Prisma 6.19.3 client generation and TypeScript production build.
- Prisma schema validation.
- Existing RF5 source contracts, deep source contracts, backend acceptance model, deterministic random stress model, and RF7 P2B protocol-vector suite: all five suites passed.
- Compiled session service, HTTP refresh handler, and WebSocket error classification: 11 host tests passed with an in-memory transaction model.
- Compiled RF7 proof vector, credential-envelope tampering, challenge replay/expiry and socket-generation cleanup, disabled shadow auth, independent shadow/ACK lanes, concurrent account authentication, and closed-handshake handling: 7 additional tests passed.
- 18 total host tests passed, with no failures or skipped cases.
- Shadow-auth modules, credential envelope, device provisioning routes, command service and existing migrations compared byte-for-byte against the supplied archive and unchanged.
- Workflow YAML/shell syntax, five-minute cadence, artifact checksums and ZIP integrity.

## Not performed

- Live PostgreSQL migration execution and native database row-lock/concurrency testing. The included GitHub Actions regression workflow supplies PostgreSQL 16 and runs these checks after upload.
- Live deployment, activation of the five-minute schedule, and physical phone/server end-to-end testing. User will replace the branch.

The session model simulates atomic serialization. Its success is not a claim that PostgreSQL integration has been tested. Existing historical validation documents in the archive remain for context; this report records only the current checks.
