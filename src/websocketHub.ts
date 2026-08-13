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
  deviceId?: string;
  generation?: number;
  alive: boolean;
  authTimer: NodeJS.Timeout;
  accessibleLampIds?: Map<string, { deviceId: string; checkedAt: number }>;
}

type ManagedSocket = WebSocket & { meta?: SocketMeta };
type DeviceTarget = { socket: ManagedSocket; generation: number };
type LiveFrameSlot = DeviceTarget & { payload: unknown; commandId: string };
type PersistedStateSlot = {
  deviceId: string;
  lampId: string;
  generation: number;
  state: z.infer<typeof deviceStateSchema>;
};
type CommandContext = {
  commandDbId: string;
  commandId: string;
  deviceId: string;
  lampId: string;
  userId: string;
  expiresAt: number;
  registeredAt: number;
};

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
  rememberedBrightness: z.number().int().min(1).max(100).optional(),
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
  applied: z.boolean().optional(),
  duplicate: z.boolean().optional(),
  ignoredReason: z.string().max(80).optional(),
  error: z.string().max(200).optional(),
  state: deviceStateSchema.omit({ type: true }).optional()
});

const latestWinsActions = ["toggle", "setOutputState", "setPower", "setBrightness", "setFadeMode", "setTimer"];
const STALE_CONTROL_AGE_MS = 2_000;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;
const DEVICE_SEND_CALLBACK_BUDGET_MS = 300;
const APP_ACCESS_CACHE_TTL_MS = 10_000;

