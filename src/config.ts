import { z } from "zod";

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
  COMMAND_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(120)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  throw new Error("Environment validation failed");
}

const allowedOrigins = parsed.data.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

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
  commandTtlSeconds: parsed.data.COMMAND_TTL_SECONDS
} as const;
