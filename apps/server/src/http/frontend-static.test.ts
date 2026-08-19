import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { serveFrontend } from "./frontend-static.js";

const originalDist = process.env.PI_SCIENCE_FRONTEND_DIST;
const cleanup: string[] = [];

afterEach(async () => {
  if (originalDist === undefined) delete process.env.PI_SCIENCE_FRONTEND_DIST;
  else process.env.PI_SCIENCE_FRONTEND_DIST = originalDist;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function asText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream as never)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

describe("frontend static serving", () => {
  it("serves index.html and falls back to the SPA entry for client routes", async () => {
    const dist = await mkdtemp(join(tmpdir(), "pi-science-frontend-"));
    cleanup.push(dist);
    process.env.PI_SCIENCE_FRONTEND_DIST = dist;
    await writeFile(join(dist, "index.html"), "<html>pi-science-app</html>", "utf8");

    const root = await serveFrontend("/");
    expect("type" in root).toBe(true);
    if (!("type" in root)) return;
    expect(root.type).toBe("text/html; charset=utf-8");
    expect(await asText(root.stream as never)).toContain("pi-science-app");

    const clientRoute = await serveFrontend("/projects/example");
    expect("type" in clientRoute).toBe(true);
    if (!("type" in clientRoute)) return;
    expect(clientRoute.type).toBe("text/html; charset=utf-8");
    expect(await asText(clientRoute.stream as never)).toContain("pi-science-app");
  });

  it("blocks path traversal and reports a missing build", async () => {
    const dist = await mkdtemp(join(tmpdir(), "pi-science-frontend-"));
    cleanup.push(dist);
    process.env.PI_SCIENCE_FRONTEND_DIST = dist;

    const traversal = await serveFrontend("/../../etc/passwd");
    expect(traversal).toEqual({ error: "Forbidden" });

    const missing = await serveFrontend("/");
    expect(missing).toEqual({ error: "Frontend build not found; run pnpm build first or set PI_SCIENCE_FRONTEND_DIST" });
    const asAny = missing as { error?: string };
    expect(asAny.error).toBeDefined();
  });
});