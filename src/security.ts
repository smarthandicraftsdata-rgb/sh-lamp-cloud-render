import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { AppError } from "./errors";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  type: "access";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeLampId(lampId: string): string {
  const normalized = lampId.trim().toUpperCase();
  if (!/^SH-[A-Z0-9]{4,16}$/.test(normalized)) {
    throw new AppError(400, "INVALID_LAMP_ID", "Lamp ID must look like SH-A31F92");
  }
  return normalized;
}

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new AppError(400, "PASSWORD_TOO_LONG", "Password must be 72 UTF-8 bytes or fewer");
  }
  return bcrypt.hash(password, config.bcryptRounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createAccessToken(user: { id: string; email: string }): string {
  const payload: AccessTokenPayload = { sub: user.id, email: user.email, type: "access" };
  return jwt.sign(payload, config.accessTokenSecret, {
    algorithm: "HS256",
    expiresIn: config.accessTokenTtlSeconds,
    issuer: "sh-lamp-cloud",
    audience: "sh-lamp-android"
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, config.accessTokenSecret, {
      algorithms: ["HS256"],
      issuer: "sh-lamp-cloud",
      audience: "sh-lamp-android"
    });

    if (typeof payload === "string" || payload.type !== "access" || typeof payload.sub !== "string") {
      throw new Error("Invalid token payload");
    }

    return payload as AccessTokenPayload;
  } catch {
    throw new AppError(401, "INVALID_TOKEN", "Access token is invalid or expired");
  }
}

export function createOpaqueToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function secretsEqual(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createClaimCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.randomBytes(length);
  return Array.from(random, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function randomCommandId(): string {
  return `cmd-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}
