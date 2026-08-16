import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { resolveWorkspaceFile, validateWorkspaceCwd } from "../../security/workspace-security.js";
import { recordProvenance } from "./artifact-routes.js";
import { appendJsonLine, workspaceFile } from "../../storage/persistence.js";

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
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

function queryValue(request: { query: unknown }, key: string, fallback = ""): string {
  const query = request.query as Record<string, unknown>;
  return typeof query[key] === "string" ? query[key] : fallback;
}

function parseMultipartUpload(body: Buffer, contentType: string): { filename: string; content?: Buffer } {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundaryValue = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundaryValue) return { filename: "" };
  const boundary = Buffer.from(`--${boundaryValue}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  let cursor = 0;
  while (cursor < body.length) {
    const partStart = body.indexOf(boundary, cursor);
    if (partStart < 0) break;
    const markerEnd = partStart + boundary.length;
    if (body.subarray(markerEnd, markerEnd + 2).equals(Buffer.from("--"))) break;
    let headerStart = markerEnd;
    if (body[headerStart] === 13 && body[headerStart + 1] === 10) headerStart += 2;
    const headerEnd = body.indexOf(headerSeparator, headerStart);
    if (headerEnd < 0) break;
    const header = body.subarray(headerStart, headerEnd).toString("utf8");
    const nextBoundary = body.indexOf(boundary, headerEnd + headerSeparator.length);
    if (nextBoundary < 0) break;
    cursor = nextBoundary;
    if (!/filename=/i.test(header)) continue;
    let contentEnd = nextBoundary;
    if (body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) contentEnd -= 2;
    return {
      filename: header.match(/filename="([^"]+)"/i)?.[1] ?? header.match(/filename=([^;\r\n]+)/i)?.[1]?.trim() ?? "",
      content: body.subarray(headerEnd + headerSeparator.length, contentEnd),
    };
  }
  return { filename: "" };
}

async function safeWorkspace(request: { query: unknown }): Promise<string> {
  return validateWorkspaceCwd(queryValue(request, "cwd", "."));
}

function normalizeApiPath(path: string): string { return path.replaceAll("\\", "/"); }
function apiPath(root: string, target: string): string { return relative(root, target).split(sep).join("/"); }
async function resolveApiFile(root: string, path: string): Promise<string> { return resolveWorkspaceFile(root, normalizeApiPath(path)); }

export function registerFileReadRoutes(app: FastifyInstance): void {
  // Keep the public upload contract used by the browser without bringing a
  // second multipart implementation into the Python runtime.
  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.get("/api/files", async (request, reply) => {
    let root: string;
    try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    const subdir = queryValue(request, "subdir", ".");
    let target: string;
    try { target = await resolveApiFile(root, subdir); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const rows = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = join(target, entry.name);
        const metadata = await stat(path);
        rows.push({ path: relative(root, path).split(sep).join("/"), name: entry.name, isDir: entry.isDirectory(), size: metadata.size, modified: metadata.mtimeMs / 1000 });
      }
      return rows.sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name));
    } catch {
      return [];
    }
  });

  app.get("/api/files/breadcrumbs", async (request, reply) => {
    let root: string;
    try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    const subdir = queryValue(request, "subdir", "");
    if (!subdir) return [];
    try {
      const target = await resolveApiFile(root, subdir);
      const parts = relative(root, target).split(/[\\/]/).filter(Boolean);
      return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
  });

  app.post("/api/files/upload", async (request, reply) => {
    let root: string;
    try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = request.body as Buffer | Record<string, unknown> | undefined;
    const queryPath = queryValue(request, "path", "");
    let filename = "";
    let content: Buffer | undefined;
    if (Buffer.isBuffer(body)) {
      ({ filename, content } = parseMultipartUpload(body, String(request.headers["content-type"] ?? "")));
    } else if (body && typeof body === "object") {
      filename = typeof body.filename === "string" ? body.filename : "";
      if (typeof body.content_base64 === "string") content = Buffer.from(body.content_base64, "base64");
      else if (typeof body.content === "string") content = Buffer.from(body.content, "utf8");
    }
    const bodyPath = body && typeof body === "object" && !Buffer.isBuffer(body) && typeof body.path === "string" ? body.path : "";
    const requestedPath = queryPath || bodyPath || (filename.split(/[\\/]/).at(-1) ?? "");
    if (!requestedPath || requestedPath === "." || requestedPath === ".." || !content) return reply.code(400).send({ error: "Invalid upload" });
    try {
      const destination = await resolveApiFile(root, requestedPath);
      const relativePath = apiPath(root, destination);
      try { await stat(destination); return reply.code(409).send({ error: `File already exists: ${relativePath}` }); } catch { /* expected */ }
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, destination);
      await appendJsonLine(workspaceFile(root, "provenance.jsonl"), { path: relativePath, version: 1, ts: Date.now() / 1000, tool: "file_upload", sessionId: "", contentHash: "", content: null });
      return { ok: true, path: relativePath, filename: basename(destination) };
    } catch (error) { return reply.code(403).send({ error: String(error) }); }
  });

  app.post("/api/files/move", async (request, reply) => moveFile(request, reply, "move"));
  app.post("/api/files/rename", async (request, reply) => moveFile(request, reply, "rename"));
  app.post("/api/files/content", async (request, reply) => {
    let root: string;
    try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as { path?: unknown; content?: unknown };
    if (typeof body.path !== "string" || typeof body.content !== "string") {
      return reply.code(400).send({ error: "path and content are required" });
    }
    try {
      const target = await resolveApiFile(root, body.path);
      const relativePath = apiPath(root, target);
      const metadata = await stat(target);
      if (!metadata.isFile()) return reply.code(400).send({ error: `Not a file: ${relativePath}` });
      if (metadata.size > 50 * 1024 * 1024) {
        return reply.code(400).send({ error: `File too large to edit (${metadata.size} bytes).` });
      }
      // Refuse binary content that round-trips as lossy text (UTF-8 re-encode
      // of a PDF/PNG would corrupt the file). Only allow overwrites when the
      // existing file reads back as UTF-8 text.
      const existing = await readFile(target);
      if (!isUtf8(existing)) {
        return reply.code(400).send({ error: `Cannot edit binary file: ${relativePath}` });
      }
      await writeFile(target, Buffer.from(body.content, "utf8"));
      // Record the edit with a content snapshot and an auto-incremented version
      // (v1, v2, …) so the version-history panel can show every revision.
      // recordProvenance computes version = max(version for path) + 1 and
      // stores contentHash + content (truncated to 100k) for diffing.
      await recordProvenance(root, {
        path: relativePath,
        tool: "file_edit",
        session_id: "",
        content: body.content,
      });
      return { ok: true, path: relativePath, size: Buffer.byteLength(body.content, "utf8") };
    } catch (error) {
      // Path containment/validation failures are 403 (matching the sibling file
      // routes); missing files stay 404; write-side failures (EACCES, ENOSPC)
      // surface as 500 so the client does not mistake them for a missing path.
      if (error instanceof Error && /escapes the workspace|must be relative|metadata paths/i.test(error.message)) {
        return reply.code(403).send({ error: error.message });
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: `File not found: ${body.path}` });
      }
      return reply.code(500).send({ error: String(error) });
    }
  });
  app.get("/api/files/probe/*", async (request, reply) => {
    try {
      const root = await safeWorkspace(request);
      const wildcard = (request.params as { path?: string; "*"?: string }).path ?? (request.params as { "*"?: string })["*"] ?? "";
      const target = await resolveApiFile(root, wildcard);
      const info = await stat(target);
      return { path: apiPath(root, target), name: basename(target), size: info.size, modified: info.mtimeMs / 1000, is_dir: info.isDirectory() };
    } catch (error) { return reply.code(404).send({ error: String(error) }); }
  });
  app.delete<{ Params: { path: string } }>("/api/files/*", async (request, reply) => {
    let root: string;
    try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    const wildcard = (request.params as { path?: string; "*"?: string }).path ?? (request.params as { "*"?: string })["*"] ?? "";
    try {
      const target = await resolveApiFile(root, wildcard);
      const info = await stat(target);
      if (info.isDirectory()) await rm(target, { recursive: false }); else await rm(target);
      await appendJsonLine(workspaceFile(root, "provenance.jsonl"), { path: apiPath(root, target), version: 1, ts: Date.now() / 1000, tool: "file_delete", sessionId: "" });
      return { ok: true };
    } catch (error) { return reply.code(404).send({ error: String(error) }); }
  });

  app.get<{ Params: { path: string } }>("/api/files/serve/*", async (request, reply) => serveFile(request, reply, "serve"));
  app.get<{ Params: { path: string } }>("/api/files/*", async (request, reply) => {
    const wildcard = normalizeApiPath((request.params as { path?: string; "*"?: string }).path ?? (request.params as { "*"?: string })["*"] ?? "");
    if (wildcard.endsWith("/preview")) return previewFile(request, reply, wildcard.slice(0, -"/preview".length));
    if (wildcard.endsWith("/raw")) return serveFile(request, reply, "raw");
    return readWorkspaceFile(request, reply, wildcard);
  });
}

async function readWorkspaceFile(
  request: { query: unknown },
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  path: string,
) {
  let root: string;
  try { root = await safeWorkspace(request); }
  catch (error) { return reply.code(403).send({ error: String(error) }); }
  let target: string;
  try { target = await resolveApiFile(root, path); }
  catch (error) { return reply.code(403).send({ error: String(error) }); }
  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) return reply.code(400).send({ error: `Not a file: ${path}` });
    if (metadata.size > 50 * 1024 * 1024) return reply.code(400).send({ error: `File too large to read (${metadata.size} bytes). Use /api/files/probe for structure.` });
    // Optional snippet read: cap the response to the first N bytes (used by
    // per-turn artifact cards to preview file content without transferring
    // the whole file). Reads only the requested window from disk.
    let maxBytes: number | null = null;
    const maxBytesRaw = queryValue(request, "maxBytes", "");
    if (maxBytesRaw !== "") {
      if (!/^\d+$/.test(maxBytesRaw)) return reply.code(400).send({ error: "maxBytes must be a positive integer" });
      const parsed = Number(maxBytesRaw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return reply.code(400).send({ error: "maxBytes must be a positive integer" });
      maxBytes = parsed;
    }
    const truncated = maxBytes !== null && metadata.size > maxBytes;
    const data = maxBytes !== null ? await readFileChunk(target, maxBytes) : await readFile(target);
    const forceBase64 = queryValue(request, "format", "text") === "base64";
    const encoding = !forceBase64 && isUtf8(data) ? "utf8" : "base64";
    return {
      path: apiPath(root, target),
      encoding,
      data: encoding === "utf8" ? data.toString("utf8") : data.toString("base64"),
      size: data.byteLength,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    return reply.code(404).send({ error: String(error) });
  }
}

/** Read only the first `maxBytes` bytes of a file without loading the rest. */
async function readFileChunk(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const chunk = buffer.subarray(0, bytesRead);
    if (bytesRead < maxBytes || isUtf8(chunk)) return chunk;

    // A byte cap can land in the middle of a multi-byte UTF-8 character. Read
    // a few bytes beyond the cap so text previews remain decodable instead of
    // being misclassified as binary. The returned window may exceed maxBytes
    // by at most three bytes; binary data still falls back to the original
    // invalid chunk and is encoded as base64 by the caller.
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

async function previewFile(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, path: string) {
  try {
    const root = await safeWorkspace(request);
    const target = await resolveApiFile(root, path);
    const info = await stat(target);
    if (!info.isFile()) return reply.code(400).send({ error: "Not a file" });
    return { path: apiPath(root, target), name: basename(target), size: info.size, modified: info.mtimeMs / 1000, extension: extname(target), preview: null };
  } catch (error) { return reply.code(404).send({ error: String(error) }); }
}

async function moveFile(request: { query: unknown; body?: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, action: string) {
  let root: string;
  try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
  const body = (request.body ?? {}) as { source?: unknown; target?: unknown };
  if (typeof body.source !== "string" || typeof body.target !== "string") return reply.code(400).send({ error: "source and target are required" });
  try {
    const source = await resolveApiFile(root, body.source);
    const target = await resolveApiFile(root, body.target);
    const sourcePath = apiPath(root, source); const targetPath = apiPath(root, target);
    try { await stat(target); return reply.code(409).send({ error: "Target already exists" }); } catch { /* expected */ }
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    await appendJsonLine(workspaceFile(root, "provenance.jsonl"), { path: targetPath, version: 1, ts: Date.now() / 1000, tool: `file_${action}`, sessionId: "", diff: `${sourcePath} -> ${targetPath}` });
    return { ok: true, source: sourcePath, target: targetPath };
  } catch (error) { return reply.code(400).send({ error: String(error) }); }
}

async function serveFile(request: { params: { path?: string }; query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown }; type: (value: string) => { send: (body: unknown) => unknown }; send: (body: unknown) => unknown }, prefix: string) {
  try {
    const root = await safeWorkspace(request);
    const path = normalizeApiPath(request.params.path ?? (request.params as { "*"?: string })["*"] ?? "");
    const relativePath = prefix === "raw" ? path.replace(/\/raw$/, "") : path;
    const file = await resolveApiFile(root, relativePath);
    const metadata = await stat(file);
    if (!metadata.isFile()) return reply.code(400).send({ error: "Not a file" });
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    const response = createReadStream(file);
    return reply.type(contentTypes[extension] ?? "application/octet-stream").send(response);
  } catch (error) {
    return reply.code(403).send({ error: String(error) });
  }
}
