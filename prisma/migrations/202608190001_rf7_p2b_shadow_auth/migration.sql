-- RF7 P2B: additive shadow-only production identity + wrapped HMAC credential storage.
-- Existing Device.lampId/deviceSecretHash authentication remains authoritative.

ALTER TABLE "Device"
ADD COLUMN "canonicalDeviceId" UUID,
ADD COLUMN "identityProtocol" TEXT,
ADD COLUMN "identityState" TEXT,
ADD COLUMN "identityKeyVersion" INTEGER;

CREATE UNIQUE INDEX "Device_canonicalDeviceId_key" ON "Device"("canonicalDeviceId");

CREATE TABLE "DeviceCredential" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SHADOW',
    "cipher" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "secretCiphertext" BYTEA NOT NULL,
    "secretIv" BYTEA NOT NULL,
    "secretAuthTag" BYTEA NOT NULL,
    "wrappingKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceCredential_deviceId_protocol_keyVersion_key"
ON "DeviceCredential"("deviceId", "protocol", "keyVersion");

CREATE INDEX "DeviceCredential_deviceId_status_idx"
ON "DeviceCredential"("deviceId", "status");

ALTER TABLE "DeviceCredential"
ADD CONSTRAINT "DeviceCredential_deviceId_fkey"
FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
