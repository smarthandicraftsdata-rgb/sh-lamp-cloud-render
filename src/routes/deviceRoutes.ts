import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { asyncRoute, AppError } from "../errors";
import { getUserId, requireAuth, type AuthenticatedRequest } from "../auth";
import { findAccessibleDevice, requireHomeRole } from "../access";
import {
  createClaimCode,
  createOpaqueToken,
  hashSecret,
  normalizeLampId,
  secretsEqual
} from "../security";
import { config } from "../config";
import { createRateLimiter } from "../rateLimit";
import { allowedActions, createAndDispatchCommand } from "../commandService";
import type { WebSocketHub } from "../websocketHub";

const lampIdParam = z.string().transform(normalizeLampId);
const uuid = z.string().uuid();

export function createDeviceRouter(hub: WebSocketHub): Router {
  const router = Router();
  const adminLimiter = createRateLimiter(10, 15 * 60_000);

  const adminDeviceSchema = z.object({
    lampId: z.string(),
    displayName: z.string().trim().min(2).max(80).optional(),
    firmwareVersion: z.string().trim().min(1).max(40).optional()
  });

  router.post(
    "/api/admin/devices",
    adminLimiter,
    asyncRoute(async (req, res) => {
      const key = req.header("x-admin-key");
      if (!key || !secretsEqual(key, hashSecret(config.adminSetupKey))) {
        throw new AppError(403, "ADMIN_KEY_INVALID", "Valid x-admin-key is required");
      }

      const body = adminDeviceSchema.parse(req.body);
      const lampId = normalizeLampId(body.lampId);
      const deviceSecret = createOpaqueToken(32);
      const claimCode = createClaimCode();
      const device = await prisma.device.create({
        data: {
          lampId,
          displayName: body.displayName || `SH Lamp ${lampId.slice(-4)}`,
          firmwareVersion: body.firmwareVersion,
          deviceSecretHash: hashSecret(deviceSecret),
          claimCodeHash: hashSecret(claimCode),
          state: { create: {} }
        },
        select: { id: true, lampId: true, displayName: true, firmwareVersion: true, createdAt: true }
      });

      res.status(201).json({
        ok: true,
        device,
        credentials: { lampId, deviceSecret, claimCode },
        warning: "Save these credentials now. The server stores only hashes and cannot show them again."
      });
    })
  );

  router.use("/api/devices", requireAuth);

  router.get(
    "/api/devices",
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const userId = getUserId(req);
      const devices = await prisma.device.findMany({
        where: { OR: [{ ownerId: userId }, { home: { members: { some: { userId } } } }] },
        include: { state: true, home: true, room: true },
        orderBy: { displayName: "asc" }
      });
      res.json({ ok: true, devices });
    })
  );

  const claimSchema = z.object({
    lampId: z.string(),
    claimCode: z.string().trim().min(6).max(32),
    homeId: z.string().uuid(),
    roomId: z.string().uuid().nullable().optional(),
    displayName: z.string().trim().min(2).max(80).optional()
  });

  router.post(
    "/api/devices/claim",
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const userId = getUserId(req);
      const body = claimSchema.parse(req.body);
      const lampId = normalizeLampId(body.lampId);
      await requireHomeRole(userId, body.homeId, ["OWNER", "ADMIN"]);

      if (body.roomId) {
        const room = await prisma.room.findFirst({ where: { id: body.roomId, homeId: body.homeId } });
        if (!room) throw new AppError(400, "ROOM_HOME_MISMATCH", "Room does not belong to the selected home");
      }

      const device = await prisma.device.findUnique({ where: { lampId } });
      if (!device) throw new AppError(404, "DEVICE_NOT_REGISTERED", "Lamp is not registered in the cloud");
      if (device.claimedAt || device.ownerId) throw new AppError(409, "DEVICE_ALREADY_CLAIMED", "Lamp is already claimed");
      if (!device.claimCodeHash || !secretsEqual(body.claimCode, device.claimCodeHash)) {
        throw new AppError(403, "CLAIM_CODE_INVALID", "Claim code is incorrect");
      }

      const claimed = await prisma.device.update({
        where: { id: device.id },
        data: {
          ownerId: userId,
          homeId: body.homeId,
          roomId: body.roomId ?? null,
          displayName: body.displayName || device.displayName,
          claimedAt: new Date(),
          claimCodeHash: null
        },
        include: { state: true, home: true, room: true }
      });
      await prisma.activityEvent.create({
        data: { type: "DEVICE_CLAIMED", userId, deviceId: device.id, homeId: body.homeId, payload: { lampId } }
      });
      res.status(201).json({ ok: true, device: claimed });
    })
  );

  router.get(
    "/api/devices/:lampId/state",
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const lampId = lampIdParam.parse(req.params.lampId);
      const device = await findAccessibleDevice(getUserId(req), lampId);
      res.json({
        ok: true,
        device: {
          lampId: device.lampId,
          displayName: device.displayName,
          online: device.online,
          lastSeen: device.lastSeen,
          firmwareVersion: device.firmwareVersion,
          state: device.state
        }
      });
    })
  );

  const updateSchema = z.object({
    displayName: z.string().trim().min(2).max(80).optional(),
    roomId: z.string().uuid().nullable().optional()
  }).refine((value) => value.displayName !== undefined || value.roomId !== undefined, {
    message: "Provide displayName or roomId"
  });

  router.patch(
    "/api/devices/:lampId",
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const userId = getUserId(req);
      const lampId = lampIdParam.parse(req.params.lampId);
      const body = updateSchema.parse(req.body);
      const device = await findAccessibleDevice(userId, lampId);
      if (!device.homeId) throw new AppError(409, "DEVICE_NOT_CLAIMED", "Lamp is not assigned to a home");
      await requireHomeRole(userId, device.homeId, ["OWNER", "ADMIN"]);

      if (body.roomId) {
        const room = await prisma.room.findFirst({ where: { id: body.roomId, homeId: device.homeId } });
        if (!room) throw new AppError(400, "ROOM_HOME_MISMATCH", "Room does not belong to the lamp home");
      }

      const updated = await prisma.device.update({
        where: { id: device.id },
        data: {
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.roomId !== undefined ? { roomId: body.roomId } : {})
        },
        include: { state: true, home: true, room: true }
      });
      res.json({ ok: true, device: updated });
    })
  );

  const commandSchema = z.object({
    commandId: z.string().min(8).max(100).optional(),
    action: z.string().min(1).max(40),
    value: z.json().optional()
  });

  router.post(
    "/api/devices/:lampId/commands",
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const userId = getUserId(req);
      const lampId = lampIdParam.parse(req.params.lampId);
      const body = commandSchema.parse(req.body);
      if (!allowedActions.has(body.action)) {
        throw new AppError(400, "ACTION_NOT_ALLOWED", `Unsupported action: ${body.action}`);
      }
      const device = await findAccessibleDevice(userId, lampId);
      const result = await createAndDispatchCommand({
        hub,
        deviceId: device.id,
        lampId,
        userId,
        action: body.action,
        value: body.value as Prisma.JsonValue | undefined,
        commandId: body.commandId
      });
      res.status(202).json({ ok: true, ...result });
    })
  );

  router.get(
    "/api/devices/:lampId/commands/:commandId",
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const userId = getUserId(req);
      const lampId = lampIdParam.parse(req.params.lampId);
      const commandId = z.string().min(8).max(100).parse(req.params.commandId);
      const device = await findAccessibleDevice(userId, lampId);
      const command = await prisma.deviceCommand.findFirst({
        where: { commandId, deviceId: device.id }
      });
      if (!command) throw new AppError(404, "COMMAND_NOT_FOUND", "Command was not found for this lamp");
      res.json({
        ok: true,
        lampId,
        commandId: command.commandId,
        status: command.status,
        expiresAt: command.expiresAt,
        deliveredAt: command.deliveredAt,
        acknowledgedAt: command.acknowledgedAt,
        errorMessage: command.errorMessage,
        error: command.errorMessage
      });
    })
  );

  router.delete(
    "/api/devices/:lampId",
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const userId = getUserId(req);
      const lampId = lampIdParam.parse(req.params.lampId);
      const device = await findAccessibleDevice(userId, lampId);
      if (device.ownerId !== userId) {
        throw new AppError(403, "OWNER_REQUIRED", "Only the lamp owner can release it");
      }

      const claimCode = createClaimCode();
      await prisma.device.update({
        where: { id: device.id },
        data: {
          ownerId: null,
          homeId: null,
          roomId: null,
          claimedAt: null,
          online: false,
          claimCodeHash: hashSecret(claimCode)
        }
      });
      hub.disconnectDevice(lampId, 4001, "Lamp ownership released");
      res.json({
        ok: true,
        lampId,
        newClaimCode: claimCode,
        warning: "The physical lamp should also be factory-reset before another customer claims it."
      });
    })
  );

  return router;
}
