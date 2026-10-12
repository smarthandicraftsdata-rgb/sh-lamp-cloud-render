import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { config } from "./config";
import { AppError } from "./errors";
import { createAccessToken, createOpaqueToken, hashSecret, secretsEqual } from "./security";

const transactionOptions = { maxWait: 5_000, timeout: 10_000 };
const retryKey = crypto.createHash("sha256")
  .update("SHLamp.refresh-retry.v1\0", "utf8")
  .update(config.accessTokenSecret, "utf8").digest();

function invalidRefresh(): AppError {
  return new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
}

// A database row lock coordinates all instances, including logout/reset races.
// NO KEY UPDATE also permits unrelated FK inserts while this short lock is held.
export async function lockSessionUser(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR NO KEY UPDATE
  `;
  return rows.length === 1;
}

function context(parentId: string, sessionId: string, userId: string, childId: string): Buffer {
  return Buffer.from(JSON.stringify(["v1", parentId, sessionId, userId, childId]), "utf8");
}

function seal(token: string, aad: Buffer): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", retryKey, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url")].join(".");
}

function unseal(value: string, aad: Buffer): string {
  try {
    const parts = value.split(".");
    if(value.length > 1024 || parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid cache");
    const decode = (part: string | undefined): Buffer => {
      if(!part || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid encoding");
      const bytes = Buffer.from(part, "base64url");
      if(bytes.toString("base64url") !== part) throw new Error("Invalid encoding");
      return bytes;
    };
    const nonce = decode(parts[1]), encrypted = decode(parts[2]), tag = decode(parts[3]);
    if(nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid cache");
    const decipher = crypto.createDecipheriv("aes-256-gcm", retryKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    if(!/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error("Invalid token");
    return token;
  } catch {
    // Corrupt/unavailable recovery storage is a server fault, not a reason
    // for clients to erase their login. Never log cached secrets or tokens.
    throw new AppError(503, "SESSION_RETRY_UNAVAILABLE", "Session recovery is temporarily unavailable. Try again.");
  }
}

function reply(user: { id: string; email: string }, token: string, expiresAt: Date) {
  return {
    accessToken: createAccessToken(user),
    accessTokenExpiresIn: config.accessTokenTtlSeconds,
    refreshToken: token,
    refreshTokenExpiresAt: expiresAt.toISOString()
  };
}

export async function issueSession(user: { id: string; email: string; passwordHash?: string }) {
  return prisma.$transaction(async tx => {
    if(!await lockSessionUser(tx, user.id)) throw invalidRefresh();
    const currentUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    // A password reset during bcrypt verification must invalidate that login.
    if(user.passwordHash && user.passwordHash !== currentUser.passwordHash)
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    const session = await tx.authSession.create({ data: { userId: user.id } });
    const token = createOpaqueToken();
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000);
    await tx.refreshToken.create({ data: {
      userId: user.id, sessionId: session.id, tokenHash: hashSecret(token), expiresAt
    } });
    return reply(currentUser, token, expiresAt);
  }, transactionOptions);
}

export async function refreshSession(token: string) {
  const tokenHash = hashSecret(token);
  const lookup = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if(!lookup) throw invalidRefresh();
  return prisma.$transaction(async tx => {
    if(!await lockSessionUser(tx, lookup.userId)) throw invalidRefresh();
    const now = new Date();
    // Drop expired encrypted caches when this user next performs a refresh.
    // Their original fixed deadline is always checked, even before cleanup.
    await tx.refreshToken.updateMany({
      where: { userId: lookup.userId, retryUntil: { lte: now }, retryCiphertext: { not: null } },
      data: { retryCiphertext: null }
    });
    let stored = await tx.refreshToken.findUnique({ where: { tokenHash }, include: { user: true, session: true } });
    if(!stored) throw invalidRefresh();
    if(!stored.sessionId) {
      // Existing valid tokens remain usable after the additive migration.
      // Previously spent/expired tokens have no recovery data and stay invalid.
      if(stored.revokedAt || stored.expiresAt <= now) throw invalidRefresh();
      const session = await tx.authSession.create({ data: { userId: stored.userId } });
      await tx.refreshToken.update({ where: { id: stored.id }, data: { sessionId: session.id } });
      stored = { ...stored, sessionId: session.id, session };
    }
    const sessionId = stored.sessionId;
    if(!sessionId || !stored.session || stored.session.revokedAt ||
       stored.session.userId !== stored.userId) throw invalidRefresh();

    if(stored.revokedAt) {
      if(!stored.replacementId || !stored.retryUntil || stored.retryUntil <= now || !stored.retryCiphertext)
        throw invalidRefresh();
      const child = await tx.refreshToken.findUnique({ where: { id: stored.replacementId } });
      if(!child || child.userId !== stored.userId || child.sessionId !== sessionId ||
         child.revokedAt || child.expiresAt <= now) throw invalidRefresh();
      const recovered = unseal(stored.retryCiphertext, context(stored.id, sessionId, stored.userId, child.id));
      if(!secretsEqual(recovered, child.tokenHash))
        throw new AppError(503, "SESSION_RETRY_UNAVAILABLE", "Session recovery is temporarily unavailable. Try again.");
      // Replay the same successor; never slide the grace window or extend its TTL.
      return reply(stored.user, recovered, child.expiresAt);
    }

    if(stored.expiresAt <= now) throw invalidRefresh();
    const nextToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + config.refreshTokenTtlDays * 86_400_000);
    const child = await tx.refreshToken.create({ data: {
      userId: stored.userId, sessionId, tokenHash: hashSecret(nextToken), expiresAt
    } });
    const consumed = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null, expiresAt: { gt: now } },
      data: {
        revokedAt: now, replacementId: child.id,
        retryUntil: new Date(now.getTime() + config.refreshRetryGraceSeconds * 1000),
        retryCiphertext: seal(nextToken, context(stored.id, sessionId, stored.userId, child.id))
      }
    });
    if(consumed.count !== 1) throw invalidRefresh(); // Rolls back the child too.
    return reply(stored.user, nextToken, expiresAt);
  }, transactionOptions);
}

// Caller holds lockSessionUser. Reset/revocation cannot race a new rotation.
export async function revokeUserSessions(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<void> {
  await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.refreshToken.updateMany({ where: { userId }, data: { retryUntil: null, retryCiphertext: null } });
}

export async function logoutSession(token: string): Promise<void> {
  const tokenHash = hashSecret(token);
  const lookup = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if(!lookup) return; // Idempotent, and does not disclose whether a token exists.
  await prisma.$transaction(async tx => {
    if(!await lockSessionUser(tx, lookup.userId)) return;
    const stored = await tx.refreshToken.findUnique({ where: { tokenHash } });
    if(!stored) return;
    const now = new Date();
    if(stored.sessionId) {
      await tx.authSession.updateMany({ where: { id: stored.sessionId, revokedAt: null }, data: { revokedAt: now } });
      await tx.refreshToken.updateMany({ where: { sessionId: stored.sessionId, revokedAt: null }, data: { revokedAt: now } });
      await tx.refreshToken.updateMany({ where: { sessionId: stored.sessionId }, data: { retryUntil: null, retryCiphertext: null } });
    } else {
      await tx.refreshToken.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: now } });
    }
  }, transactionOptions);
}
