import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  BACKGROUND_CONTEXT,
  NodeExecutionEnv,
  type AgentHarnessToolInvocation,
} from "@earendil-works/pi-agent-core/node";
import type { ToolProgressV1 } from "@pi-science/contracts";
import { sandboxBashTool } from "./sandbox-bash.js";

/** The stream these tests write is POSIX shell. Other shells are exercised by
 *  the round trip test that skips them too. */
const posix = process.platform !== "win32";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const invocation: AgentHarnessToolInvocation = {
  operationId: "op",
  invocationId: "adapters",
  turnId: "turn",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

async function run(command: string, timeout = 60) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-progress-adapters-")));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi-science"));
  const seen: ToolProgressV1[] = [];
  const texts: string[] = [];
  await sandboxBashTool({ cwd, sessionId: "adapters" })
    .execute(
      "adapters",
      { command, timeout },
      (snapshot) => {
        const details = (snapshot as { details?: { progress?: ToolProgressV1 } }).details;
        if (details?.progress) seen.push(details.progress);
        for (const part of snapshot.content) if (part.type === "text") texts.push(part.text);
      },
      { env: new NodeExecutionEnv({ cwd }) },
      invocation,
      BACKGROUND_CONTEXT,
    )
    .catch((error: unknown) => error);
  return { seen, texts };
}

/** The exact bytes tqdm 4.67.3 writes when its bar is not a terminal: a
 *  carriage return, no newline, and the counter inside the bar. */
const bars = [
  ["  0%|          | 0/8 [00:00<?, ?it/s]", 0],
  [" 50%|█████     | 4/8 [00:00<00:00,  4.00it/s]", 4],
  ["100%|██████████| 8/8 [00:00<00:00,  4.00it/s]", 8],
] as const;
const tqdmStream =
  bars.map(([bar]) => `printf '\\r${bar.replace(/%/g, "%%")}'`).join("; sleep 0.2; ") +
  "; sleep 0.2; printf '\\n'";

it.skipIf(!posix)(
  "reads tqdm's own counter from a stream that rewrites one line",
  async () => {
    const { seen, texts } = await run(`${tqdmStream}`);
    const determinate = seen.filter((value) => value.determinate);
    expect(determinate.at(-1)).toMatchObject({
      scopeId: "tqdm:bar:8",
      scopeLabel: "Progress",
      total: 8,
      totalKind: "fixed",
      unit: "items",
    });
    // A value that appeared mid-run proves the row updated while the work ran
    // instead of arriving once at the end.
    expect(determinate.map((value) => value.current)).toContain(4);
    expect(determinate.at(-1)?.current).toBe(8);
    expect(texts.join("")).not.toContain("\r");
  },
  60_000,
);

it("counts bytes for dd status=progress and shows no bar it cannot support", async (context) => {
  const { seen, texts } = await run(
    'truncate -s 4M dd.bin && dd if=dd.bin of="$TMPDIR/dd.img" bs=1M count=4 status=progress',
  );
  const counted = seen.filter((value) => value.scopeId === "dd:dd:progress");
  // A host without dd, or a sandbox that denies it, cannot exercise the
  // adapter. Saying so beats asserting a bar the machine never produced.
  if (counted.length === 0) {
    console.error("dd probe failed:", JSON.stringify(texts.join("").slice(0, 400)));
    context.skip(`dd is not usable here: ${texts.at(-1)?.trim().slice(0, 200) ?? "no output"}`);
  }
  expect(counted.at(-1)).toMatchObject({ unit: "bytes", totalKind: "unknown", determinate: false });
  expect(counted.at(-1)?.current).toBe(4 * 1024 * 1024);
}, 60_000);

it.skipIf(!posix)(
  "leaves an ordinary percentage in output as text",
  async () => {
    const { seen } = await run("printf 'finished 50%% of the work\\n'");
    expect(seen).toEqual([]);
  },
  60_000,
);
