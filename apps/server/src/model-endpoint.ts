import { createHash } from "node:crypto";

/** Stable identity for a configured model endpoint, independent of transport. */
export function endpointId(name: string, baseUrl: string): string {
  return createHash("sha256").update(`${name}:${baseUrl}`).digest("hex").slice(0, 20);
}
