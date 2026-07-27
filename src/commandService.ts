import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { config } from "./config";
import { randomCommandId } from "./security";
import type { WebSocketHub } from "./websocketHub";

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
  const expiresAt = new Date(Date.now() + config.commandTtlSeconds * 1000);
  const valueJson = input.value === null ? Prisma.JsonNull : input.value;
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
