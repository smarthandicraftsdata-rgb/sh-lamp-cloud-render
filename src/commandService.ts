import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { config } from "./config";
import { randomCommandId } from "./security";
import type { WebSocketHub } from "./websocketHub";

// RF5 command domains. Power and brightness are one output domain so legacy
// commands cannot replay across the new complete setOutputState intent.
const latestWinsGroups: string[][] = [
  ["setOutputState", "setPower", "setBrightness"],
  ["setFadeMode"],
  ["setTimer"]
];
const latestWinsActions = new Set(latestWinsGroups.flat());
const REALTIME_CONTROL_TTL_MS = 2_000;
const REQUEST_STATE_TTL_MS = 10_000;

function ttlMsForAction(action: string): number {
  if (latestWinsActions.has(action)) return Math.min(config.commandTtlSeconds * 1000, REALTIME_CONTROL_TTL_MS);
  if (action === "requestState") return Math.min(config.commandTtlSeconds * 1000, REQUEST_STATE_TTL_MS);
  return Math.min(config.commandTtlSeconds * 1000, REALTIME_CONTROL_TTL_MS);
}

function supersededActions(action: string): string[] {
  return latestWinsGroups.find((group) => group.includes(action)) || [action];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export const allowedActions = new Set([
  "toggle",
  "setOutputState",
  "setPower",
  "setBrightness",
  "setFadeMode",
  "setTimer",
  "identify",
  "requestState"
]);

export async function createAndDispatchCommand(input: {
  hub: WebSocketHub;
  deviceId: string;
  lampId: string;
  userId: string;
  action: string;
  value?: Prisma.JsonValue;
  commandId?: string;
}) {
  const commandId = input.commandId || randomCommandId();
  const expiresAt = new Date(Date.now() + ttlMsForAction(input.action));
  const valueJson = input.value === null ? Prisma.JsonNull : input.value;

  // Network-path retries use the exact same command ID. Accept only an
  // identical logical command; canonical comparison avoids false mismatches
  // caused solely by JSON object key order.
  const existing = await prisma.deviceCommand.findUnique({ where: { commandId } });
  if (existing) {
    const sameValue = canonicalJson(existing.valueJson ?? null) === canonicalJson(valueJson ?? null);
    if (existing.deviceId !== input.deviceId || existing.action !== input.action || !sameValue) {
      throw new Error("commandId was already used for a different command");
    }

    if (existing.status === "ACKNOWLEDGED") {
      return { commandId, delivered: true, expiresAt: existing.expiresAt, status: existing.status };
    }
    if (existing.status === "FAILED" || existing.status === "EXPIRED") {
      return { commandId, delivered: false, expiresAt: existing.expiresAt, status: existing.status };
    }

    if (existing.expiresAt <= new Date()) {
      await prisma.deviceCommand.updateMany({
        where: { id: existing.id, status: { in: ["PENDING", "SENT"] } },
        data: { status: "EXPIRED", errorMessage: "Command expired before acknowledgement" }
      });
      return { commandId, delivered: false, expiresAt: existing.expiresAt, status: "EXPIRED" as const };
    }

    const delivered = await input.hub.sendCommandToDevice(input.lampId, {
      type: "deviceCommand",
      commandId,
      action: input.action,
      value: input.value ?? null,
      expiresAt: existing.expiresAt.toISOString()
    });
    if (delivered) {
      await prisma.deviceCommand.updateMany({
        where: { id: existing.id, status: { in: ["PENDING", "SENT"] } },
        data: { status: "SENT", deliveredAt: new Date(), errorMessage: null }
      });
    }
    return { commandId, delivered, expiresAt: existing.expiresAt, status: delivered ? "SENT" : existing.status };
  }

  if (latestWinsActions.has(input.action)) {
    // Expire the whole semantic domain, not merely the exact action. This is
    // required during migration because setPower/setBrightness and the RF5
    // setOutputState all mutate the same output state.
    await prisma.deviceCommand.updateMany({
      where: {
        deviceId: input.deviceId,
        action: { in: supersededActions(input.action) },
        status: { in: ["PENDING", "SENT"] },
        expiresAt: { gt: new Date() }
      },
      data: { status: "EXPIRED", errorMessage: "Superseded by newer command" }
    });
  }

  const command = await prisma.deviceCommand.create({
    data: {
      commandId,
      deviceId: input.deviceId,
      userId: input.userId,
      action: input.action,
      valueJson,
      expiresAt
    }
  });

  const delivered = await input.hub.sendCommandToDevice(input.lampId, {
    type: "deviceCommand",
    commandId,
    action: input.action,
    value: input.value ?? null,
    expiresAt: expiresAt.toISOString()
  });

  // RF5: never mark SENT merely because a socket object existed. The hub only
  // returns true after ws.send accepted the frame without backpressure/error.
  if (delivered) {
    await prisma.deviceCommand.updateMany({
      where: { id: command.id, status: "PENDING" },
      data: { status: "SENT", deliveredAt: new Date(), errorMessage: null }
    });
  }

  return { commandId, delivered, expiresAt, status: delivered ? "SENT" : "PENDING" };
}
