import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { CREDENTIAL_NAMES, expandCredentialDenies } from "../src/runtime/sandbox/credential-denies.js";

const files = Number(process.env.CREDENTIAL_BENCH_FILES ?? 100000);
const samples = Number(process.env.CREDENTIAL_BENCH_SAMPLES ?? 3);
const maxP95Ms = process.env.CREDENTIAL_BENCH_MAX_P95_MS === undefined ? null : Number(process.env.CREDENTIAL_BENCH_MAX_P95_MS);
if (!Number.isInteger(files) || files < 1 || files > 300000 || !Number.isInteger(samples) || samples < 3 || samples > 10
  || (maxP95Ms !== null && (!Number.isFinite(maxP95Ms) || maxP95Ms <= 0 || maxP95Ms > 60000))) throw new Error("Benchmark bounds: 1–300000 files, 3–10 samples, 0–60000ms budget");
const require = createRequire(import.meta.url);
const walkerPath = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "dist/sandbox/sandbox-utils.js");
type Walker = (pattern: string, options: { listings: Map<string, Dirent[] | Error>; followSymlinkedDirectories: boolean }) => Generator<unknown, { matches: string[] }, unknown>;
const upstream: unknown = await import(pathToFileURL(walkerPath).href);
const { walkGlobPatternSteps } = upstream as { walkGlobPatternSteps: Walker };
const scratch = await realpath(await mkdtemp(join(tmpdir(), "credential-denies-benchmark-")));
const cases: Array<{ scenario: string; entries: number; directories: number; matches: number; ratio: number; rows: Array<{ operation: string; samples_ms: number[]; p50_ms: number; p95_ms: number }> }> = [];
try {
  for (let offset = 0; offset < files; offset += 100) {
    const group = Math.floor(offset / 100); const directory = join(scratch, `group-${group % 2}`, `part-${group}`);
    await mkdir(directory, { recursive: true });
    const credential = CREDENTIAL_NAMES[group % CREDENTIAL_NAMES.length];
    assert.ok(credential);
    await Promise.all(Array.from({ length: Math.min(100, files - offset) }, (_, index) => writeFile(join(directory, index === 0 ? credential === ".env.*" ? ".env.local" : credential : `ordinary-${offset + index}`), "")));
  }
  const legacy = () => {
    const listings = new Map<string, Dirent[] | Error>(); const paths = new Set<string>();
    for (const name of CREDENTIAL_NAMES) {
      const steps = walkGlobPatternSteps(join(scratch, "**", name), { listings, followSymlinkedDirectories: true });
      for (;;) { const step = steps.next(); if (step.done) { for (const path of step.value.matches) paths.add(path); break; } }
    }
    return [...paths].sort();
  };
  const all = legacy(); const deniedSubtree = join(scratch, "group-0");
  let passed = true;
  for (const [scenario, denied] of [["full", []], ["pruned_subtree", [deniedSubtree]]] as const) {
    const rows: Array<{ operation: string; samples_ms: number[]; p50_ms: number; p95_ms: number }> = [];
    const visible = (paths: string[]) => paths.filter((path) => !denied.some((ancestor) => path === ancestor || path.startsWith(`${ancestor}/`)));
    const expanded = () => expandCredentialDenies([scratch], CREDENTIAL_NAMES, denied);
    const expected = visible(all); const checked = await expanded(); assert.deepEqual(checked.paths, expected);
    for (const [operation, run] of [["twelve_glob_walks", async () => visible(legacy())], ["single_credential_walk", async () => (await expanded()).paths]] as const) {
      const times: number[] = [];
      for (let index = 0; index < samples; index++) { const start = performance.now(); const paths = await run(); times.push(performance.now() - start); assert.deepEqual(paths, expected); }
      times.sort((left, right) => left - right);
      const p50 = times[Math.ceil(samples * 0.5) - 1]; const p95 = times[Math.ceil(samples * 0.95) - 1]; assert.ok(p50 !== undefined && p95 !== undefined);
      rows.push({ operation, samples_ms: times.map((time) => Number(time.toFixed(2))), p50_ms: Number(p50.toFixed(2)), p95_ms: Number(p95.toFixed(2)) });
    }
    const [old, single] = rows; assert.ok(old && single);
    passed &&= maxP95Ms === null || single.p95_ms <= maxP95Ms;
    cases.push({ scenario, entries: checked.entries, directories: checked.directories, matches: expected.length, ratio: Number((old.p50_ms / single.p50_ms).toFixed(2)), rows });
  }
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, files,
    warmup: 1, samples, maxP95Ms, passed, cases }, null, 2) + "\n");
  if (!passed) throw new Error(`Credential deny p95 exceeded ${maxP95Ms}ms`);
} finally { await rm(scratch, { recursive: true, force: true }); }
