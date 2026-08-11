import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { config } from "./config";
import { randomCommandId } from "./security";
import type { WebSocketHub } from "./websocketHub";

const latestWinsActions = new Set(["setPower", "setBrightness", "setFadeMode", "setTimer"]);
const REALTIME_CONTROL_TTL_MS = 6_000;
const REQUEST_STATE_TTL_MS = 10_000;

function ttlMsForAction(action: string): number {
  if (latestWinsActions.has(action)) return Math.min(config.commandTtlSeconds * 1000, REALTIME_CONTROL_TTL_MS);
  if (action === "requestState") return Math.min(config.commandTtlSeconds * 1000, REQUEST_STATE_TTL_MS);
  return Math.min(config.commandTtlSeconds * 1000, REALTIME_CONTROL_TTL_MS);
}

export const allowedActions = new Set([
  "toggle",
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

  // A mobile client can lose its network immediately after submitting a
  // command and retry with the same commandId. Treat that as the same logical
  // command rather than failing the unique constraint or executing a different
  // payload under an old ID.
  const existing = await prisma.deviceCommand.findUnique({ where: { commandId } });
  if (existing) {
    const sameValue = JSON.stringify(existing.valueJson) === JSON.stringify(valueJson ?? null);
    if (existing.deviceId !== input.deviceId || existing.action !== input.action || !sameValue) {
      throw new Error("commandId was already used for a different command");
    }

    if (existing.status === "ACKNOWLEDGED") {
      return { commandId, delivered: true, expiresAt: existing.expiresAt };
    }

    if (existing.expiresAt <= new Date()) {
      await prisma.deviceCommand.update({
        where: { id: existing.id },
        data: { status: "EXPIRED", errorMessage: "Command expired before acknowledgement" }
      });
      return { commandId, delivered: false, expiresAt: existing.expiresAt };
    }

    const delivered = await input.hub.sendCommandToDevice(input.lampId, {
      type: "deviceCommand",
      commandId,
      action: input.action,
      value: input.value ?? null,
      expiresAt: existing.expiresAt.toISOString()
    });
    if (delivered) {
      await prisma.deviceCommand.update({
        where: { id: existing.id },
        data: { status: "SENT", deliveredAt: new Date(), errorMessage: null }
      });
    }
    return { commandId, delivered, expiresAt: existing.expiresAt };
  }

  if (latestWinsActions.has(input.action)) {
    // RF2: absolute lamp controls are latest-wins. If a previous cloud command
    // has not been acknowledged yet, do not allow it to replay later and fight
    // a newer user intent during BLE/LAN/cloud handover.
    await prisma.deviceCommand.updateMany({
      where: {
        deviceId: input.deviceId,
        action: input.action,
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

  if (delivered) {
    await prisma.deviceCommand.update({
      where: { id: command.id },
      data: { status: "SENT", deliveredAt: new Date() }
    });
  }

  return { commandId, delivered, expiresAt };
}
