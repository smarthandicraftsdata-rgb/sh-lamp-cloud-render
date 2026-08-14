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

// Only the DB-prepare phase is ordered per device. RF5.4.3 deepest hardening
// uses a real replaceable queue instead of an unremovable Promise chain:
// for each latest-wins command domain, at most ONE not-yet-started intent is
// retained. A newer pending power/brightness, fade, timer, or requestState
// replaces the older pending intent before it can create a multi-second DB
// backlog. The currently running prepare is never cancelled mid-transaction.
type DeviceIngressJob = {
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  replaceKey?: string;
  onSuperseded?: () => unknown | Promise<unknown>;
};
const deviceIngressQueues = new Map<string, DeviceIngressJob[]>();
const deviceIngressRunning = new Set<string>();

// Superseded-before-prepare commands resolve immediately from a bounded
// in-memory terminal tombstone. Their audit rows are persisted by ONE serial
// background writer so a degraded database cannot be hit by a fan-out of
// dozens of concurrent EXPIRED inserts. If either bounded structure is full,
// the superseded caller falls back to synchronous durable persistence rather
// than losing idempotency.
type SupersededIngressTombstone = {
  fingerprint: string;
  result: DispatchResult;
};
type SupersededAuditJob = { input: CreateInput; commandId: string; expiresAt: Date };
const supersededIngressTombstones = new Map<string, SupersededIngressTombstone>();
const supersededAuditQueue: SupersededAuditJob[] = [];
let supersededAuditRunning = false;
let supersededAuditRetryMs = 1_000;
const MAX_DEVICE_SUPERSEDED_TOMBSTONES = 4096;
const MAX_SUPERSEDED_AUDIT_QUEUE = 4096;
const MAX_SUPERSEDED_AUDIT_RETRY_MS = 30_000;

// Same-ID WS + REST requests must join BEFORE they occupy two ingress slots.
// The fingerprint also retains cross-user / different-payload protection while
// a command is waiting for DB preparation.
type IngressCommandJoin = { fingerprint: string; promise: Promise<DispatchResult> };
const ingressCommandJoins = new Map<string, IngressCommandJoin>();

// After DB preparation, this short map coalesces the narrow prepare->dispatch
// race. WebSocketHub owns the longer send->ACK/generation lifecycle.
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

function kickDeviceIngressLane(deviceId: string): void {
  if (deviceIngressRunning.has(deviceId)) return;
  deviceIngressRunning.add(deviceId);
  void (async () => {
    try {
      while (true) {
        const queue = deviceIngressQueues.get(deviceId);
        const job = queue?.shift();
        if (!job) return;
        try {
          job.resolve(await job.operation());
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      deviceIngressRunning.delete(deviceId);
      const queue = deviceIngressQueues.get(deviceId);
      if (!queue?.length) deviceIngressQueues.delete(deviceId);
      else kickDeviceIngressLane(deviceId);
    }
  })();
}

function withDeviceIngressLane<T>(
  deviceId: string,
  operation: () => Promise<T>,
  options?: { replaceKey?: string; onSuperseded?: () => T | Promise<T> }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queue = deviceIngressQueues.get(deviceId) || [];
    deviceIngressQueues.set(deviceId, queue);

    if (options?.replaceKey) {
      const replaceIndex = queue.findIndex((job) => job.replaceKey === options.replaceKey);
      if (replaceIndex >= 0) {
        const superseded = queue.splice(replaceIndex, 1)[0];
        if (superseded) {
          if (superseded.onSuperseded) {
            void Promise.resolve().then(() => superseded.onSuperseded!()).then(superseded.resolve, superseded.reject);
          } else {
            superseded.reject(new Error("Command superseded before database preparation"));
          }
        }
      }
    }

    const active = deviceIngressRunning.has(deviceId) ? 1 : 0;
    if (queue.length + active >= MAX_DEVICE_INGRESS_QUEUE) {
      reject(new Error("Too many commands are already being submitted for this lamp"));
      return;
    }
    queue.push({
      operation: operation as () => Promise<unknown>,
      resolve: (value) => resolve(value as T),
      reject,
      replaceKey: options?.replaceKey,
      onSuperseded: options?.onSuperseded as (() => unknown | Promise<unknown>) | undefined
    });
    kickDeviceIngressLane(deviceId);
  });
}

function ingressReplaceKey(action: string): string | undefined {
  const groupIndex = latestWinsGroups.findIndex((group) => group.includes(action));
  if (groupIndex >= 0) return `latest:${groupIndex}`;
  if (action === "requestState") return "requestState";
  return undefined;
}

function commandFingerprint(input: CreateInput): string {
  return `${input.deviceId}|${input.userId}|${input.action}|${canonicalJson(input.value ?? null)}`;
}

function existingSupersededIngressResult(input: CreateInput, commandId: string): DispatchResult | undefined {
  const tombstone = supersededIngressTombstones.get(commandId);
  if (!tombstone) return undefined;
  if (tombstone.fingerprint !== commandFingerprint(input)) {
    throw new Error("commandId was already used for a different command");
  }
  return tombstone.result;
}