function objectValue(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stateOrderFromRaw(value: Prisma.JsonValue | null | undefined): { bootId?: number; bootSequence?: number; revision?: number } {
  const raw = objectValue(value);
  const nested = objectValue(raw.raw as Prisma.JsonValue | undefined);
  return {
    bootId: numeric(raw.bootId ?? raw.stateBootId ?? nested.bootId ?? nested.stateBootId),
    bootSequence: numeric(raw.bootSequence ?? raw.stateBootSequence ?? nested.bootSequence ?? nested.stateBootSequence),
    revision: numeric(raw.stateRevision ?? raw.revision ?? nested.stateRevision ?? nested.revision)
  };
}

function shouldAcceptState(currentRaw: Prisma.JsonValue | null | undefined, incoming: Record<string, unknown>): boolean {
  const current = stateOrderFromRaw(currentRaw);
  const incomingOrder = stateOrderFromRaw(incoming as Prisma.JsonValue);
  if (current.bootSequence === undefined || current.revision === undefined ||
      incomingOrder.bootSequence === undefined || incomingOrder.revision === undefined) return true;
  if (incomingOrder.bootSequence > current.bootSequence) return true;
  if (incomingOrder.bootSequence < current.bootSequence) return false;
  if (current.bootId !== undefined && incomingOrder.bootId !== undefined && current.bootId !== incomingOrder.bootId) return false;
  return incomingOrder.revision >= current.revision;
}

export class WebSocketHub {
  private readonly appServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  private readonly deviceServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  private readonly appSockets = new Map<string, Set<ManagedSocket>>();
  private readonly deviceSockets = new Map<string, ManagedSocket>();
  private readonly deviceGenerationCounters = new Map<string, number>();
  // Durable sends and incoming device messages are serialized per socket
  // generation. An old generation can never hold or redirect work for a new
  // authenticated socket.
  private readonly deviceMessageChains = new Map<string, Promise<void>>();
  // RF5.4.1: network ACK delivery is decoupled from secondary Prisma writes.
  // Device state persistence is one in-flight snapshot + one replaceable latest
  // slot per physical lamp. A DB slowdown therefore cannot build an unbounded
  // state queue behind the realtime command path.
  private readonly pendingStatePersistence = new Map<string, PersistedStateSlot>();
  private readonly statePersistenceRunning = new Set<string>();
  private readonly commandContexts = new Map<string, CommandContext>();
  private static readonly MAX_COMMAND_CONTEXTS = 2048;
  // Live slider traffic has exactly one in-flight frame plus one replaceable
  // pending slot per lamp. It cannot build an unbounded queue behind durable
  // controls.
  private readonly liveFrameSlots = new Map<string, LiveFrameSlot>();
  private readonly liveDrainRunning = new Set<string>();
  // RF5.3: remember short-lived slider command IDs so ACKs from older RF5
  // firmware can be discarded without Prisma writes. New RF5.3 firmware does
  // not ACK ephemeral frames at all, but this keeps a mixed deployment safe.
  private readonly ephemeralCommands = new Map<string, { lampId: string; expiresAt: number }>();
  private readonly ephemeralStateSuppressUntil = new Map<string, number>();
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
      await this.enqueueDeviceMessage(socket, parsed);
    }
  }

  private async enqueueDeviceMessage(socket: ManagedSocket, parsed: unknown): Promise<void> {
    const lampId = socket.meta?.lampId;
    const generation = socket.meta?.generation;
    if (!lampId || generation === undefined) return;
    const lane = this.deviceLaneKey(lampId, generation);
    const previous = this.deviceMessageChains.get(lane) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        // A replaced/old socket must never mutate state after a newer device
        // connection has taken ownership of the lamp ID.
        if (this.deviceSockets.get(lampId) !== socket ||
            socket.meta?.generation !== generation ||
            socket.readyState !== WebSocket.OPEN) return;
        await this.handleDeviceMessage(socket, parsed);
      });
    this.deviceMessageChains.set(lane, next);
    try {
      await next;
    } finally {
      if (this.deviceMessageChains.get(lane) === next) this.deviceMessageChains.delete(lane);
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
        // RF5.3: authorization for the lamps visible at authentication time is
        // cached on this authenticated socket. Slider liveCommand frames no
        // longer perform one Prisma authorization query per finger movement.
        const checkedAt = Date.now();
        socket.meta.accessibleLampIds = new Map(devices.map((device) => [
          normalizeLampId(device.lampId),
          { deviceId: device.id, checkedAt }
        ]));
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
        const generation = (this.deviceGenerationCounters.get(lampId) || 0) + 1;
        this.deviceGenerationCounters.set(lampId, generation);
        socket.meta.authenticated = true;
        socket.meta.lampId = lampId;
        socket.meta.deviceId = device.id;
        socket.meta.generation = generation;
        clearTimeout(socket.meta.authTimer);
        this.deviceSockets.set(lampId, socket);
        console.log(`RF5.4.1 CLOUD device_auth lamp=${lampId} generation=${generation}`);
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

  private async ensureAppAccess(socket: ManagedSocket, lampId: string): Promise<string | undefined> {
    const userId = socket.meta?.userId;
    if (!userId) return undefined;
    const now = Date.now();
    const cached = socket.meta?.accessibleLampIds?.get(lampId);
    if (cached && now - cached.checkedAt <= APP_ACCESS_CACHE_TTL_MS) return cached.deviceId;

    const device = await prisma.device.findFirst({
      where: {
        lampId,
        OR: [{ ownerId: userId }, { home: { members: { some: { userId } } } }]
      },
      select: { id: true }
    });
    if (!device) {
      socket.meta?.accessibleLampIds?.delete(lampId);
      return undefined;
    }
    if (!socket.meta!.accessibleLampIds) socket.meta!.accessibleLampIds = new Map();
    socket.meta!.accessibleLampIds!.set(lampId, { deviceId: device.id, checkedAt: now });
    return device.id;
  }

  private async handleAppMessage(socket: ManagedSocket, parsed: unknown): Promise<void> {
    try {
      const body = appCommandSchema.parse(parsed);
      if (!allowedActions.has(body.action)) {
        this.send(socket, { type: "error", code: "ACTION_NOT_ALLOWED", message: `Unsupported action: ${body.action}` });
        return;
      }
      const lampId = normalizeLampId(body.lampId);
      const deviceId = await this.ensureAppAccess(socket, lampId);
      if (!deviceId) {
        this.send(socket, { type: "error", code: "DEVICE_NOT_FOUND", message: "Lamp is not accessible" });
        return;
      }

      if (body.type === "liveCommand") {
        // Slider drag traffic is intentionally ephemeral. It gets one in-flight
        // frame and one replaceable latest slot per lamp, never a FIFO backlog.
        const commandId = body.commandId || randomCommandId();
        const now = Date.now();
        if (this.ephemeralCommands.size >= 1024) {
          for (const [id, item] of this.ephemeralCommands) {
            if (item.expiresAt <= now) this.ephemeralCommands.delete(id);
          }
          while (this.ephemeralCommands.size >= 1024) {
            const oldest = this.ephemeralCommands.keys().next().value as string | undefined;
            if (!oldest) break;
            this.ephemeralCommands.delete(oldest);
          }
        }
        this.ephemeralCommands.set(commandId, { lampId, expiresAt: now + 5_000 });
        const expiresAt = now + 1_500;
        const delivered = await this.queueLiveCommandToDevice(lampId, commandId, {
          type: "deviceCommand",
          commandId,
          action: body.action,
          value: body.value ?? null,
          ephemeral: true,
          expiresAt: new Date(expiresAt).toISOString(),
          expiresAtEpochSec: Math.floor(expiresAt / 1000)
        });
        if (!delivered) this.ephemeralCommands.delete(commandId);
        this.send(socket, {
          type: "commandAccepted",
          lampId,
          commandId,
          delivered,
          ephemeral: true
        });
        return;
      }

      console.log(`RF5.4.1 CMD app_rx id=${body.commandId || "server"} lamp=${lampId} action=${body.action}`);
      const result = await createAndDispatchCommand({
        hub: this,
        deviceId,
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
    const deviceId = socket.meta?.deviceId;
    const generation = socket.meta?.generation;
    if (!lampId || !deviceId || generation === undefined) return;
    try {
      const type = typeof parsed === "object" && parsed !== null ? (parsed as { type?: string }).type : undefined;

      if (type === "state") {
        const state = deviceStateSchema.parse(parsed);
        const suppressUntil = this.ephemeralStateSuppressUntil.get(lampId) || 0;
        if (suppressUntil > Date.now()) return;
        if (suppressUntil) this.ephemeralStateSuppressUntil.delete(lampId);

        // Do not make the socket receive lane wait for PostgreSQL. State writes
        // remain ordered on a separate per-lamp persistence lane.
        this.queueLatestDeviceState(deviceId, lampId, generation, state);
        return;
      }

      if (type === "ack") {
        const ack = deviceAckSchema.parse(parsed);
        await this.handleDeviceAckFast(socket, lampId, deviceId, ack);
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

  /**
   * Register the durable command immediately before dispatch. This bounded
   * in-memory index lets a normal device ACK be validated and delivered to the
   * issuing user's /ws/app socket without a command lookup or state persistence
   * round-trip first. The database row already exists before this is called.
   */
  registerCommandContext(context: Omit<CommandContext, "registeredAt">): void {
    const now = Date.now();
    this.pruneCommandContexts(now);
    while (this.commandContexts.size >= WebSocketHub.MAX_COMMAND_CONTEXTS) {
      const oldest = this.commandContexts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.commandContexts.delete(oldest);
    }
    this.commandContexts.set(context.commandId, { ...context, registeredAt: now });
  }

  private pruneCommandContexts(now = Date.now()): void {
    for (const [commandId, context] of this.commandContexts) {
      if (context.expiresAt + 30_000 < now || context.registeredAt + 120_000 < now) {
        this.commandContexts.delete(commandId);
      }
    }
  }

  private sendToUser(userId: string, payload: unknown): void {
    for (const appSocket of this.appSockets.get(userId) || []) this.send(appSocket, payload);
  }

  private queueLatestDeviceState(
    deviceId: string,
    lampId: string,
    generation: number,
    state: z.infer<typeof deviceStateSchema>
  ): void {
    // Replace any not-yet-started state snapshot. The ESP stateRevision/boot
    // epoch still guards the actual DB write, so dropping an obsolete middle
    // snapshot cannot change the final authoritative lamp state.
    this.pendingStatePersistence.set(lampId, { deviceId, lampId, generation, state });
    if (this.statePersistenceRunning.has(lampId)) return;
    this.statePersistenceRunning.add(lampId);
    void this.drainLatestDeviceState(lampId);
  }

  private async drainLatestDeviceState(lampId: string): Promise<void> {
    try {
      while (true) {
        const slot = this.pendingStatePersistence.get(lampId);
        if (!slot) return;
        this.pendingStatePersistence.delete(lampId);
        try {
          await this.persistDeviceState(slot.deviceId, slot.lampId, slot.generation, slot.state);
        } catch (error) {
          console.error(`RF5.4.1 state persistence failed lamp=${lampId}`, error instanceof Error ? error.message : error);
        }
      }
    } finally {
      this.statePersistenceRunning.delete(lampId);
      if (this.pendingStatePersistence.has(lampId) && !this.statePersistenceRunning.has(lampId)) {
        this.statePersistenceRunning.add(lampId);
        void this.drainLatestDeviceState(lampId);
      }
    }
  }

  private async persistDeviceState(
    deviceId: string,
    lampId: string,
    generation: number,
    state: z.infer<typeof deviceStateSchema>
  ): Promise<void> {
    // If a newer authenticated device generation has already replaced this
    // message's socket, the old generation is no longer allowed to mutate
    // persisted/current state. This closes the async DB-after-replacement race.
    const currentSocketBeforeDB = this.deviceSockets.get(lampId);
    if (currentSocketBeforeDB && currentSocketBeforeDB.meta?.generation !== generation) return;

    const currentDevice = await prisma.device.findUnique({ where: { id: deviceId }, include: { state: true } });
    if (!currentDevice || normalizeLampId(currentDevice.lampId) !== lampId) return;
    const currentSocket = this.deviceSockets.get(lampId);
    if (currentSocket && currentSocket.meta?.generation !== generation) return;
    const generationStillCurrent = currentSocket?.meta?.generation === generation &&
      currentSocket.readyState === WebSocket.OPEN && currentSocket.meta?.authenticated === true;
    if (!shouldAcceptState(currentDevice.state?.rawJson, state as unknown as Record<string, unknown>)) {
      await prisma.device.updateMany({
        where: { id: deviceId },
        data: { lastSeen: new Date(), ...(generationStillCurrent ? { online: true } : {}) }
      });
      return;
    }

    const persistedState = await prisma.deviceState.upsert({
      where: { deviceId },
      create: {
        deviceId,
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
    });
    const updatedDevice = await prisma.device.update({
      where: { id: deviceId },
      data: {
        lastSeen: new Date(),
        ...(generationStillCurrent ? { online: true } : {}),
        ...(state.firmwareVersion ? { firmwareVersion: state.firmwareVersion } : {})
      }
    });
    await this.broadcastDeviceEvent(lampId, {
      type: "state",
      lampId,
      online: generationStillCurrent,
      firmwareVersion: updatedDevice.firmwareVersion,
      state: this.stateForApp(persistedState)
    });
  }

  private async handleDeviceAckFast(
    socket: ManagedSocket,
    lampId: string,
    deviceId: string,
    ack: z.infer<typeof deviceAckSchema>
  ): Promise<void> {
    const receivedAt = Date.now();
    const ephemeral = this.ephemeralCommands.get(ack.commandId);
    if (ephemeral) {
      if (ephemeral.lampId !== lampId) {
        this.ephemeralCommands.delete(ack.commandId);
        this.send(socket, {
          type: "error",
          code: "WRONG_DEVICE_EPHEMERAL_ACK",
          message: "ephemeral commandId belongs to a different lamp"
        });
        return;
      }
      this.ephemeralCommands.delete(ack.commandId);
      this.ephemeralStateSuppressUntil.set(lampId, receivedAt + 350);
      return;
    }

    let context = this.commandContexts.get(ack.commandId);
    let fallbackCommand: {
      id: string; commandId: string; deviceId: string; userId: string | null; expiresAt: Date; createdAt: Date;
    } | null = null;
    if (!context) {
      // Render restart / old pending command fallback. Normal RF5.4.1 traffic
      // uses the in-memory context and performs zero Prisma reads before ACK.
      fallbackCommand = await prisma.deviceCommand.findUnique({
        where: { commandId: ack.commandId },
        select: { id: true, commandId: true, deviceId: true, userId: true, expiresAt: true, createdAt: true }
      });
      if (fallbackCommand) {
        context = {
          commandDbId: fallbackCommand.id,
          commandId: fallbackCommand.commandId,
          deviceId: fallbackCommand.deviceId,
          lampId,
          userId: fallbackCommand.userId || "",
          expiresAt: fallbackCommand.expiresAt.getTime(),
          registeredAt: fallbackCommand.createdAt.getTime()
        };
      }
    }

    // The fallback lookup above may have yielded the Node event loop. Confirm
    // this is still the authoritative socket generation before forwarding.
    if (this.deviceSockets.get(lampId) !== socket || socket.meta?.generation === undefined ||
        this.deviceSockets.get(lampId)?.meta?.generation !== socket.meta.generation) return;

    if (!context) {
      // Unknown ACK: never broadcast it to arbitrary users. It may be from an
      // already-pruned duplicate after a very old reconnect.
      console.warn(`RF5.4.1 unknown ACK id=${ack.commandId} lamp=${lampId}`);
      return;
    }
    if (context.deviceId !== deviceId || context.lampId !== lampId) {
      this.send(socket, { type: "error", code: "WRONG_DEVICE_ACK", message: "commandId belongs to a different lamp" });
      console.warn(`Rejected wrong-device ACK ${ack.commandId} from ${lampId}`);
      return;
    }

    const fastPayload = {
      type: "ack",
      lampId,
      commandId: ack.commandId,
      success: ack.success,
      applied: ack.applied,
      duplicate: ack.duplicate,
      ignoredReason: ack.ignoredReason,
      error: ack.error,
      ephemeral: false,
      state: ack.state
    };
    if (context.userId) this.sendToUser(context.userId, fastPayload);
    console.log(`RF5.4.1 CMD ack_forward id=${ack.commandId} lamp=${lampId} generation=${socket.meta?.generation ?? -1} db_wait=0ms rx_to_app=${Date.now() - receivedAt}ms success=${ack.success} duplicate=${ack.duplicate ?? false}`);

    // The issuing app is already complete. Persist command status immediately
    // and independently so a simultaneous REST hedge can observe ACKNOWLEDGED
    // even if state persistence is slow. State itself goes through the bounded
    // latest-only slot above.
    const capturedContext = context;
    const statusPersistStartedAt = Date.now();
    void prisma.deviceCommand.updateMany({
      where: { id: capturedContext.commandDbId, status: { in: ["PENDING", "SENT"] } },
      data: {
        status: ack.success ? "ACKNOWLEDGED" : "FAILED",
        acknowledgedAt: new Date(),
        errorMessage: ack.success ? null : ack.error || "Device rejected command"
      }
    }).then(() => {
      console.log(`RF5.4.1 CMD ack_status_persist id=${ack.commandId} lamp=${lampId} db_total=${Date.now() - statusPersistStartedAt}ms`);
    }).catch((error) => {
      console.error(`RF5.4.1 command ACK persistence failed id=${ack.commandId} lamp=${lampId}`, error instanceof Error ? error.message : error);
    }).finally(() => {
      if (this.commandContexts.get(ack.commandId) === capturedContext) this.commandContexts.delete(ack.commandId);
    });

    if (ack.state) {
      this.queueLatestDeviceState(deviceId, lampId, socket.meta!.generation!, { type: "state", ...ack.state });
    } else {
      void prisma.device.updateMany({
        where: { id: deviceId },
        data: { online: true, lastSeen: new Date() }
      }).catch((error) => {
        console.error(`RF5.4.1 device touch failed lamp=${lampId}`, error instanceof Error ? error.message : error);
      });
    }

  }

  private deviceLaneKey(lampId: string, generation: number): string {
    return `${lampId}#${generation}`;
  }

  private currentDeviceTarget(lampId: string): DeviceTarget | undefined {
    const socket = this.deviceSockets.get(lampId);
    const generation = socket?.meta?.generation;
    if (!socket || generation === undefined || socket.readyState !== WebSocket.OPEN || !socket.meta?.authenticated) return undefined;
    return { socket, generation };
  }

  async sendCommandToDevice(lampId: string, payload: unknown): Promise<boolean> {
    const target = this.currentDeviceTarget(lampId);
    if (!target) return false;
    return await this.sendCommandToBoundTarget(lampId, target, payload);
  }

  private async sendCommandToBoundTarget(lampId: string, target: DeviceTarget, payload: unknown): Promise<boolean> {
    // RF5.4 deliberately has no durable per-lamp send promise chain here.
    // WebSocket.send() calls are issued immediately on the Node event loop; ws
    // preserves frame order for a socket, while each callback has its own
    // bounded health budget. A sick send callback therefore cannot freeze newer
    // commands behind it. Generation binding still prevents zombie-socket use.
    return await this.sendDeviceFrameNow(lampId, target.socket, target.generation, payload);
  }

  private async queueLiveCommandToDevice(lampId: string, commandId: string, payload: unknown): Promise<boolean> {
    const target = this.currentDeviceTarget(lampId);
    if (!target) return false;

    const replaced = this.liveFrameSlots.get(lampId);
    if (replaced) this.ephemeralCommands.delete(replaced.commandId);
    this.liveFrameSlots.set(lampId, { ...target, payload, commandId });
    if (!this.liveDrainRunning.has(lampId)) {
      this.liveDrainRunning.add(lampId);
      void this.drainLiveFrames(lampId);
    }
    return true;
  }

  private async drainLiveFrames(lampId: string): Promise<void> {
    try {
      while (true) {
        const slot = this.liveFrameSlots.get(lampId);
        if (!slot) return;
        this.liveFrameSlots.delete(lampId);
        const delivered = await this.sendDeviceFrameNow(lampId, slot.socket, slot.generation, slot.payload);
        if (!delivered) this.ephemeralCommands.delete(slot.commandId);
      }
    } finally {
      this.liveDrainRunning.delete(lampId);
      // A slot cannot normally appear between the final map read and this
      // synchronous finally block, but keep this restart guard for clarity.
      if (this.liveFrameSlots.has(lampId) && !this.liveDrainRunning.has(lampId)) {
        this.liveDrainRunning.add(lampId);
        void this.drainLiveFrames(lampId);
      }
    }
  }

  private async sendDeviceFrameNow(
    lampId: string,
    socket: ManagedSocket,
    generation: number,
    payload: unknown
  ): Promise<boolean> {
    if (this.deviceSockets.get(lampId) !== socket ||
        socket.meta?.generation !== generation ||
        socket.readyState !== WebSocket.OPEN ||
        !socket.meta?.authenticated) return false;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      console.warn(`Device ${lampId} generation ${generation} WebSocket backpressure: ${socket.bufferedAmount} buffered bytes`);
      return false;
    }
    const text = JSON.stringify(payload);
    const info = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const commandId = typeof info.commandId === "string" ? info.commandId : "-";
    const action = typeof info.action === "string" ? info.action : "-";
    const startedAt = Date.now();

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        console.warn(`RF5.4.1 CMD device_send_timeout id=${commandId} lamp=${lampId} action=${action} generation=${generation} buffered=${socket.bufferedAmount}`);
        finish(false);
      }, DEVICE_SEND_CALLBACK_BUDGET_MS);
      try {
        socket.send(text, (error) => {
          if (error) {
            console.warn(`Device ${lampId} generation ${generation} WebSocket send failed`, error.message);
            finish(false);
            return;
          }
          if (commandId !== "-") {
            console.log(`RF5.4.1 CMD device_send id=${commandId} lamp=${lampId} action=${action} generation=${generation} accepted=${Date.now() - startedAt}ms bytes=${Buffer.byteLength(text)}`);
          }
          finish(true);
        });
      } catch (error) {
        console.warn(`Device ${lampId} generation ${generation} WebSocket send threw`, error instanceof Error ? error.message : error);
        finish(false);
      }
    });
  }

  disconnectDevice(lampId: string, code = 1000, reason = "Disconnected"): void {
    const existing = this.deviceSockets.get(lampId);
    if (existing) {
      this.deviceSockets.delete(lampId);
      existing.close(code, reason);
    }
  }

  private async flushPendingCommands(lampId: string, deviceId: string, socket: ManagedSocket): Promise<void> {
    const generation = socket.meta?.generation;
    if (generation === undefined) return;
    const target: DeviceTarget = { socket, generation };
    const now = new Date();
    const staleControlBefore = new Date(now.getTime() - STALE_CONTROL_AGE_MS);
    // RF2 migration guard: older deployments could leave long-lived absolute
    // controls queued. Never execute those after a route handover.
    await prisma.deviceCommand.updateMany({
      where: {
        deviceId,
        status: { in: ["PENDING", "SENT"] },
        action: { in: latestWinsActions },
        createdAt: { lte: staleControlBefore }
      },
      data: { status: "EXPIRED", errorMessage: "Stale control command expired during handover protection" }
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
          { status: "SENT", action: { in: ["toggle", "setOutputState", "setPower", "setBrightness", "setFadeMode", "setTimer", "requestState"] } }
        ]
      },
      orderBy: { createdAt: "asc" },
      take: 20
    });
    let deliveredCount = 0;
    for (const command of pending) {
      if (this.deviceSockets.get(lampId) !== socket || socket.meta?.generation !== generation) break;
      const delivered = await this.sendCommandToBoundTarget(lampId, target, {
        type: "deviceCommand",
        commandId: command.commandId,
        action: command.action,
        value: command.valueJson,
        expiresAt: command.expiresAt.toISOString(),
        expiresAtEpochSec: Math.floor(command.expiresAt.getTime() / 1000)
      });
      if (!delivered) break;
      deliveredCount += 1;
      await prisma.deviceCommand.updateMany({
        where: { id: command.id, status: { in: ["PENDING", "SENT"] } },
        data: { status: "SENT", deliveredAt: new Date(), errorMessage: null }
      });
    }
    if (deliveredCount) {
      console.log(`RF5.4.1 CLOUD flushed=${deliveredCount} lamp=${lampId} generation=${generation}`);
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
    if (socket.meta.lampId) {
      const lampId = socket.meta.lampId;
      const generation = socket.meta.generation;
      if (generation !== undefined) {
        const lane = this.deviceLaneKey(lampId, generation);
        this.deviceMessageChains.delete(lane);
        const live = this.liveFrameSlots.get(lampId);
        if (live && live.generation === generation) {
          this.liveFrameSlots.delete(lampId);
          this.ephemeralCommands.delete(live.commandId);
        }
      }

      // Only the current authoritative generation may publish OFFLINE. A stale
      // socket closing after it was replaced cannot flip the new session down.
      if (this.deviceSockets.get(lampId) === socket) {
        this.deviceSockets.delete(lampId);
        console.log(`RF5.4.1 CLOUD device_close lamp=${lampId} generation=${generation ?? -1}`);
        await prisma.device.updateMany({
          where: { lampId },
          data: { online: false, lastSeen: new Date() }
        });
        await this.broadcastDeviceEvent(lampId, { type: "deviceOnline", lampId, online: false });
      }
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
    const retryBefore = new Date(now.getTime() - 2_500);
    const staleControlBefore = new Date(now.getTime() - STALE_CONTROL_AGE_MS);

    await prisma.deviceCommand.updateMany({
      where: {
        status: { in: ["PENDING", "SENT"] },
        action: { in: latestWinsActions },
        createdAt: { lte: staleControlBefore }
      },
      data: { status: "EXPIRED", errorMessage: "Stale control command expired during handover protection" }
    });

    // Expire commands even if a device stays connected forever. App-side RF5.4
    // hedging retries controls with the SAME command ID within the 2-second TTL;
    // the backend must not add a hidden 5-second control retry loop on top.
    await prisma.deviceCommand.updateMany({
      where: { status: { in: ["PENDING", "SENT"] }, expiresAt: { lte: now } },
      data: { status: "EXPIRED", errorMessage: "Command expired before acknowledgement" }
    });

    // Only requestState has a long enough TTL to benefit from a backend retry.
    const retryable = await prisma.deviceCommand.findMany({
      where: {
        status: "SENT",
        expiresAt: { gt: now },
        deliveredAt: { lte: retryBefore },
        action: "requestState"
      },
      include: { device: { select: { lampId: true } } },
      orderBy: { deliveredAt: "asc" },
      take: 20
    });

    for (const command of retryable) {
      const delivered = await this.sendCommandToDevice(command.device.lampId, {
        type: "deviceCommand",
        commandId: command.commandId,
        action: command.action,
        value: command.valueJson,
        expiresAt: command.expiresAt.toISOString(),
        expiresAtEpochSec: Math.floor(command.expiresAt.getTime() / 1000)
      });
      if (!delivered) continue;
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
      rememberedBrightness: pick("rememberedBrightness") ?? pick("lastBrightness"),
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
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      console.warn(`WebSocket backpressure: ${socket.bufferedAmount} buffered bytes; dropping non-command frame`);
      return;
    }
    try {
      socket.send(JSON.stringify(payload), (error) => {
        if (error) console.warn("WebSocket send failed", error.message);
      });
    } catch (error) {
      console.warn("WebSocket send threw", error instanceof Error ? error.message : error);
    }
  }
}
