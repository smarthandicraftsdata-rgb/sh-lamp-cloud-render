import { z } from "zod";

const booleanText = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  DATABASE_URL: z.string().min(1),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  ADMIN_SETUP_KEY: z.string().min(24),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(14).default(10),
  CORS_ORIGINS: z.string().default("*"),
  COMMAND_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  PASSWORD_RESET_DEBUG_RETURN_TOKEN: booleanText,
  RESEND_API_KEY: z.string().min(10).optional(),
  PASSWORD_RESET_FROM_EMAIL: z.string().min(3).optional(),
  SHADOW_AUTH_ENABLED: booleanText,
  DEVICE_CREDENTIAL_MASTER_KEY_B64: z.string().min(1).optional(),
  DEVICE_CREDENTIAL_WRAPPING_KEY_VERSION: z.coerce.number().int().min(1).max(65535).default(1)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  throw new Error("Environment validation failed");
}

const allowedOrigins = parsed.data.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

let deviceCredentialMasterKey: Buffer | null = null;
if (parsed.data.DEVICE_CREDENTIAL_MASTER_KEY_B64) {
  deviceCredentialMasterKey = Buffer.from(parsed.data.DEVICE_CREDENTIAL_MASTER_KEY_B64.trim(), "base64");
  if (deviceCredentialMasterKey.length !== 32) {
    throw new Error("DEVICE_CREDENTIAL_MASTER_KEY_B64 must decode to exactly 32 bytes");
  }
}
if (parsed.data.SHADOW_AUTH_ENABLED && !deviceCredentialMasterKey) {
  throw new Error("SHADOW_AUTH_ENABLED=true requires DEVICE_CREDENTIAL_MASTER_KEY_B64");
}

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL,
  accessTokenSecret: parsed.data.ACCESS_TOKEN_SECRET,
  adminSetupKey: parsed.data.ADMIN_SETUP_KEY,
  accessTokenTtlSeconds: parsed.data.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlDays: parsed.data.REFRESH_TOKEN_TTL_DAYS,
  bcryptRounds: parsed.data.BCRYPT_ROUNDS,
  allowedOrigins,
  commandTtlSeconds: parsed.data.COMMAND_TTL_SECONDS,
  passwordResetTokenTtlMinutes: parsed.data.PASSWORD_RESET_TOKEN_TTL_MINUTES,
  passwordResetDebugReturnToken: parsed.data.PASSWORD_RESET_DEBUG_RETURN_TOKEN,
  resendApiKey: parsed.data.RESEND_API_KEY,
  passwordResetFromEmail: parsed.data.PASSWORD_RESET_FROM_EMAIL,
  shadowAuthEnabled: parsed.data.SHADOW_AUTH_ENABLED,
  deviceCredentialMasterKey,
  deviceCredentialWrappingKeyVersion: parsed.data.DEVICE_CREDENTIAL_WRAPPING_KEY_VERSION
} as const;
