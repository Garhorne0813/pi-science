import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const moduleDir = fileURLToPath(new URL(".", import.meta.url));

export function frontendDist(): string {
  return process.env.PI_SCIENCE_FRONTEND_DIST || resolve(moduleDir, "../../../../frontend/dist");
}

function mimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export async function serveFrontend(pathname: string): Promise<{ type: string; stream: NodeJS.ReadableStream } | { error: string }> {
  const dist = resolve(frontendDist());
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "").split("?")[0]!;
  const file = resolve(dist, relative);
  if (file !== dist && !file.startsWith(`${dist}${sep}`)) return { error: "Forbidden" };
  try {
    const info = await stat(file);
    if (info.isFile()) return { type: mimeType(file), stream: createReadStream(file) };
  } catch {
    // Fall through to the SPA entry when the file is absent.
  }
  const index = resolve(dist, "index.html");
  try {
    const info = await stat(index);
    if (info.isFile()) return { type: "text/html; charset=utf-8", stream: createReadStream(index) };
  } catch {
    return { error: "Frontend build not found; run pnpm build first or set PI_SCIENCE_FRONTEND_DIST" };
  }
  return { error: "Frontend build not found; run pnpm build first or set PI_SCIENCE_FRONTEND_DIST" };
}