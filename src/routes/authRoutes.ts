import crypto from "node:crypto";
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
const passwordResetRequestLimiter = createRateLimiter(5, 15 * 60_000);
const passwordResetConfirmLimiter = createRateLimiter(10, 15 * 60_000);

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
const passwordResetRequestSchema = z.object({ email: z.string().email().max(254) });
const passwordResetConfirmSchema = z.object({
  token: z.string().trim().min(32).max(512),
  newPassword: z.string().min(8).max(72)
});

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

async function sendPasswordResetEmail(email: string, token: string): Promise<boolean> {
  if (!config.resendApiKey || !config.passwordResetFromEmail) return false;

  const ttl = config.passwordResetTokenTtlMinutes;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json",
      "user-agent": "SH-Lamp-Cloud/1.0",
      "idempotency-key": `password-reset-${hashSecret(token).slice(0, 40)}`
    },
    body: JSON.stringify({
      from: config.passwordResetFromEmail,
      to: [email],
      subject: "Reset your SH Lamp password",
      text: [
        "A password reset was requested for your SH Lamp account.",
        "",
        `Reset code: ${token}`,
        "",
        `This code expires in ${ttl} minutes and can be used only once.`,
        "Open the SH Lamp app, tap Forgot Password, and paste this code.",
        "",
        "If you did not request this reset, ignore this email."
      ].join("\n")
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    console.warn("Password reset email failed", response.status, details.slice(0, 500));
    return false;
  }
  return true;
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
  "/api/auth/password-reset/request",
  passwordResetRequestLimiter,
  asyncRoute(async (req, res) => {
    const { email: rawEmail } = passwordResetRequestSchema.parse(req.body);
    const email = normalizeEmail(rawEmail);
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true }
    });

    let resetToken: string | null = null;
    if (user) {
      resetToken = createOpaqueToken(32);
      const expiresAt = new Date(
        Date.now() + config.passwordResetTokenTtlMinutes * 60_000
      );

      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
        prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hashSecret(resetToken),
            expiresAt
          }
        })
      ]);

      const emailSent = await sendPasswordResetEmail(user.email, resetToken).catch((error) => {
        console.warn(
          "Password reset email error",
          error instanceof Error ? error.message : error
        );
        return false;
      });

      if (!emailSent && !config.passwordResetDebugReturnToken) {
        console.warn(
          "Password reset requested but email delivery is not configured. " +
          "Set RESEND_API_KEY and PASSWORD_RESET_FROM_EMAIL."
        );
      }
    }

    const response: Record<string, unknown> = {
      ok: true,
      message: "If an account exists for this email, a reset code has been sent."
    };

    // TESTING ONLY. Leave false after email delivery is configured. A random token is
    // returned for unknown accounts so this mode does not reveal whether an email exists.
    if (config.passwordResetDebugReturnToken) {
      response.debugResetToken = resetToken ?? createOpaqueToken(32);
      response.debugWarning = "Testing mode only: disable PASSWORD_RESET_DEBUG_RETURN_TOKEN after setup.";
    }

    res.status(202).json(response);
  })
);

authRouter.post(
  "/api/auth/password-reset/confirm",
  passwordResetConfirmLimiter,
  asyncRoute(async (req, res) => {
    const body = passwordResetConfirmSchema.parse(req.body);
    const tokenHash = hashSecret(body.token);
    const now = new Date();
    const stored = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true }
    });

    if (!stored || stored.usedAt || stored.expiresAt <= now) {
      throw new AppError(
        400,
        "INVALID_RESET_TOKEN",
        "Reset code is invalid, expired, or already used"
      );
    }

    const passwordHash = await hashPassword(body.newPassword);
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: stored.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now }
      });
      if (consumed.count !== 1) {
        throw new AppError(
          400,
          "INVALID_RESET_TOKEN",
          "Reset code is invalid, expired, or already used"
        );
      }

      await tx.user.update({
        where: { id: stored.userId },
        data: { passwordHash }
      });
      await tx.passwordResetToken.updateMany({
        where: { userId: stored.userId, usedAt: null },
        data: { usedAt: now }
      });
      await tx.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: now }
      });
      await tx.activityEvent.create({
        data: {
          type: "PASSWORD_RESET",
          userId: stored.userId,
          payload: { source: "forgot-password", requestId: crypto.randomUUID() }
        }
      });
    });

    res.json({
      ok: true,
      message: "Password reset completed. Sign in with your new password."
    });
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
