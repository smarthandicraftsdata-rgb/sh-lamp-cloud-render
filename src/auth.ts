import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errors";
import { verifyAccessToken, type AccessTokenPayload } from "./security";

export interface AuthenticatedRequest extends Request {
  auth?: AccessTokenPayload;
}

export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    next(new AppError(401, "AUTH_REQUIRED", "Bearer access token is required"));
    return;
  }

  req.auth = verifyAccessToken(header.slice("Bearer ".length).trim());
  next();
}

export function getUserId(req: AuthenticatedRequest): string {
  if (!req.auth?.sub) {
    throw new AppError(401, "AUTH_REQUIRED", "Authentication is required");
  }
  return req.auth.sub;
}
