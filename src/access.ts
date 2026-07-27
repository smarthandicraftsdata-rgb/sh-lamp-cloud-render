import type { HomeRole } from "@prisma/client";
import { prisma } from "./db";
import { AppError } from "./errors";

export async function getHomeRole(userId: string, homeId: string): Promise<HomeRole> {
  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: {
      ownerId: true,
      members: { where: { userId }, select: { role: true }, take: 1 }
    }
  });

  if (!home) throw new AppError(404, "HOME_NOT_FOUND", "Home was not found");
  if (home.ownerId === userId) return "OWNER";
  const role = home.members[0]?.role;
  if (!role) throw new AppError(403, "HOME_ACCESS_DENIED", "You do not have access to this home");
  return role;
}

export async function requireHomeRole(
  userId: string,
  homeId: string,
  allowed: HomeRole[]
): Promise<HomeRole> {
  const role = await getHomeRole(userId, homeId);
  if (!allowed.includes(role)) {
    throw new AppError(403, "INSUFFICIENT_HOME_ROLE", "Your home role does not allow this action");
  }
  return role;
}

export async function findAccessibleDevice(userId: string, lampId: string) {
  const device = await prisma.device.findFirst({
    where: {
      lampId,
      OR: [{ ownerId: userId }, { home: { members: { some: { userId } } } }]
    },
    include: { state: true, home: true, room: true }
  });

  if (!device) {
    throw new AppError(404, "DEVICE_NOT_FOUND", "Lamp was not found or is not accessible");
  }
  return device;
}
