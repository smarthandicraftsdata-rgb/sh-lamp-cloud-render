import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { config } from "./config";
import { randomCommandId } from "./security";
import type { WebSocketHub } from "./websocketHub";

// RF5.4 command domains. Toggle belongs to the output domain too: an old
// queued toggle must never survive a newer absolute output command.
const latestWinsGroups: string[][] = [
  ["toggle", "setOutputState", "setPower", "setBrightness"],
  ["setFadeMode"],
  ["setTimer"]
];
const latestWinsActions = new Set(latestWinsGroups.flat());
const REALTIME_CONTROL_TTL_MS = 2_000;
const REQUEST_STATE_TTL_MS = 10_000;
const MAX_DEVICE_INGRESS_QUEUE = 64;

// Only the short DB prepare phase is serialized per device. A slow/dead device
// WebSocket MUST NOT hold this lane while waiting for its send callback: newer
// intents must be able to reach the backend and supersede older DB state.
const deviceIngressChains = new Map<string, Promise<void>>();
const deviceIngressDepth = new Map<string, number>();

// A /ws/app request and its REST semantic-ACK hedge can submit the exact same
// command concurrently. Coalesce only that identical command ID. Different
// commands are deliberately NOT put behind one global/per-lamp network lock.
const commandDispatches = new Map<string, Promise<DispatchResult>>();

function ttlMsForAction(action: string): number {
  if (latestWinsActions.has(action)) return Math.min(config.commandTtlSeconds * 1000, REALTIME_CONTROL_TTL_MS);
  if (action === "requestState") return Math.min(config.commandTtlSeconds * 1000, REQUEST_STATE_TTL_MS);
  return Math.min(config.commandTtlSeconds * 1000, REALTIME_CONTROL_TTL_MS);
}

function supersededActions(action: string): string[] {
  return latestWinsGroups.find((group) => group.includes(action)) || [action];
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function commandPayload(commandId: string, action: string, value: unknown, expiresAt: Date) {
  return {
    type: "deviceCommand",
    commandId,
    action,
    value: value ?? null,
    expiresAt: expiresAt.toISOString(),
    // Device-side deadline closes the final TTL hole after a frame has already
    // entered TCP. Epoch seconds avoid ISO parsing on the ESP32.
    expiresAtEpochSec: Math.floor(expiresAt.getTime() / 1000)
  };
}

async function withDeviceIngressLane<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
  const depth = (deviceIngressDepth.get(deviceId) || 0) + 1;
  if (depth > MAX_DEVICE_INGRESS_QUEUE) throw new Error("Too many commands are already being submitted for this lamp");
  deviceIngressDepth.set(deviceId, depth);
  const previous = deviceIngressChains.get(deviceId) || Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  deviceIngressChains.set(deviceId, tail);
  try {
    return await result;
  } finally {
    const remaining = Math.max(0, (deviceIngressDepth.get(deviceId) || 1) - 1);
    if (remaining === 0) deviceIngressDepth.delete(deviceId);
    else deviceIngressDepth.set(deviceId, remaining);
    if (deviceIngressChains.get(deviceId) === tail) deviceIngressChains.delete(deviceId);
  }
}

export const allowedActions = new Set([
  "toggle", "setOutputState", "setPower", "setBrightness",
  "setFadeMode", "setTimer", "identify", "requestState"
]);

type CreateInput = {
  hub: WebSocketHub;
  deviceId: string;
  lampId: string;
  userId: string;
  action: string;
  value?: Prisma.JsonValue;
  commandId?: string;
};

type ExistingCommand = {
  id: string;
  commandId: string;
  deviceId: string;
  userId: string | null;
  action: string;
  valueJson: Prisma.JsonValue | null;
  status: string;
  expiresAt: Date;
};

type PreparedCommand = {
  id: string;
  commandId: string;
  action: string;
  value: Prisma.JsonValue | null;
  expiresAt: Date;
  priorStatus: string;
};

type DispatchResult = {
  commandId: string;
  delivered: boolean;
  expiresAt: Date;
  status: string;
};

type PreparedResult = { terminal: DispatchResult } | { command: PreparedCommand };

function sameLogicalCommand(input: CreateInput, existing: ExistingCommand): boolean {
  const inputValue = input.value ?? null;
  return existing.deviceId === input.deviceId &&
    existing.userId === input.userId &&
    existing.action === input.action &&
    canonicalJson(existing.valueJson ?? null) === canonicalJson(inputValue);
}

