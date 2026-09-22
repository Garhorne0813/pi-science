import { isUtf8 } from "node:buffer";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { resolveArtifactContent } from "../../runtime/artifacts/artifact-content-store.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

const MAX_INLINE_BYTES = 50 * 1024 * 1024;
const contentTypes: Record<string, string> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".htm": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

function queryValue(request: { query: unknown }, key: string, fallback = ""): string {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" ? value : fallback;
}

async function workspace(request: { query: unknown }): Promise<string> {
  return validateWorkspaceCwd(queryValue(request, "cwd", "."));
}

function parseMaxBytes(request: { query: unknown }): number | null {
  const value = queryValue(request, "maxBytes", "");
  if (!value) return null;
  if (!/^\d+$/.test(value)) throw new Error("maxBytes must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_INLINE_BYTES) throw new Error("maxBytes must be a positive integer no larger than 50 MiB");
  return parsed;
}

async function readFileChunk(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const chunk = buffer.subarray(0, bytesRead);
    if (bytesRead < maxBytes || isUtf8(chunk)) return chunk;
    const extra = Buffer.alloc(4);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, extra.length, bytesRead);
    for (let length = 1; length <= extraBytes; length += 1) {
      const candidate = Buffer.concat([chunk, extra.subarray(0, length)]);
      if (isUtf8(candidate)) return candidate;
    }
    return chunk;
  } finally {
    await handle.close();
  }
}

export function registerArtifactContentRoutes(app: FastifyInstance): void {
  app.get<{ Params: { sha256: string } }>("/api/artifacts/content/:sha256/serve", async (request, reply) => {
    try {
      const cwd = await workspace(request);
      const requestedPath = queryValue(request, "path", "");
      if (!requestedPath) return reply.code(400).send({ error: "path is required" });
      const resolved = await resolveArtifactContent(cwd, requestedPath, request.params.sha256);
      const info = await stat(resolved.file);
      if (!info.isFile()) return reply.code(404).send({ error: "Artifact content not found" });
      const type = contentTypes[extname(resolved.path).toLowerCase()] ?? "application/octet-stream";
      return reply.type(type).send(createReadStream(resolved.file));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sha256: string } }>("/api/artifacts/content/:sha256", async (request, reply) => {
    try {
      const cwd = await workspace(request);
      const requestedPath = queryValue(request, "path", "");
      if (!requestedPath) return reply.code(400).send({ error: "path is required" });
      const maxBytes = parseMaxBytes(request);
      const resolved = await resolveArtifactContent(cwd, requestedPath, request.params.sha256);
      const info = await stat(resolved.file);
      if (!info.isFile()) return reply.code(404).send({ error: "Artifact content not found" });
      if (maxBytes === null && info.size > MAX_INLINE_BYTES) return reply.code(400).send({ error: `Artifact content is too large to read (${info.size} bytes).` });
      const data = maxBytes === null ? await readFile(resolved.file) : await readFileChunk(resolved.file, maxBytes);
      const forceBase64 = queryValue(request, "format", "text") === "base64";
      const encoding = !forceBase64 && isUtf8(data) ? "utf8" : "base64";
      return {
        path: resolved.path,
        mime: contentTypes[extname(resolved.path).toLowerCase()] ?? "application/octet-stream",
        encoding,
        data: encoding === "utf8" ? data.toString("utf8") : data.toString("base64"),
        size: data.byteLength,
        ...(data.byteLength < info.size ? { truncated: true } : {}),
      };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
