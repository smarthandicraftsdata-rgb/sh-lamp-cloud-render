# Deploy RF5.4 backend

Deploy this tree before flashing the RF5.4 ESP and before installing iOS 1.8.0 (22).

Build command remains the package script (`prisma generate && tsc -p tsconfig.json`). There is no RF5.4 Prisma schema migration.

This source passed TypeScript 5.8.3 syntax/transpile validation in the packaging environment. The packaging environment could not perform a normal dependency-resolved `npm install`/`tsc -p` because its global npm registry is intentionally unavailable; Render deployment is therefore the real dependency-resolved backend build gate.