async function prepareExisting(input: CreateInput, existing: ExistingCommand): Promise<PreparedResult> {
  if (!sameLogicalCommand(input, existing)) throw new Error("commandId was already used for a different command");

  if (existing.status === "ACKNOWLEDGED") {
    return { terminal: { commandId: existing.commandId, delivered: true, expiresAt: existing.expiresAt, status: existing.status } };
  }
  if (existing.status === "FAILED" || existing.status === "EXPIRED") {
    return { terminal: { commandId: existing.commandId, delivered: false, expiresAt: existing.expiresAt, status: existing.status } };
  }
  if (existing.expiresAt <= new Date()) {
    await prisma.deviceCommand.updateMany({
      where: { id: existing.id, status: { in: ["PENDING", "SENT"] } },
      data: { status: "EXPIRED", errorMessage: "Command expired before acknowledgement" }
    });
    return { terminal: { commandId: existing.commandId, delivered: false, expiresAt: existing.expiresAt, status: "EXPIRED" } };
  }
  return {
    command: {
      id: existing.id,
      commandId: existing.commandId,
      action: existing.action,
      value: (existing.valueJson ?? null) as Prisma.JsonValue | null,
      expiresAt: existing.expiresAt,
      priorStatus: existing.status
    }
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "P2002";
}

async function prepareCommandCore(input: CreateInput): Promise<PreparedResult> {
  const commandId = input.commandId || randomCommandId();
  const expiresAt = new Date(Date.now() + ttlMsForAction(input.action));
  const createData = {
    commandId,
    deviceId: input.deviceId,
    userId: input.userId,
    action: input.action,
    valueJson: input.value ?? Prisma.JsonNull,
    expiresAt
  };

  try {
    let command;
    if (latestWinsActions.has(input.action)) {
      // RF5.4.1 normal durable ingress is one database transaction/round-trip,
      // not findUnique -> updateMany -> create. The unique commandId remains
      // the idempotency arbiter; a same-ID WS/REST race rolls this transaction
      // back and joins the winner below.
      const [, created] = await prisma.$transaction([
        prisma.deviceCommand.updateMany({
          where: {
            deviceId: input.deviceId,
            action: { in: supersededActions(input.action) },
            status: { in: ["PENDING", "SENT"] },
            expiresAt: { gt: new Date() }
          },
          data: { status: "EXPIRED", errorMessage: "Superseded by newer command" }
        }),
        prisma.deviceCommand.create({ data: createData })
      ]);
      command = created;
    } else {
      command = await prisma.deviceCommand.create({ data: createData });
    }

    return {
      command: {
        id: command.id,
        commandId,
        action: input.action,
        value: input.value ?? null,
        expiresAt,
        priorStatus: "PENDING"
      }
    };
  } catch (error) {
    // The common path performs no pre-insert lookup. Only an actual unique-key
    // collision (normally the same-ID REST hedge) pays this read.
    if (isUniqueConstraintError(error)) {
      const raced = await prisma.deviceCommand.findUnique({ where: { commandId } });
      if (raced) return await prepareExisting(input, raced as ExistingCommand);
    }
    throw error;
  }
}

async function dispatchPrepared(input: CreateInput, command: PreparedCommand): Promise<DispatchResult> {
  if (command.expiresAt <= new Date()) {
    await prisma.deviceCommand.updateMany({
      where: { id: command.id, status: { in: ["PENDING", "SENT"] } },
      data: { status: "EXPIRED", errorMessage: "Command expired before device dispatch" }
    });
    return { commandId: command.commandId, delivered: false, expiresAt: command.expiresAt, status: "EXPIRED" };
  }

  input.hub.registerCommandContext({
    commandDbId: command.id,
    commandId: command.commandId,
    deviceId: input.deviceId,
    lampId: input.lampId,
    userId: input.userId,
    expiresAt: command.expiresAt.getTime()
  });
  const delivered = await input.hub.sendCommandToDevice(
    input.lampId,
    commandPayload(command.commandId, command.action, command.value, command.expiresAt)
  );
  if (delivered) {
    await prisma.deviceCommand.updateMany({
      where: { id: command.id, status: { in: ["PENDING", "SENT"] }, expiresAt: { gt: new Date() } },
      data: { status: "SENT", deliveredAt: new Date(), errorMessage: null }
    });
  }
  console.log(`RF5.4.1 CMD dispatch id=${command.commandId} lamp=${input.lampId} action=${command.action} delivered=${delivered}`);
  return {
    commandId: command.commandId,
    delivered,
    expiresAt: command.expiresAt,
    status: delivered ? "SENT" : command.priorStatus
  };
}

function dispatchCoalesced(input: CreateInput, command: PreparedCommand): Promise<DispatchResult> {
  const existing = commandDispatches.get(command.commandId);
  if (existing) return existing;
  const promise = dispatchPrepared(input, command);
  commandDispatches.set(command.commandId, promise);
  void promise.then(
    () => { if (commandDispatches.get(command.commandId) === promise) commandDispatches.delete(command.commandId); },
    () => { if (commandDispatches.get(command.commandId) === promise) commandDispatches.delete(command.commandId); }
  );
  return promise;
}

export async function createAndDispatchCommand(input: CreateInput): Promise<DispatchResult> {
  // Crucially, the device WebSocket send is OUTSIDE this lane. A dead Cloud
  // generation cannot head-of-line block newer intent creation/supersession.
  const prepareStartedAt = Date.now();
  const prepared = await withDeviceIngressLane(input.deviceId, () => prepareCommandCore(input));
  console.log(`RF5.4.1 CMD db_prepare id=${input.commandId || "server"} lamp=${input.lampId} action=${input.action} total=${Date.now() - prepareStartedAt}ms terminal=${"terminal" in prepared}`);
  if ("terminal" in prepared) return prepared.terminal;
  return await dispatchCoalesced(input, prepared.command);
}
