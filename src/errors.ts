import type { NextFunction, Request, Response, RequestHandler } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function asyncRoute<TRequest extends Request = Request>(
  handler: (req: TRequest, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req as TRequest, res, next)).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` }
  });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      }
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message }
    });
    return;
  }

  const maybePrismaError = error as { code?: string; meta?: unknown };
  if (maybePrismaError?.code === "P2002") {
    res.status(409).json({
      ok: false,
      error: { code: "DUPLICATE", message: "A record with the same unique value already exists" }
    });
    return;
  }

  console.error("Unhandled server error", error);
  res.status(500).json({
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error" }
  });
}
