import { createHash } from "node:crypto";

/** Hash the exact raw connection, including unknown fields, before resolving
 * secrets. Only mutable tool policy and discovery counts are excluded: runtime
 * authorization reads those decisions from the database on every dispatch. */
export function fingerprintMcpConnection(name: string, raw: Record<string, unknown>): string {
  const { approveTools, includeTools, excludeTools, __piScienceAllowedTools, __piScienceToolCount, ...connection } = raw;
  return createHash("sha256").update(JSON.stringify(canonical({ name, connection }))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