function kickSupersededAuditWriter(): void {
  if (supersededAuditRunning) return;
  supersededAuditRunning = true;
  void (async () => {
    while (true) {
      const job = supersededAuditQueue[0];
      if (!job) {
        supersededAuditRunning = false;
        return;
      }
      try {
        await persistSupersededBeforePrepare(job.input, job.commandId, job.expiresAt);
        supersededAuditQueue.shift();
        // Once durability is confirmed, Prisma's unique commandId/status row
        // becomes the replay authority and this RAM tombstone is no longer
        // needed. Only remove the exact logical tombstone we persisted.
        const tombstone = supersededIngressTombstones.get(job.commandId);
        if (tombstone?.fingerprint === commandFingerprint(job.input)) {
          supersededIngressTombstones.delete(job.commandId);
        }
        supersededAuditRetryMs = 1_000;
      } catch (error) {
        // Keep BOTH queue ownership and the terminal tombstone. A DB outage
        // must never make an old superseded command executable again. Retry
        // only one serial audit operation with bounded exponential backoff.
        console.error(`RF5.4.3 superseded audit persistence failed id=${job.commandId}`, error);
        const retryAfter = supersededAuditRetryMs;
        supersededAuditRetryMs = Math.min(MAX_SUPERSEDED_AUDIT_RETRY_MS, supersededAuditRetryMs * 2);
        setTimeout(() => {
          supersededAuditRunning = false;
          kickSupersededAuditWriter();
        }, retryAfter);
        return;
      }
    }
  })();
}

function resolveSupersededBeforePrepare(input: CreateInput, commandId: string, expiresAt: Date): Promise<DispatchResult> {
  if (supersededIngressTombstones.size >= MAX_DEVICE_SUPERSEDED_TOMBSTONES ||
      supersededAuditQueue.length >= MAX_SUPERSEDED_AUDIT_QUEUE) {
    // Fail safe on bounded-memory pressure: pay the DB latency for this old
    // command rather than dropping its terminal/idempotency record.
    return persistSupersededBeforePrepare(input, commandId, expiresAt);
  }

  const result: DispatchResult = { commandId, delivered: false, expiresAt, status: "EXPIRED" };
  supersededIngressTombstones.set(commandId, {
    fingerprint: commandFingerprint(input),
    result
  });
  supersededAuditQueue.push({ input, commandId, expiresAt });
  kickSupersededAuditWriter();
  return Promise.resolve(result);
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

async function prepareCommandCore(input: CreateInput, ingressReceivedAt: number): Promise<PreparedResult> {
  const commandId = input.commandId || randomCommandId();
  const expiresAt = new Date(ingressReceivedAt + ttlMsForAction(input.action));
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
      // RF5.4.3 normal durable ingress is one database transaction/round-trip,
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

async function persistSupersededBeforePrepare(
  input: CreateInput,
  commandId: string,
  expiresAt: Date,
  errorMessage = "Superseded before database preparation"
): Promise<DispatchResult> {
  try {
    await prisma.deviceCommand.create({
      data: {
        commandId,
        deviceId: input.deviceId,
        userId: input.userId,
        action: input.action,
        valueJson: input.value ?? Prisma.JsonNull,
        status: "EXPIRED",
        expiresAt,
        errorMessage
      }
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await prisma.deviceCommand.findUnique({ where: { commandId } });
    if (existing) {
      const prepared = await prepareExisting(input, existing as ExistingCommand);
      if ("terminal" in prepared) return prepared.terminal;
      // A same-ID command already progressed further than this pending copy.
      // Join semantics are handled by ingressCommandJoins/WebSocketHub; never
      // expire or redispatch that canonical operation from this superseded job.
      return { commandId, delivered: false, expiresAt: existing.expiresAt, status: existing.status };
    }
  }
  return { commandId, delivered: false, expiresAt, status: "EXPIRED" };
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
  console.log(`RF5.4.3 CMD dispatch id=${command.commandId} lamp=${input.lampId} action=${command.action} delivered=${delivered}`);
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
  const ingressReceivedAt = Date.now();
  const commandId = input.commandId || randomCommandId();
  const normalizedInput: CreateInput = { ...input, commandId };
  const fingerprint = commandFingerprint(normalizedInput);

  const superseded = existingSupersededIngressResult(normalizedInput, commandId);
  if (superseded) return superseded;

  const joined = ingressCommandJoins.get(commandId);
  if (joined) {
    if (joined.fingerprint !== fingerprint) throw new Error("commandId was already used for a different command");
    return await joined.promise;
  }

  const promise = (async (): Promise<DispatchResult> => {
    const expiresAt = new Date(ingressReceivedAt + ttlMsForAction(normalizedInput.action));
    const prepared = await withDeviceIngressLane(
      normalizedInput.deviceId,
      async () => {
        // TTL starts when Render RECEIVES the intent, not after it waits behind
        // a degraded database. An already-expired control is never dispatched.
        if (Date.now() >= expiresAt.getTime()) {
          return { terminal: await persistSupersededBeforePrepare(
            normalizedInput, commandId, expiresAt, "Command expired before database preparation"
          ) } as PreparedResult;
        }
        return await prepareCommandCore(normalizedInput, ingressReceivedAt);
      },
      {
        replaceKey: ingressReplaceKey(normalizedInput.action),
        onSuperseded: async () => ({ terminal: await resolveSupersededBeforePrepare(normalizedInput, commandId, expiresAt) } as PreparedResult)
      }
    );
    console.log(`RF5.4.3 CMD db_prepare id=${commandId} lamp=${normalizedInput.lampId} action=${normalizedInput.action} total=${Date.now() - ingressReceivedAt}ms terminal=${"terminal" in prepared}`);
    if ("terminal" in prepared) return prepared.terminal;
    return await dispatchCoalesced(normalizedInput, prepared.command);
  })();

  ingressCommandJoins.set(commandId, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (ingressCommandJoins.get(commandId)?.promise === promise) ingressCommandJoins.delete(commandId);
  }
}
