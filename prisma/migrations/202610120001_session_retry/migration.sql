-- Additive: existing users, devices and refresh tokens are preserved.
-- Nullable sessionId also permits old code during a rolling deployment.
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "RefreshToken"
    ADD COLUMN "sessionId" UUID,
    ADD COLUMN "replacementId" UUID,
    ADD COLUMN "retryUntil" TIMESTAMP(3),
    ADD COLUMN "retryCiphertext" TEXT;
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE UNIQUE INDEX "RefreshToken_replacementId_key" ON "RefreshToken"("replacementId");
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");
CREATE INDEX "RefreshToken_retryUntil_idx" ON "RefreshToken"("retryUntil");
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_replacementId_fkey"
    FOREIGN KEY ("replacementId") REFERENCES "RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
