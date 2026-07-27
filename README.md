# SH Lamp Cloud — Phase 3A Render POC

A deployable test backend for SH Lamp accounts, homes, rooms, lamp claiming, remote commands, real-time state, and two-phone synchronization.

## Included

- Node.js 22 + TypeScript
- Express REST API
- WebSocket app/device channels
- PostgreSQL + Prisma
- JWT access tokens
- Rotating opaque refresh tokens
- bcrypt password hashing
- Per-device secret authentication
- One-time claim codes
- Command IDs, acknowledgements, expiry, and offline queueing
- Render health endpoint and Blueprint

## Important

This is a proof-of-concept backend for controlled testing. It is not yet the production certificate, OTA-signing, billing, backup, high-availability, or regulatory-security layer.

See:

- `docs/RENDER_SETUP.md`
- `docs/API.md`
- `docs/WEBSOCKET.md`
