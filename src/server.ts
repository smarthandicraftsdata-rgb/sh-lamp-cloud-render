import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { config } from "./config";
import { prisma } from "./db";
import { errorHandler, notFoundHandler } from "./errors";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/authRoutes";
import { homeRouter } from "./routes/homeRoutes";
import { createDeviceRouter } from "./routes/deviceRoutes";
import { createRateLimiter } from "./rateLimit";
import { WebSocketHub } from "./websocketHub";

const app = express();
const server = http.createServer(app);
const hub = new WebSocketHub();
hub.attach(server);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  const requestId = req.header("x-request-id") || crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("cache-control", "no-store");

  const origin = req.header("origin");
  const allowAll = config.allowedOrigins.includes("*");
  if (origin && (allowAll || config.allowedOrigins.includes(origin))) {
    res.setHeader("access-control-allow-origin", allowAll ? "*" : origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-headers", "authorization, content-type, x-admin-key, x-request-id");
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "64kb" }));
app.use(createRateLimiter(240, 60_000));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "SH Lamp Cloud",
    phase: "3A Render proof of concept",
    health: "/health",
    websocket: { app: "/ws/app", device: "/ws/device" }
  });
});
app.use(healthRouter);
app.use(authRouter);
app.use(homeRouter);
app.use(createDeviceRouter(hub));
app.use(notFoundHandler);
app.use(errorHandler);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function start(): Promise<void> {
  await prisma.$connect();
  await prisma.device.updateMany({ data: { online: false } });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`SH Lamp Cloud listening on 0.0.0.0:${config.port}`);
  });
}

void start().catch(async (error) => {
  console.error("Failed to start SH Lamp Cloud", error);
  await prisma.$disconnect();
  process.exit(1);
});
