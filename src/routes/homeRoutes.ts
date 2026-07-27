import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { asyncRoute, AppError } from "../errors";
import { getUserId, requireAuth, type AuthenticatedRequest } from "../auth";
import { getHomeRole, requireHomeRole } from "../access";

export const homeRouter = Router();
homeRouter.use("/api/homes", requireAuth);

const homeSchema = z.object({ name: z.string().trim().min(2).max(80) });
const roomSchema = z.object({ name: z.string().trim().min(1).max(80) });
const uuidParam = z.string().uuid();

homeRouter.get(
  "/api/homes",
  asyncRoute(async (req: AuthenticatedRequest, res) => {
    const userId = getUserId(req);
    const homes = await prisma.home.findMany({
      where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      include: {
        rooms: { orderBy: { name: "asc" } },
        devices: { include: { state: true, room: true }, orderBy: { displayName: "asc" } },
        members: { select: { userId: true, role: true } }
      },
      orderBy: { createdAt: "asc" }
    });
    res.json({ ok: true, homes });
  })
);

homeRouter.post(
  "/api/homes",
  asyncRoute(async (req: AuthenticatedRequest, res) => {
    const userId = getUserId(req);
    const body = homeSchema.parse(req.body);
    const home = await prisma.$transaction(async (tx) => {
      const created = await tx.home.create({ data: { name: body.name, ownerId: userId } });
      await tx.homeMember.create({ data: { homeId: created.id, userId, role: "OWNER" } });
      return created;
    });
    res.status(201).json({ ok: true, home });
  })
);

homeRouter.get(
  "/api/homes/:homeId",
  asyncRoute(async (req: AuthenticatedRequest, res) => {
    const homeId = uuidParam.parse(req.params.homeId);
    await getHomeRole(getUserId(req), homeId);
    const home = await prisma.home.findUnique({
      where: { id: homeId },
      include: {
        owner: { select: { id: true, email: true, displayName: true } },
        members: { include: { user: { select: { id: true, email: true, displayName: true } } } },
        rooms: { orderBy: { name: "asc" } },
        devices: { include: { state: true, room: true }, orderBy: { displayName: "asc" } }
      }
    });
    if (!home) throw new AppError(404, "HOME_NOT_FOUND", "Home was not found");
    res.json({ ok: true, home });
  })
);

homeRouter.post(
  "/api/homes/:homeId/rooms",
  asyncRoute(async (req: AuthenticatedRequest, res) => {
    const homeId = uuidParam.parse(req.params.homeId);
    await requireHomeRole(getUserId(req), homeId, ["OWNER", "ADMIN"]);
    const body = roomSchema.parse(req.body);
    const room = await prisma.room.create({ data: { homeId, name: body.name } });
    res.status(201).json({ ok: true, room });
  })
);
