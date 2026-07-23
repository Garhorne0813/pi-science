import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import type { FastifyInstance } from "fastify";
import { resolveWorkspaceFile, validateWorkspaceCwd } from "./workspace-security.js";
import { appendJsonLine, workspaceFile } from "./persistence.js";

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
};

function queryValue(request: { query: unknown }, key: string, fallback = ""): string {
  const query = request.query as Record<string, unknown>;
  return typeof query[key] === "string" ? query[key] : fallback;
}

async function safeWorkspace(request: { query: unknown }): Promise<string> {
  return validateWorkspaceCwd(queryValue(request, "cwd", "."));
}

export function registerFileReadRoutes(app: FastifyInstance): void {
  // Keep the public upload contract used by the browser without bringing a
  // second multipart implementation into the Python runtime.
  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.get("/api/files", async (request, reply) => {
    let root: string;
    try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    const subdir = queryValue(request, "subdir", ".");
    let target: string;
    try { target = await resolveWorkspaceFile(root, subdir); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const rows = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = `${target}/${entry.name}`;
        const metadata = await stat(path);
        rows.push({ path: relative(root, path), name: entry.name, isDir: entry.isDirectory(), size: metadata.size, modified: metadata.mtimeMs / 1000 });
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
      const target = await resolveWorkspaceFile(root, subdir);
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
    let filename = "";
    let content: Buffer | undefined;
    if (Buffer.isBuffer(body)) {
      const contentType = String(request.headers["content-type"] ?? "");
      const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
      if (boundary) {
        const source = body.toString("latin1");
        const part = source.split(`--${boundary}`).find((chunk) => /filename=/i.test(chunk));
        if (part) {
          const headerEnd = part.indexOf("\r\n\r\n");
          const header = headerEnd >= 0 ? part.slice(0, headerEnd) : "";
          filename = header.match(/filename="([^"]+)"/i)?.[1] ?? header.match(/filename=([^;\r\n]+)/i)?.[1]?.trim() ?? "";
          const payload = headerEnd >= 0 ? part.slice(headerEnd + 4).replace(/\r\n--?$/, "") : "";
          content = Buffer.from(payload, "latin1");
        }
      }
    } else if (body && typeof body === "object") {
      filename = typeof body.filename === "string" ? body.filename : "";
      if (typeof body.content_base64 === "string") content = Buffer.from(body.content_base64, "base64");
      else if (typeof body.content === "string") content = Buffer.from(body.content, "utf8");
    }
    filename = filename.split(/[\\/]/).at(-1) ?? "";
    if (!filename || filename === "." || filename === ".." || !content) return reply.code(400).send({ error: "Invalid upload" });
    try {
      const destination = await resolveWorkspaceFile(root, filename);
      try { await stat(destination); return reply.code(409).send({ error: `File already exists: ${filename}` }); } catch { /* expected */ }
      await mkdir(root, { recursive: true });
      const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, destination);
      await appendJsonLine(workspaceFile(root, "provenance.jsonl"), { path: filename, version: 1, ts: Date.now() / 1000, tool: "file_upload", sessionId: "", contentHash: "", content: null });
      return { ok: true, path: filename, filename };
    } catch (error) { return reply.code(403).send({ error: String(error) }); }
  });

  app.post("/api/files/move", async (request, reply) => moveFile(request, reply, "move"));
  app.post("/api/files/rename", async (request, reply) => moveFile(request, reply, "rename"));
  app.get("/api/files/probe/*", async (request, reply) => {
    try {
      const root = await safeWorkspace(request);
      const wildcard = (request.params as { path?: string; "*"?: string }).path ?? (request.params as { "*"?: string })["*"] ?? "";
      const target = await resolveWorkspaceFile(root, wildcard);
      const info = await stat(target);
      return { path: wildcard, name: target.slice(target.lastIndexOf("/") + 1), size: info.size, modified: info.mtimeMs / 1000, is_dir: info.isDirectory() };
    } catch (error) { return reply.code(404).send({ error: String(error) }); }
  });
  app.delete<{ Params: { path: string } }>("/api/files/*", async (request, reply) => {
    let root: string;
    try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
    const wildcard = (request.params as { path?: string; "*"?: string }).path ?? (request.params as { "*"?: string })["*"] ?? "";
    try {
      const target = await resolveWorkspaceFile(root, wildcard);
      const info = await stat(target);
      if (info.isDirectory()) await rm(target, { recursive: false }); else await rm(target);
      await appendJsonLine(workspaceFile(root, "provenance.jsonl"), { path: wildcard, version: 1, ts: Date.now() / 1000, tool: "file_delete", sessionId: "" });
      return { ok: true };
    } catch (error) { return reply.code(404).send({ error: String(error) }); }
  });

  app.get<{ Params: { path: string } }>("/api/files/serve/*", async (request, reply) => serveFile(request, reply, "serve"));
  app.get<{ Params: { path: string } }>("/api/files/*", async (request, reply) => {
    const wildcard = (request.params as { path?: string; "*"?: string }).path ?? (request.params as { "*"?: string })["*"] ?? "";
    if (wildcard.endsWith("/preview")) return previewFile(request, reply, wildcard.slice(0, -"/preview".length));
    if (!wildcard.endsWith("/raw")) return reply.code(404).send({ error: "File route not found" });
    return serveFile(request, reply, "raw");
  });
}

async function previewFile(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, path: string) {
  try {
    const root = await safeWorkspace(request);
    const target = await resolveWorkspaceFile(root, path);
    const info = await stat(target);
    if (!info.isFile()) return reply.code(400).send({ error: "Not a file" });
    return { path, name: target.slice(target.lastIndexOf("/") + 1), size: info.size, modified: info.mtimeMs / 1000, extension: target.slice(target.lastIndexOf(".")), preview: null };
  } catch (error) { return reply.code(404).send({ error: String(error) }); }
}

async function moveFile(request: { query: unknown; body?: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, action: string) {
  let root: string;
  try { root = await safeWorkspace(request); } catch (error) { return reply.code(403).send({ error: String(error) }); }
  const body = (request.body ?? {}) as { source?: unknown; target?: unknown };
  if (typeof body.source !== "string" || typeof body.target !== "string") return reply.code(400).send({ error: "source and target are required" });
  try {
    const source = await resolveWorkspaceFile(root, body.source);
    const target = await resolveWorkspaceFile(root, body.target);
    try { await stat(target); return reply.code(409).send({ error: "Target already exists" }); } catch { /* expected */ }
    await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await rename(source, target);
    await appendJsonLine(workspaceFile(root, "provenance.jsonl"), { path: body.target, version: 1, ts: Date.now() / 1000, tool: `file_${action}`, sessionId: "", diff: `${body.source} -> ${body.target}` });
    return { ok: true, source: body.source, target: body.target };
  } catch (error) { return reply.code(400).send({ error: String(error) }); }
}

async function serveFile(request: { params: { path?: string }; query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown }; type: (value: string) => { send: (body: unknown) => unknown }; send: (body: unknown) => unknown }, prefix: string) {
  try {
    const root = await safeWorkspace(request);
    const path = request.params.path ?? (request.params as { "*"?: string })["*"] ?? "";
    const relativePath = prefix === "raw" ? path.replace(/\/raw$/, "") : path;
    const file = await resolveWorkspaceFile(root, relativePath);
    const metadata = await stat(file);
    if (!metadata.isFile()) return reply.code(400).send({ error: "Not a file" });
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    const response = createReadStream(file);
    return reply.type(contentTypes[extension] ?? "application/octet-stream").send(response);
  } catch (error) {
    return reply.code(403).send({ error: String(error) });
  }
}
