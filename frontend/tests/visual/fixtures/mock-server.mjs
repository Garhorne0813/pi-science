/** Playwright-managed mock server for the visual regression suite.
 *
 *  Started and stopped by playwright.visual.config.ts's webServer block for
 *  the duration of a `test:visual` run only — it never runs persistently and
 *  is never used during development.
 *
 *  Responsibilities:
 *  - Serve the production build (frontend/dist) with an SPA fallback.
 *  - Serve a fixed /api/* surface (REST + a real keep-alive SSE stream) from
 *    fixtures/data.mjs so screenshots are deterministic: same data, same
 *    times, same order, every run.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, VISUAL_CWD } from "./data.mjs";

const distRoot = resolve(fileURLToPath(new URL("../../../dist", import.meta.url)));
const port = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function sendFile(res, filePath) {
  const data = await readFile(filePath);
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream", "Content-Length": data.length });
  res.end(data);
}

function sendSse(res, sessionId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Settled conversation: the session is idle from the first byte. Keeping
  // the socket open (with periodic comments) holds EventSource in OPEN state,
  // so the UI shows the deterministic "ready" state instead of reconnecting.
  send("session.idle", { type: "session.idle", sessionId });
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  res.on("close", () => clearInterval(keepAlive));
  res.on("error", () => clearInterval(keepAlive));
}

function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || "GET";
  const log = () => console.log(`[mock] ${method} ${pathname}${searchParams.size ? `?${searchParams}` : ""}`);

  // Health probe (also the webServer readiness URL).
  if (method === "GET" && pathname === "/api/health") {
    log();
    return json(res, 200, { status: "ok" });
  }

  // Projects page.
  if (method === "GET" && pathname === "/api/workspaces") {
    log();
    return json(res, 200, FIXTURES.workspaces);
  }
  if (method === "GET" && pathname === "/api/workspaces/pinned") {
    log();
    return json(res, 200, { paths: [] });
  }

  // Settings / model config.
  if (method === "GET" && pathname === "/api/settings/config") {
    log();
    return json(res, 200, FIXTURES.config);
  }

  // Session list + lazy creation.
  if (method === "GET" && pathname === "/api/sessions") {
    log();
    return json(res, 200, FIXTURES.sessions);
  }
  if (method === "POST" && pathname === "/api/sessions") {
    log();
    return json(res, 200, { id: "visual-created-session", cwd: VISUAL_CWD, project_id: "proj-visual-demo" });
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)(\/[^?]*)?$/.exec(pathname);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const sub = sessionMatch[2] || "";

    if (method === "GET" && sub === "/messages/index") {
      log();
      return json(res, 200, FIXTURES.userMessageIndex);
    }
    if (method === "GET" && sub === "/messages") {
      log();
      return json(res, 200, {
        messages: sessionId === FIXTURES.sessions[0].id ? FIXTURES.history : [],
        next_cursor: null,
        has_more: false,
        snapshot_version: "fixture-v1",
      });
    }
    if (method === "GET" && sub === "/state") {
      log();
      return json(res, 200, FIXTURES.sessionState);
    }
    if (method === "GET" && sub === "/artifacts") {
      log();
      return json(res, 200, { turns: FIXTURES.artifactTurns });
    }
    if (method === "GET" && sub === "/events") {
      log();
      return sendSse(res, sessionId);
    }
    if ((method === "POST" || method === "PATCH" || method === "PUT") && sub === "/title") {
      log();
      return json(res, 200, {});
    }
    if (method === "POST" && (sub === "/prompt" || sub === "/resume" || sub === "/abort")) {
      log();
      return json(res, 200, { ok: true });
    }
  }

  // File browser + file content.
  if (method === "GET" && pathname === "/api/files") {
    log();
    return json(res, 200, FIXTURES.files);
  }
  if (method === "GET" && pathname === "/api/files/breadcrumbs") {
    log();
    return json(res, 200, []);
  }
  if (method === "GET" && pathname.startsWith("/api/files/")) {
    log();
    const filePath = decodeURIComponent(pathname.slice("/api/files/".length));
    if (filePath === "analysis/report.md") {
      return json(res, 200, { encoding: "utf8", data: FIXTURES.reportMarkdown });
    }
    return json(res, 404, { error: "fixture file not found", file: filePath });
  }

  // Knowledge badge + research-loop landing probe.
  if (method === "GET" && pathname === "/api/project-knowledge/proposals/count") {
    log();
    return json(res, 200, { pending_count: 0 });
  }
  if (method === "GET" && pathname === "/api/project-knowledge/events") {
    log();
    return sendSse(res, "knowledge");
  }
  if (method === "GET" && pathname === "/api/project-knowledge/policy") {
    log();
    return json(res, 200, {});
  }
  if (method === "GET" && pathname === "/api/project-memory/research-loops") {
    log();
    return json(res, 200, { loops: [] });
  }
  if (method === "GET" && pathname === "/api/executions") {
    log();
    return json(res, 200, []);
  }
  if (method === "GET" && pathname === "/api/executions/events") {
    log();
    return sendSse(res, "executions");
  }
  if (method === "GET" && pathname === "/api/settings/subagents/discovery") {
    log();
    return json(res, 200, []);
  }
  if (method === "GET" && pathname.endsWith("/commands")) {
    log();
    return json(res, 200, []);
  }

  // Anything else: make the gap visible in the test output instead of
  // silently returning a shape the app cannot use.
  log();
  return json(res, 501, { error: `mock server does not handle ${method} ${pathname}` });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }

  let filePath = normalize(join(distRoot, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(distRoot)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const info = await stat(filePath);
    if (info.isFile()) return sendFile(res, filePath);
  } catch {
    // fall through to the SPA fallback
  }
  try {
    await sendFile(res, join(distRoot, "index.html"));
  } catch {
    res.writeHead(500);
    res.end("dist/index.html missing — run `pnpm --filter frontend build` before `test:visual`");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] visual fixture server on http://127.0.0.1:${port} serving ${distRoot}`);
});
