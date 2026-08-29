import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthPayload {
  userId: string;
  phone: string;
  role: string;
  iat: number;
  exp: number;
  sub: string;        // user id
  stellarPublicKey: string;
}

/** Extends Express's Request so downstream handlers get req.user typed */
export interface AuthenticatedRequest extends Request {
  user: AuthPayload;
}

/**
 * Middleware that validates a Bearer JWT in the Authorization header.
 * Attaches the decoded payload to `req.user` on success.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers["authorization"];

  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice(7);
  const secret = process.env["JWT_SECRET"]!;

  try {
    const payload = jwt.verify(token, secret) as AuthPayload;
    (req as unknown as AuthenticatedRequest).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Token is invalid or expired" });
  }
}
