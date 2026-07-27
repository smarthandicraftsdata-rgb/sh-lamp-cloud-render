CREATE TYPE "HomeRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'GUEST');
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'EXPIRED');

CREATE TABLE "User" (
  "id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Home" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "ownerId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Home_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HomeMember" (
  "id" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "role" "HomeRole" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HomeMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Room" (
  "id" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Device" (
  "id" UUID NOT NULL,
  "lampId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL DEFAULT 'SH Lamp',
  "deviceSecretHash" TEXT NOT NULL,
  "claimCodeHash" TEXT,
  "claimedAt" TIMESTAMP(3),
  "ownerId" UUID,
  "homeId" UUID,
  "roomId" UUID,
  "online" BOOLEAN NOT NULL DEFAULT false,
  "lastSeen" TIMESTAMP(3),
  "firmwareVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceState" (
  "id" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "power" BOOLEAN NOT NULL DEFAULT false,
  "brightness" INTEGER NOT NULL DEFAULT 0,
  "fadeMode" INTEGER NOT NULL DEFAULT 0,
  "timerRemaining" INTEGER NOT NULL DEFAULT 0,
  "rawJson" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceCommand" (
  "id" UUID NOT NULL,
  "commandId" TEXT NOT NULL,
  "deviceId" UUID NOT NULL,
  "userId" UUID,
  "action" TEXT NOT NULL,
  "valueJson" JSONB,
  "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefreshToken" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityEvent" (
  "id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB,
  "userId" UUID,
  "deviceId" UUID,
  "homeId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Home_ownerId_idx" ON "Home"("ownerId");
CREATE UNIQUE INDEX "HomeMember_homeId_userId_key" ON "HomeMember"("homeId", "userId");
CREATE INDEX "HomeMember_userId_idx" ON "HomeMember"("userId");
CREATE UNIQUE INDEX "Room_homeId_name_key" ON "Room"("homeId", "name");
CREATE INDEX "Room_homeId_idx" ON "Room"("homeId");
CREATE UNIQUE INDEX "Device_lampId_key" ON "Device"("lampId");
CREATE INDEX "Device_ownerId_idx" ON "Device"("ownerId");
CREATE INDEX "Device_homeId_idx" ON "Device"("homeId");
CREATE INDEX "Device_roomId_idx" ON "Device"("roomId");
CREATE UNIQUE INDEX "DeviceState_deviceId_key" ON "DeviceState"("deviceId");
CREATE UNIQUE INDEX "DeviceCommand_commandId_key" ON "DeviceCommand"("commandId");
CREATE INDEX "DeviceCommand_deviceId_status_idx" ON "DeviceCommand"("deviceId", "status");
CREATE INDEX "DeviceCommand_expiresAt_idx" ON "DeviceCommand"("expiresAt");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE INDEX "ActivityEvent_userId_createdAt_idx" ON "ActivityEvent"("userId", "createdAt");
CREATE INDEX "ActivityEvent_deviceId_createdAt_idx" ON "ActivityEvent"("deviceId", "createdAt");
CREATE INDEX "ActivityEvent_homeId_createdAt_idx" ON "ActivityEvent"("homeId", "createdAt");

ALTER TABLE "Home" ADD CONSTRAINT "Home_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HomeMember" ADD CONSTRAINT "HomeMember_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HomeMember" ADD CONSTRAINT "HomeMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Room" ADD CONSTRAINT "Room_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeviceState" ADD CONSTRAINT "DeviceState_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;
