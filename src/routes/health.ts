import { Router } from "express";
import { prisma } from "../db";
import { asyncRoute } from "../errors";

export const healthRouter = Router();

healthRouter.get(
  "/health",
  asyncRoute(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true,
      service: "sh-lamp-cloud-render",
      version: "0.1.0",
      time: new Date().toISOString()
    });
  })
);
