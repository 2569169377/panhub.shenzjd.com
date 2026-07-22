import type { H3Event } from "h3";
import { createError } from "h3";
import { isUnlocked } from "./auth";

export function requireSearchAuth(event: H3Event): void {
  const config = useRuntimeConfig();
  const password = (config.searchPassword as string) || "";
  if (!password.trim()) return;
  if (!isUnlocked(event, password)) {
    throw createError({ statusCode: 401, statusMessage: "search locked" });
  }
}
