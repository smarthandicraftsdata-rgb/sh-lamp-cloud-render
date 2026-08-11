import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { normalizeLampId, randomCommandId, secretsEqual, verifyAccessToken } from "./security";
import { allowedActions, createAndDispatchCommand } from "./commandService";

interface SocketMeta {
  kind: "app" | "device";
  authenticated: boolean;
  userId?: string;
  lampId?: string;
  alive: boolean;
  authTimer: NodeJS.Timeout;
}

type ManagedSocket = WebSocket & { meta?: SocketMeta };

const appAuthSchema = z.object({ type: z.literal("auth"), token: z.string().min(20) });
const deviceAuthSchema = z.object({
  type: z.literal("auth"),
  lampId: z.string(),
  deviceSecret: z.string().min(20)
});
const appCommandSchema = z.object({
  type: z.enum(["command", "liveCommand"]),
  lampId: z.string(),
  commandId: z.string().min(8).max(100).optional(),
  action: z.string().min(1).max(40),
  value: z.json().optional()
});
const deviceStateSchema = z.object({
  type: z.literal("state"),
  power: z.boolean(),
  brightness: z.number().int().min(0).max(100),
  fadeMode: z.number().int().min(0).max(20).default(0),
  timerRemaining: z.number().int().min(0).max(604800).default(0),
  firmwareVersion: z.string().max(40).optional(),
  bootId: z.number().int().nonnegative().optional(),
  bootSequence: z.number().int().nonnegative().optional(),
  stateRevision: z.number().int().nonnegative().optional(),
  batteryValid: z.boolean().optional(),
  batteryPercent: z.number().int().min(0).max(100).optional(),
  batteryInternalPercent: z.number().int().min(0).max(100).optional(),
  batteryEstimatedPercent: z.number().int().min(0).max(100).optional(),
  batteryCharging: z.boolean().optional(),
  batteryFullQualified: z.boolean().optional(),
  batteryVoltageMv: z.number().int().min(0).max(10000).optional(),
  batteryEstimatedVoltageMv: z.number().int().min(0).max(10000).optional(),
  batteryState: z.string().max(40).optional(),
  batteryProtection: z.string().max(40).optional(),
  batteryWarningActive: z.boolean().optional(),
  powerMode: z.string().max(40).optional(),
  runtimeState: z.string().max(40).optional(),
  raw: z.json().optional()
});
const deviceAckSchema = z.object({
  type: z.literal("ack"),
  commandId: z.string().min(8).max(100),
  success: z.boolean(),
  error: z.string().max(200).optional(),
  state: deviceStateSchema.omit({ type: true }).optional()
});

const latestWinsActions = ["setPower", "setBrightness", "setFadeMode", "setTimer"];
const STALE_CONTROL_AGE_MS = 6_000;

export class WebSocketHub {
  private readonly appServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  private readonly deviceServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  private readonly appSockets = new Map<string, Set<ManagedSocket>>();
  private readonly deviceSockets = new Map<string, ManagedSocket>();
  private heartbeatTimer?: NodeJS.Timeout;
  private commandRetryTimer?: NodeJS.Timeout;

