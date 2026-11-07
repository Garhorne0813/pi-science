import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { sessionApprovalPath } from "./session-approval.js";
import { readOperatorConfig } from "./operator-config.js";
import { writeJsonAtomic } from "../../storage/persistence.js";
import { networkDomain, networkGrantProfile } from "./network-grant-state.js";

const endpointSchema = z
  .object({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const requestSchema = z
  .object({
    domain: networkDomain,
    profile: networkGrantProfile,
    contextId: z.string().uuid().optional(),
  })
  .strict();
export type NetworkApprovalEndpoint = z.infer<typeof endpointSchema>;
const channelPath = async (cwd: string, sessionId: string) =>
  (await sessionApprovalPath(cwd, sessionId)) + ".network";

/** Service-owned descriptor is copied only into the private launcher manifest.
 * The workload never receives this token or access to the approval endpoint. */
async function readEndpoint(path: string): Promise<NetworkApprovalEndpoint | undefined> {
  try {
    return endpointSchema.parse(await readOperatorConfig(path, 4096));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function networkApprovalEndpoint(cwd: string, sessionId: string) {
  return readEndpoint(await channelPath(cwd, sessionId));
}

export async function startNetworkApprovalChannel(
  cwd: string,
  sessionId: string,
  approve: (request: z.infer<typeof requestSchema>, signal: AbortSignal) => Promise<boolean>,
) {
  const token = randomBytes(32).toString("hex");
  const lifetime = new AbortController();
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      req.method !== "POST" ||
      req.url !== "/" ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(403).end();
      return;
    }
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new Error("Approval request too large");
        chunks.push(chunk);
      }
      const params = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const signal = AbortSignal.any([
        controller.signal,
        lifetime.signal,
        AbortSignal.timeout(120_000),
      ]);
      const allowed = await approve(params, signal);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ allowed }));
    } catch {
      if (!res.destroyed) res.writeHead(403).end();
    }
  });
  server.maxConnections = 32;
  server.requestTimeout = 125_000;
  server.headersTimeout = 5_000;
  const path = await channelPath(cwd, sessionId);
  const close = async () => {
    lifetime.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const current = await readEndpoint(path);
    if (current?.token === token)
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = { port: (server.address() as { port: number }).port, token };
    await writeJsonAtomic(path, endpoint, { mode: 0o600 });
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
