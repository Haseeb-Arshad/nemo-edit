import type { Request } from "express";
import { config } from "./config.js";

export function getUserIdFromAuth(req: Request): string | null {
  const auth = req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1];
  if (!token) return null;
  if (token === config.devToken) return "dev-user";
  return null;
}