  attach(server: HttpServer): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const target = url.pathname === "/ws/app" ? this.appServer : url.pathname === "/ws/device" ? this.deviceServer : null;
      if (!target) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      target.handleUpgrade(request, socket, head, (ws) => target.emit("connection", ws, request));
    });

    this.appServer.on("connection", (socket, request) => this.accept(socket as ManagedSocket, request, "app"));
    this.deviceServer.on("connection", (socket, request) => this.accept(socket as ManagedSocket, request, "device"));

    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 30_000);
    this.heartbeatTimer.unref();
    this.commandRetryTimer = setInterval(() => void this.retryUnacknowledgedCommands(), 2_000);
    this.commandRetryTimer.unref();
  }

  private accept(socket: ManagedSocket, _request: IncomingMessage, kind: "app" | "device"): void {
    const authTimer = setTimeout(() => socket.close(4003, "Authentication timeout"), 10_000);
    socket.meta = { kind, authenticated: false, alive: true, authTimer };
    socket.on("pong", () => { if (socket.meta) socket.meta.alive = true; });
    socket.on("message", (data) => void this.onMessage(socket, data.toString()));
    socket.on("close", () => void this.onClose(socket));
    socket.on("error", (error) => console.warn(`WebSocket ${kind} error`, error.message));
    this.send(socket, { type: "authRequired", connection: kind, protocolVersion: 1 });
  }

  private async onMessage(socket: ManagedSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(socket, { type: "error", code: "INVALID_JSON", message: "Message must be valid JSON" });
      return;
    }

    if (!socket.meta?.authenticated) {
      await this.authenticate(socket, parsed);
      return;
    }

    if (typeof parsed === "object" && parsed !== null && (parsed as { type?: string }).type === "heartbeat") {
      socket.meta.alive = true;
      this.send(socket, { type: "heartbeatAck", time: new Date().toISOString() });
      if (socket.meta.lampId) {
        await prisma.device.updateMany({
          where: { lampId: socket.meta.lampId },
          data: { lastSeen: new Date(), online: true }
        });
      }
      return;
    }

    if (socket.meta.kind === "app") {
      await this.handleAppMessage(socket, parsed);
    } else {
      await this.handleDeviceMessage(socket, parsed);
    }
  }

  private async authenticate(socket: ManagedSocket, parsed: unknown): Promise<void> {
    if (!socket.meta) return;
    try {
      if (socket.meta.kind === "app") {
        const body = appAuthSchema.parse(parsed);
        const token = verifyAccessToken(body.token);
        socket.meta.authenticated = true;
        socket.meta.userId = token.sub;
        clearTimeout(socket.meta.authTimer);
        const sockets = this.appSockets.get(token.sub) || new Set<ManagedSocket>();
        sockets.add(socket);
        this.appSockets.set(token.sub, sockets);
        const devices = await prisma.device.findMany({
          where: { OR: [{ ownerId: token.sub }, { home: { members: { some: { userId: token.sub } } } }] },
          include: { state: true, home: true, room: true },
          orderBy: { displayName: "asc" }
        });
        this.send(socket, {
          type: "authOk",
          connection: "app",
          userId: token.sub,
          devices: devices.map((device) => ({
            ...device,
            state: this.stateForApp(device.state)
          }))
        });
      } else {
        const body = deviceAuthSchema.parse(parsed);
        const lampId = normalizeLampId(body.lampId);
        const device = await prisma.device.findUnique({ where: { lampId }, include: { state: true } });
        if (!device || !secretsEqual(body.deviceSecret, device.deviceSecretHash)) {
          socket.close(4003, "Invalid device credentials");
          return;
        }

        this.disconnectDevice(lampId, 4002, "Replaced by a newer connection");
        socket.meta.authenticated = true;
        socket.meta.lampId = lampId;
        clearTimeout(socket.meta.authTimer);
        this.deviceSockets.set(lampId, socket);
        await prisma.device.update({
          where: { id: device.id },
          data: { online: true, lastSeen: new Date() }
        });
        this.send(socket, { type: "authOk", connection: "device", lampId, claimed: Boolean(device.ownerId) });
        await this.broadcastDeviceEvent(lampId, { type: "deviceOnline", lampId, online: true });
        await this.flushPendingCommands(lampId, device.id, socket);
      }
    } catch (error) {
      console.warn("WebSocket authentication failed", error instanceof Error ? error.message : error);
      socket.close(4003, "Authentication failed");
    }
  }

  private async handleAppMessage(socket: ManagedSocket, parsed: unknown): Promise<void> {
    try {
      const body = appCommandSchema.parse(parsed);
      if (!allowedActions.has(body.action)) {
        this.send(socket, { type: "error", code: "ACTION_NOT_ALLOWED", message: `Unsupported action: ${body.action}` });
        return;
      }
      const lampId = normalizeLampId(body.lampId);
      const device = await prisma.device.findFirst({
        where: {
          lampId,
          OR: [{ ownerId: socket.meta!.userId }, { home: { members: { some: { userId: socket.meta!.userId } } } }]
        }
      });
      if (!device) {
        this.send(socket, { type: "error", code: "DEVICE_NOT_FOUND", message: "Lamp is not accessible" });
        return;
      }

      if (body.type === "liveCommand") {
        // Slider drag traffic is intentionally ephemeral: it is forwarded over
        // the already-open device WebSocket without creating a DB row for every
        // intermediate value. The app still sends one durable final `command`
        // when the drag finishes.
        const commandId = body.commandId || randomCommandId();
        const delivered = await this.sendCommandToDevice(lampId, {
          type: "deviceCommand",
          commandId,
          action: body.action,
          value: body.value ?? null,
          expiresAt: new Date(Date.now() + 5_000).toISOString()
        });
        this.send(socket, {
          type: "commandAccepted",
          lampId,
          commandId,
          delivered,
          ephemeral: true
        });
        return;
      }

      const result = await createAndDispatchCommand({
        hub: this,
        deviceId: device.id,
        lampId,
        userId: socket.meta!.userId!,
        action: body.action,
        value: body.value as Prisma.JsonValue | undefined,
        commandId: body.commandId
      });
      this.send(socket, { type: "commandAccepted", lampId, ...result });
    } catch (error) {
      this.send(socket, {
        type: "error",
        code: "INVALID_APP_MESSAGE",
        message: error instanceof Error ? error.message : "Invalid app message"
      });
    }
  }

  private async handleDeviceMessage(socket: ManagedSocket, parsed: unknown): Promise<void> {
    const lampId = socket.meta?.lampId;
    if (!lampId) return;
    try {
      const type = typeof parsed === "object" && parsed !== null ? (parsed as { type?: string }).type : undefined;
      if (type === "state") {
        const state = deviceStateSchema.parse(parsed);
        const device = await prisma.device.update({
          where: { lampId },
          data: {
            online: true,
            lastSeen: new Date(),
            ...(state.firmwareVersion ? { firmwareVersion: state.firmwareVersion } : {}),
            state: {
              upsert: {
                create: {
                  power: state.power,
                  brightness: state.brightness,
                  fadeMode: state.fadeMode,
                  timerRemaining: state.timerRemaining,
                  rawJson: state as Prisma.InputJsonValue
                },
                update: {
                  power: state.power,
                  brightness: state.brightness,
                  fadeMode: state.fadeMode,
                  timerRemaining: state.timerRemaining,
                  rawJson: state as Prisma.InputJsonValue
                }
              }
            }
          },
          include: { state: true }
        });
        await this.broadcastDeviceEvent(lampId, {
          type: "state",
          lampId,
          online: true,
          firmwareVersion: device.firmwareVersion,
          state: this.stateForApp(device.state)
        });
        return;
      }

      if (type === "ack") {
        const ack = deviceAckSchema.parse(parsed);
        const command = await prisma.deviceCommand.findUnique({ where: { commandId: ack.commandId } });
        const device = command
          ? await prisma.device.findUnique({ where: { id: command.deviceId }, include: { state: true } })
          : await prisma.device.findUnique({ where: { lampId }, include: { state: true } });
        if (!device) return;

        if (command) {
          await prisma.deviceCommand.update({
            where: { id: command.id },
            data: {
              status: ack.success ? "ACKNOWLEDGED" : "FAILED",
              acknowledgedAt: new Date(),
              errorMessage: ack.success ? null : ack.error || "Device rejected command"
            }
          });
        }

        let persistedState = device.state;
        if (ack.state) {
          const stateData = {
            power: ack.state.power,
            brightness: ack.state.brightness,
            fadeMode: ack.state.fadeMode,
            timerRemaining: ack.state.timerRemaining,
            rawJson: ack.state as Prisma.InputJsonValue
          };
          persistedState = await prisma.deviceState.upsert({
            where: { deviceId: device.id },
            create: { deviceId: device.id, ...stateData },
            update: stateData
          });
          if (ack.state.firmwareVersion) {
            await prisma.device.update({
              where: { id: device.id },
              data: { firmwareVersion: ack.state.firmwareVersion, lastSeen: new Date(), online: true }
            });
          }
        }
        await this.broadcastDeviceEvent(lampId, {
          type: "ack",
          lampId,
          commandId: ack.commandId,
          success: ack.success,
          error: ack.error,
          ephemeral: !command,
          state: this.stateForApp(persistedState)
        });
        return;
      }

      this.send(socket, { type: "error", code: "UNKNOWN_DEVICE_MESSAGE", message: "Unsupported device message type" });
    } catch (error) {
      this.send(socket, {
        type: "error",
        code: "INVALID_DEVICE_MESSAGE",
        message: error instanceof Error ? error.message : "Invalid device message"
      });
    }
  }

  async sendCommandToDevice(lampId: string, payload: unknown): Promise<boolean> {
    const socket = this.deviceSockets.get(lampId);
    if (!socket || socket.readyState !== WebSocket.OPEN || !socket.meta?.authenticated) return false;
    this.send(socket, payload);
    return true;
  }

  disconnectDevice(lampId: string, code = 1000, reason = "Disconnected"): void {
    const existing = this.deviceSockets.get(lampId);
    if (existing) {
      this.deviceSockets.delete(lampId);
      existing.close(code, reason);
    }
  }

  private async flushPendingCommands(lampId: string, deviceId: string, socket: ManagedSocket): Promise<void> {
    const now = new Date();
    const staleControlBefore = new Date(now.getTime() - STALE_CONTROL_AGE_MS);
    // RF2 migration guard: older deployments could leave 120-second absolute
    // controls queued. Never execute those after a route handover.
    await prisma.deviceCommand.updateMany({
      where: {
        deviceId,
        status: { in: ["PENDING", "SENT"] },
        action: { in: latestWinsActions },
        createdAt: { lte: staleControlBefore }
      },
      data: { status: "EXPIRED", errorMessage: "Stale control command expired during RF2 handover protection" }
    });
    await prisma.deviceCommand.updateMany({
      where: { deviceId, status: { in: ["PENDING", "SENT"] }, expiresAt: { lte: now } },
      data: { status: "EXPIRED", errorMessage: "Command expired before device connected" }
    });
    const pending = await prisma.deviceCommand.findMany({
      where: {
        deviceId,
        expiresAt: { gt: now },
        OR: [
          { status: "PENDING" },
          {
            status: "SENT",
            action: { in: ["setPower", "setBrightness", "setFadeMode", "setTimer", "requestState"] }
          }
        ]
      },
      orderBy: { createdAt: "asc" },
      take: 20
    });
    for (const command of pending) {
      this.send(socket, {
        type: "deviceCommand",
        commandId: command.commandId,
        action: command.action,
        value: command.valueJson,
        expiresAt: command.expiresAt.toISOString()
      });
      await prisma.deviceCommand.update({
        where: { id: command.id },
        data: { status: "SENT", deliveredAt: new Date() }
      });
    }
    if (pending.length) {
      console.log(`Delivered ${pending.length} queued command(s) to ${lampId}`);
    }
  }

  private async onClose(socket: ManagedSocket): Promise<void> {
    if (!socket.meta) return;
    clearTimeout(socket.meta.authTimer);
    if (socket.meta.userId) {
      const sockets = this.appSockets.get(socket.meta.userId);
      sockets?.delete(socket);
      if (sockets?.size === 0) this.appSockets.delete(socket.meta.userId);
    }
    if (socket.meta.lampId && this.deviceSockets.get(socket.meta.lampId) === socket) {
      const lampId = socket.meta.lampId;
      this.deviceSockets.delete(lampId);
      await prisma.device.updateMany({
        where: { lampId },
        data: { online: false, lastSeen: new Date() }
      });
      await this.broadcastDeviceEvent(lampId, { type: "deviceOnline", lampId, online: false });
    }
  }

  private async broadcastDeviceEvent(lampId: string, payload: unknown): Promise<void> {
    const device = await prisma.device.findUnique({
      where: { lampId },
      select: { ownerId: true, home: { select: { members: { select: { userId: true } } } } }
    });
    if (!device) return;
    const userIds = new Set<string>();
    if (device.ownerId) userIds.add(device.ownerId);
    for (const member of device.home?.members || []) userIds.add(member.userId);
    for (const userId of userIds) {
      for (const socket of this.appSockets.get(userId) || []) this.send(socket, payload);
    }
  }

  private async retryUnacknowledgedCommands(): Promise<void> {
    const now = new Date();
    const retryBefore = new Date(now.getTime() - 5_000);
    const staleControlBefore = new Date(now.getTime() - STALE_CONTROL_AGE_MS);

    await prisma.deviceCommand.updateMany({
      where: {
        status: { in: ["PENDING", "SENT"] },
        action: { in: latestWinsActions },
        createdAt: { lte: staleControlBefore }
      },
      data: { status: "EXPIRED", errorMessage: "Stale control command expired during RF2 handover protection" }
    });

    // Expire commands even if a device stays connected forever. A SENT command
    // is not considered complete until its ACK arrives.
    await prisma.deviceCommand.updateMany({
      where: { status: { in: ["PENDING", "SENT"] }, expiresAt: { lte: now } },
      data: { status: "EXPIRED", errorMessage: "Command expired before acknowledgement" }
    });

    const retryable = await prisma.deviceCommand.findMany({
      where: {
        status: "SENT",
        expiresAt: { gt: now },
        deliveredAt: { lte: retryBefore },
        action: { in: ["setPower", "setBrightness", "setFadeMode", "setTimer", "requestState"] }
      },
      include: { device: { select: { lampId: true } } },
      orderBy: { deliveredAt: "asc" },
      take: 50
    });

    for (const command of retryable) {
      const socket = this.deviceSockets.get(command.device.lampId);
      if (!socket || socket.readyState !== WebSocket.OPEN || !socket.meta?.authenticated) continue;
      this.send(socket, {
        type: "deviceCommand",
        commandId: command.commandId,
        action: command.action,
        value: command.valueJson,
        expiresAt: command.expiresAt.toISOString()
      });
      await prisma.deviceCommand.updateMany({
        where: { id: command.id, status: "SENT" },
        data: { deliveredAt: new Date(), errorMessage: null }
      });
    }
  }

  private checkHeartbeats(): void {
    const sockets = [...this.appServer.clients, ...this.deviceServer.clients] as ManagedSocket[];
    for (const socket of sockets) {
      if (!socket.meta) continue;
      if (!socket.meta.alive) {
        socket.terminate();
        continue;
      }
      socket.meta.alive = false;
      socket.ping();
    }
  }

  private stateForApp(state: {
    power: boolean;
    brightness: number;
    fadeMode: number;
    timerRemaining: number;
    rawJson: Prisma.JsonValue | null;
    updatedAt: Date;
  } | null): unknown {
    if (!state) return null;
    const raw = state.rawJson && typeof state.rawJson === "object" && !Array.isArray(state.rawJson)
      ? state.rawJson as Record<string, unknown>
      : {};
    const nestedRaw = raw.raw && typeof raw.raw === "object" && !Array.isArray(raw.raw)
      ? raw.raw as Record<string, unknown>
      : {};
    const pick = (key: string): unknown => raw[key] ?? nestedRaw[key];

    return {
      power: state.power,
      brightness: state.brightness,
      fadeMode: state.fadeMode,
      timerRemaining: state.timerRemaining,
      updatedAt: state.updatedAt,
      bootId: pick("bootId"),
      bootSequence: pick("bootSequence"),
      stateRevision: pick("stateRevision"),
      batteryValid: pick("batteryValid"),
      batteryPercent: pick("batteryPercent"),
      batteryInternalPercent: pick("batteryInternalPercent"),
      batteryEstimatedPercent: pick("batteryEstimatedPercent"),
      batteryCharging: pick("batteryCharging"),
      batteryFullQualified: pick("batteryFullQualified"),
      batteryVoltageMv: pick("batteryVoltageMv"),
      batteryEstimatedVoltageMv: pick("batteryEstimatedVoltageMv"),
      batteryState: pick("batteryState"),
      batteryProtection: pick("batteryProtection"),
      batteryWarningActive: pick("batteryWarningActive"),
      powerMode: pick("powerMode"),
      runtimeState: pick("runtimeState"),
      raw
    };
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }
}
