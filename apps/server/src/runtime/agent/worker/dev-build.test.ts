import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDevWorker,
  buildWorkerMirror,
  devWorkerEntry,
  newestSourceMtime,
} from "./dev-build.js";

const roots: string[] = [];

function fixture(): { serverRoot: string; contractsRoot: string; sourceRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dev-worker-"));
  roots.push(root);
  const serverRoot = join(root, "apps", "server");
  const contractsRoot = join(root, "packages", "contracts");
  const sourceRoot = join(serverRoot, "src");
  mkdirSync(join(sourceRoot, "runtime", "agent", "worker"), { recursive: true });
  mkdirSync(join(contractsRoot, "src"), { recursive: true });
  writeFileSync(join(contractsRoot, "src", "index.ts"), "export type Marker = string;\n");
  writeFileSync(
    join(sourceRoot, "runtime", "agent", "worker", "util.ts"),
    "export const answer: number = 42;\n",
  );
  writeFileSync(
    join(sourceRoot, "runtime", "agent", "worker", "main.ts"),
    'import { answer } from "./util.js";\nconst label: string = "ready";\nprocess.stdout.write(`${label} ${answer}`);\n',
  );
  writeFileSync(join(sourceRoot, "runtime", "agent", "worker", "payload.json"), '{"ok":true}\n');
  return { serverRoot, contractsRoot, sourceRoot };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("dev worker mirror", () => {
  it("transpiles sources next to the tree and copies runtime assets", () => {
    const { serverRoot, contractsRoot, sourceRoot } = fixture();
    const entry = buildDevWorker({ serverRoot, contractsRoot });
    expect(entry).toBe(join(serverRoot, ".dev-dist", "runtime", "agent", "worker", "main.js"));
    expect(existsSync(entry)).toBe(true);
    const compiled = readFileSync(entry, "utf8");
    expect(compiled).not.toContain(": number");
    expect(compiled).not.toContain(": string");
    expect(compiled).toContain('from "./util.js"');
    expect(
      readFileSync(join(serverRoot, ".dev-dist", "runtime", "agent", "worker", "util.js"), "utf8"),
    ).toContain("42");
    expect(
      readFileSync(
        join(serverRoot, ".dev-dist", "runtime", "agent", "worker", "payload.json"),
        "utf8",
      ),
    ).toContain('"ok"');
    expect(newestSourceMtime(sourceRoot, contractsRoot)).toBeGreaterThan(0);
  });

  it("reuses a fresh mirror and rebuilds when a source changes", () => {
    const { serverRoot, contractsRoot, sourceRoot } = fixture();
    vi.stubEnv("NODE_ENV", "development");
    const entry = devWorkerEntry({ serverRoot, contractsRoot });
    expect(entry).not.toBeNull();
    expect(readFileSync(entry!, "utf8")).not.toContain("stale");

    const source = join(sourceRoot, "runtime", "agent", "worker", "util.ts");
    writeFileSync(source, "export const answer: number = 7; // stale\n");
    const future = new Date(Date.now() + 5_000);
    utimesSync(source, future, future);
    expect(
      statSync(join(serverRoot, ".dev-dist", "runtime", "agent", "worker", "util.js")).mtimeMs,
    ).toBeLessThan(future.getTime());

    expect(devWorkerEntry({ serverRoot, contractsRoot })).toBe(entry);
    expect(
      readFileSync(join(serverRoot, ".dev-dist", "runtime", "agent", "worker", "util.js"), "utf8"),
    ).toContain("7");
  });

  it("stays out of the way of tests and explicit opt-outs", () => {
    const { serverRoot, contractsRoot } = fixture();
    vi.stubEnv("NODE_ENV", "test");
    expect(devWorkerEntry({ serverRoot, contractsRoot })).toBeNull();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PI_SCIENCE_DEV_WORKER", "0");
    expect(devWorkerEntry({ serverRoot, contractsRoot })).toBeNull();
  });

  it("returns null when there is no worker source to compile", () => {
    const { serverRoot, contractsRoot, sourceRoot } = fixture();
    rmSync(sourceRoot, { recursive: true, force: true });
    vi.stubEnv("NODE_ENV", "development");
    expect(devWorkerEntry({ serverRoot, contractsRoot })).toBeNull();
  });

  it("fails loudly when the source tree has no TypeScript files", () => {
    const { serverRoot } = fixture();
    const empty = join(serverRoot, "empty-src");
    mkdirSync(empty, { recursive: true });
    expect(() => buildWorkerMirror(empty, join(serverRoot, ".dev-dist"))).toThrow(
      "no TypeScript sources to precompile",
    );
  });
});
