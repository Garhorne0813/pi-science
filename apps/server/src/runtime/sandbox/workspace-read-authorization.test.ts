import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { workspaceReadBoundary } from "./workspace-read-authorization.js";
let root: string;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
it("shares read denials while allowing discovery to enumerate a protected directory's ancestors", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "discovery-boundary-")));
  const workspace = join(root, "workspace"); await mkdir(join(workspace, "private"), { recursive: true });
  const policy = join(root, "policy.json"); await writeFile(policy, JSON.stringify({ schemaVersion: 1, dependencyRoots: [], protectedRoots: [join(workspace, "private")] }), { mode: 0o600 });
  vi.stubEnv("PI_SCIENCE_SANDBOX_READ_POLICY", policy);
  const read = await workspaceReadBoundary(); const discovery = await workspaceReadBoundary("discovery");
  expect(() => read(workspace, workspace)).toThrow("Protected");
  expect(discovery(workspace, workspace)).toBe(workspace);
  for (const path of ["private", "private/data.txt", ".env", "a/secrets.json", "node_modules/package", "holdout/labels"]) {
    for (const boundary of [read, discovery]) expect(() => boundary(join(workspace, path), workspace)).toThrow();
  }
  expect(() => discovery(root, workspace)).toThrow("outside");
  expect(discovery(join(workspace, "data.csv"), workspace)).toBe(join(workspace, "data.csv"));
});
