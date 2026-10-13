// Rerunnable stress benchmark for the kernel output caps. It drives the real
// Python bridge on one worst-case cell twice, once with unbounded caps as the
// pre-fix comparison and once with the shipped defaults, and reports the
// bridge's peak resident memory, the bytes it put on stdout, and the wall time.
//
//   node scripts/benchmark-kernel-output.mjs [--workload-mib 64]
//
// No dependencies beyond the Node standard library. Exits non-zero when the
// bounded run's transport exceeds four times the sum of the default caps.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BRIDGE = fileURLToPath(new URL("../apps/server/src/runtime/kernel/bridges/kernel_bridge.py", import.meta.url));
const SAMPLE_INTERVAL_MS = 25;
// Keep in sync with DEFAULT_KERNEL_OUTPUT_LIMITS in
// apps/server/src/runtime/kernel/kernel-output-limits.ts.
const DEFAULT_CAPS = { stdout_chars: 65_536, stderr_chars: 65_536, result_chars: 262_144, mime_chars: 1_048_576, outputs_chars: 2_097_152 };
const UNBOUNDED_CAPS = { stdout_chars: 1_000_000_000, stderr_chars: 1_000_000_000, result_chars: 1_000_000_000, mime_chars: 1_000_000_000, outputs_chars: 1_000_000_000 };
const MIB = 1_048_576;
const BASE_STDOUT_MIB = 64;
// The bounded run reads up to this much of the response to report what the caps
// delivered; the unbounded run is far past it and skips that read.
const CAPTURE_LIMIT = 8 * 1024 * 1024;

function interpreter() {
  const configured = process.env.PI_SCIENCE_KERNEL_PYTHON;
  if (configured) {
    if (!existsSync(configured)) fail(`PI_SCIENCE_KERNEL_PYTHON points at a missing interpreter: ${configured}`);
    return configured;
  }
  const probe = spawnSync("python3", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) fail("no python3 on PATH; set PI_SCIENCE_KERNEL_PYTHON to a Python interpreter");
  return "python3";
}

function fail(message) {
  console.error(`benchmark-kernel-output: ${message}`);
  process.exit(1);
}

function workloadMib() {
  const index = process.argv.indexOf("--workload-mib");
  if (index === -1) return BASE_STDOUT_MIB;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) fail("--workload-mib needs a positive number");
  return value;
}

/** One cell: a big stdout, a big stderr, and a tail expression carrying a 3:1:1 rich payload. */
function cellSource(stdoutMib) {
  const scale = stdoutMib / BASE_STDOUT_MIB;
  const mib = (base) => Math.max(1, Math.round(base * scale));
  return [
    "import sys",
    "class Payload(dict):",
    `    def _repr_png_(self): return b'P' * (${mib(12)} * 1024 * 1024)`,
    `    def _repr_html_(self): return '<p>' + 'h' * (${mib(4)} * 1024 * 1024) + '</p>'`,
    "    def __repr__(self): return 'Payload()'",
    `sys.stdout.write('o' * (${stdoutMib} * 1024 * 1024))`,
    `sys.stderr.write('e' * (${mib(8)} * 1024 * 1024))`,
    `Payload(payload='j' * (${mib(4)} * 1024 * 1024 - 16))`,
  ].join("\n");
}

function samplePeakRss(pid) {
  const state = { peakKb: 0, inFlight: false };
  const timer = setInterval(() => {
    if (state.inFlight) return;
    state.inFlight = true;
    const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    ps.stdout.on("data", (chunk) => { output += chunk; });
    ps.once("error", () => { state.inFlight = false; });
    ps.once("close", () => {
      state.inFlight = false;
      const kb = Number(output.trim());
      if (Number.isFinite(kb)) state.peakKb = Math.max(state.peakKb, kb);
    });
  }, SAMPLE_INTERVAL_MS);
  return { state, stop: () => clearInterval(timer) };
}

function runBridge(caps, source) {
  return new Promise((resolve) => {
    const child = spawn(interpreter(), [BRIDGE, "--limits", JSON.stringify(caps)], { stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBytes = 0;
    let lines = 0;
    let captured = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) lines += 1;
      if (captured.length + chunk.length <= CAPTURE_LIMIT) captured += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < 4_096) stderr += chunk.toString("utf8"); });
    const sampling = samplePeakRss(child.pid);
    const started = performance.now();
    child.once("error", (error) => {
      sampling.stop();
      fail(`could not start ${BRIDGE}: ${error.message}`);
    });
    // Closing stdin after the request makes the bridge exit once it has answered.
    child.stdin.end(`${JSON.stringify({ id: "bench", code: source })}\n`);
    child.once("exit", (code) => {
      const wallSeconds = (performance.now() - started) / 1000;
      sampling.stop();
      if (code !== 0) fail(`the bridge exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
      resolve({ peakKb: sampling.state.peakKb, stdoutBytes, lines, wallSeconds, captured });
    });
  });
}

function report(response) {
  const line = response.captured.split("\n").findLast((value) => value.trim());
  if (!line) return "no response captured";
  try {
    const parsed = JSON.parse(line);
    return `truncated=${JSON.stringify(parsed.truncated ?? {})} stdout_chars=${parsed.stdout.length} stderr_chars=${parsed.stderr.length} result_chars=${parsed.result === null ? 0 : parsed.result.length}`;
  } catch {
    return "response not parsed (over the capture limit)";
  }
}

const stdoutMib = workloadMib();
const source = cellSource(stdoutMib);
const unbounded = await runBridge(UNBOUNDED_CAPS, source);
const bounded = await runBridge(DEFAULT_CAPS, source);
const toMib = (bytes) => bytes / MIB;
const format = (value) => value.toFixed(1).padStart(9);

for (const [label, result] of [["unbounded", unbounded], ["defaults ", bounded]]) {
  console.log(`${label}  rss ${format(result.peakKb / 1024)} MiB  stdout ${format(toMib(result.stdoutBytes))} MiB  wall ${result.wallSeconds.toFixed(2)} s  lines ${result.lines}`);
}
console.log(`unbounded  ${report(unbounded)}`);
console.log(`defaults   ${report(bounded)}`);
console.log(`before -> after  rss ${format(unbounded.peakKb / 1024)} -> ${format(bounded.peakKb / 1024)} MiB   stdout ${format(toMib(unbounded.stdoutBytes))} -> ${format(toMib(bounded.stdoutBytes))} MiB`);

const capSum = Object.values(DEFAULT_CAPS).reduce((sum, value) => sum + value, 0);
const budget = 4 * capSum;
console.log(`transport limit  ${toMib(budget).toFixed(1)} MiB (four times the ${capSum}-character cap sum), bounded used ${toMib(bounded.stdoutBytes).toFixed(1)} MiB`);
if (bounded.stdoutBytes > budget) fail(`the bounded run wrote ${bounded.stdoutBytes} bytes to stdout, over the ${budget}-byte limit`);
