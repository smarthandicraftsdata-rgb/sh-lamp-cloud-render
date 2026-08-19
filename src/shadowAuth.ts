import crypto from "node:crypto";
import { z } from "zod";

export const SH_AUTH_PROTOCOL = "SH-AUTH-V1" as const;
export const SH_AUTH_PREFIX = Buffer.from(SH_AUTH_PROTOCOL, "ascii");
export const SH_AUTH_MESSAGE_BYTES = 75;
export const SH_AUTH_UUID_BYTES = 16;
export const SH_AUTH_CHALLENGE_ID_BYTES = 16;
export const SH_AUTH_NONCE_BYTES = 32;
export const SH_AUTH_PROOF_BYTES = 32;
export const SH_AUTH_CHALLENGE_TTL_MS = 30_000;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export const authV2HelloSchema = z.object({
  type: z.literal("authV2Hello"),
  protocol: z.literal(SH_AUTH_PROTOCOL),
  deviceId: z.string().transform((value) => value.trim().toLowerCase()).refine((value) => UUID_V4_RE.test(value), {
    message: "deviceId must be a canonical UUIDv4"
  }),
  keyVersion: z.number().int().min(1).max(65535)
});

export const authV2ProofSchema = z.object({
  type: z.literal("authV2Proof"),
  protocol: z.literal(SH_AUTH_PROTOCOL),
  deviceId: z.string().transform((value) => value.trim().toLowerCase()).refine((value) => UUID_V4_RE.test(value), {
    message: "deviceId must be a canonical UUIDv4"
  }),
  keyVersion: z.number().int().min(1).max(65535),
  challengeId: z.string().regex(HEX32_RE),
  proof: z.string().regex(HEX64_RE)
});

export type AuthV2Hello = z.infer<typeof authV2HelloSchema>;
export type AuthV2Proof = z.infer<typeof authV2ProofSchema>;

export type AuthV2Challenge = {
  type: "authV2Challenge";
  protocol: typeof SH_AUTH_PROTOCOL;
  deviceId: string;
  keyVersion: number;
  challengeId: string;
  nonce: string;
  expiresInMs: number;
  shadowOnly: true;
};

export type AuthV2ShadowCode =
  | "OK"
  | "INVALID_REQUEST"
  | "DISABLED"
  | "UNKNOWN_DEVICE"
  | "DEVICE_MISMATCH"
  | "KEY_VERSION_MISMATCH"
  | "CREDENTIAL_UNAVAILABLE"
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_ALREADY_USED"
  | "INVALID_PROOF"
  | "INTERNAL_ERROR";

export type AuthV2ShadowResult = {
  type: "authV2ShadowResult";
  protocol: typeof SH_AUTH_PROTOCOL;
  deviceId: string;
  keyVersion: number;
  ok: boolean;
  shadowOnly: true;
  code: AuthV2ShadowCode;
};

export function isShadowAuthMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "authV2Hello" || type === "authV2Proof";
}

export function uuidV4ToRawBytes(input: string): Buffer {
  const normalized = input.trim().toLowerCase();
  if (!UUID_V4_RE.test(normalized)) throw new Error("INVALID_CANONICAL_UUID_V4");
  const raw = Buffer.from(normalized.replaceAll("-", ""), "hex");
  if (raw.length !== SH_AUTH_UUID_BYTES) throw new Error("INVALID_UUID_LENGTH");
  return raw;
}

export function buildShAuthV1Message(deviceId: string, challengeId: Buffer, nonce: Buffer): Buffer {
  if (challengeId.length !== SH_AUTH_CHALLENGE_ID_BYTES) throw new Error("INVALID_CHALLENGE_ID_LENGTH");
  if (nonce.length !== SH_AUTH_NONCE_BYTES) throw new Error("INVALID_NONCE_LENGTH");

  const uuid = uuidV4ToRawBytes(deviceId);
  const out = Buffer.alloc(SH_AUTH_MESSAGE_BYTES);
  let offset = 0;
  SH_AUTH_PREFIX.copy(out, offset);
  offset += SH_AUTH_PREFIX.length;
  out[offset++] = 0x00;
  uuid.copy(out, offset);
  offset += uuid.length;
  challengeId.copy(out, offset);
  offset += challengeId.length;
  nonce.copy(out, offset);
  offset += nonce.length;
  if (offset !== SH_AUTH_MESSAGE_BYTES) throw new Error(`SH_AUTH_V1_INTERNAL_LENGTH_${offset}`);
  return out;
}

export function computeShAuthV1Proof(deviceSecret: Buffer, canonicalMessage: Buffer): Buffer {
  if (deviceSecret.length !== 32) throw new Error("INVALID_DEVICE_SECRET_LENGTH");
  if (canonicalMessage.length !== SH_AUTH_MESSAGE_BYTES) throw new Error("INVALID_AUTH_MESSAGE_LENGTH");
  return crypto.createHmac("sha256", deviceSecret).update(canonicalMessage).digest();
}

export function verifyShAuthV1Proof(expected: Buffer, presentedHex: string): boolean {
  if (expected.length !== SH_AUTH_PROOF_BYTES || !HEX64_RE.test(presentedHex)) return false;
  const presented = Buffer.from(presentedHex, "hex");
  return presented.length === expected.length && crypto.timingSafeEqual(expected, presented);
}

export function randomChallengeMaterial(): { challengeId: Buffer; nonce: Buffer } {
  return {
    challengeId: crypto.randomBytes(SH_AUTH_CHALLENGE_ID_BYTES),
    nonce: crypto.randomBytes(SH_AUTH_NONCE_BYTES)
  };
}

export function shadowResult(
  deviceId: string,
  keyVersion: number,
  ok: boolean,
  code: AuthV2ShadowCode
): AuthV2ShadowResult {
  return {
    type: "authV2ShadowResult",
    protocol: SH_AUTH_PROTOCOL,
    deviceId,
    keyVersion,
    ok,
    shadowOnly: true,
    code
  };
}
