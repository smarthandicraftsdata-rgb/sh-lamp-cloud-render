import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { asyncRoute, AppError } from "../errors";
import {
  createAccessToken,
  createOpaqueToken,
  hashPassword,
  hashSecret,
  normalizeEmail,
  verifyPassword
} from "../security";
import { config } from "../config";
import { createRateLimiter } from "../rateLimit";
import { getUserId, requireAuth, type AuthenticatedRequest } from "../auth";

export const authRouter = Router();
const authLimiter = createRateLimiter(20, 15 * 60_000);

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(2).max(80)
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(72)
});

const refreshSchema = z.object({ refreshToken: z.string().min(32).max(512) });

function publicUser(user: { id: string; email: string; displayName: string; createdAt: Date }) {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt };
}

async function issueSession(user: { id: string; email: string }) {
  const refreshToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashSecret(refreshToken), expiresAt }
  });
  return {
    accessToken: createAccessToken(user),
    accessTokenExpiresIn: config.accessTokenTtlSeconds,
    refreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString()
  };
}

authRouter.post(
  "/api/auth/register",
  authLimiter,
  asyncRoute(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const email = normalizeEmail(body.email);
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new AppError(409, "EMAIL_IN_USE", "An account already exists for this email");

    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, passwordHash, displayName: body.displayName },
        select: { id: true, email: true, displayName: true, createdAt: true }
      });
      const home = await tx.home.create({ data: { name: "My Home", ownerId: created.id } });
      await tx.homeMember.create({ data: { homeId: home.id, userId: created.id, role: "OWNER" } });
      return created;
    });

    const session = await issueSession(user);
    res.status(201).json({ ok: true, user: publicUser(user), session });
  })
);

authRouter.post(
  "/api/auth/login",
  authLimiter,
  asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const email = normalizeEmail(body.email);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }

    const session = await issueSession(user);
    res.json({ ok: true, user: publicUser(user), session });
  })
);

authRouter.post(
  "/api/auth/refresh",
  authLimiter,
  asyncRoute(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const currentHash = hashSecret(refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: currentHash },
      include: { user: true }
    });

    if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
    }

    const nextRefreshToken = createOpaqueToken();
    const nextExpiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
    await prisma.$transaction([
      prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
      prisma.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: hashSecret(nextRefreshToken),
          expiresAt: nextExpiresAt
        }
      })
    ]);

    res.json({
      ok: true,
      session: {
        accessToken: createAccessToken(stored.user),
        accessTokenExpiresIn: config.accessTokenTtlSeconds,
        refreshToken: nextRefreshToken,
        refreshTokenExpiresAt: nextExpiresAt.toISOString()
      }
    });
  })
);

authRouter.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashSecret(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() }
    });
    res.json({ ok: true });
  })
);

authRouter.get(
  "/api/me",
  requireAuth,
  asyncRoute(async (req: AuthenticatedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: getUserId(req) },
      select: { id: true, email: true, displayName: true, createdAt: true }
    });
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User account was not found");
    res.json({ ok: true, user: publicUser(user) });
  })
);
