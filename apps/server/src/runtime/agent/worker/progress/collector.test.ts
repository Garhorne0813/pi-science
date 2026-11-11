import { describe, expect, it } from "vitest";
import type { ToolProgressV1 } from "@pi-science/contracts";
import { PROGRESS_PUBLISH_INTERVAL_MS, ToolProgressCollector } from "./collector.js";
import { emitterProgressAdapter } from "./control-lines.js";
import type { ProgressAdapter } from "./types.js";

const record = (value: Record<string, unknown>) =>
  `<<pi-progress>> ${JSON.stringify({ version: 1, scopeId: "scan:1", scopeLabel: "Scanning", totalKind: "fixed", ...value })}\n`;

function collector(
  adapters: readonly ProgressAdapter[] = [emitterProgressAdapter],
  command = "bash script.sh",
  intervalMs = PROGRESS_PUBLISH_INTERVAL_MS,
) {
  const clock = { at: 1_000 };
  const instance = new ToolProgressCollector({
    command,
    adapters,
    intervalMs,
    now: () => clock.at,
  });
  return { clock, instance };
}

const determinate = (progress: ToolProgressV1 | undefined) => progress?.determinate === true;

describe("ToolProgressCollector", () => {
  it("publishes the first measured value and removes its control line", () => {
    const { instance } = collector();
    expect(instance.observe(record({ current: 2, total: 5 }))).toEqual({
      text: "",
      progress: {
        version: 1,
        scopeId: "emitter:scan:1",
        scopeLabel: "Scanning",
        totalKind: "fixed",
        source: "builtin",
        current: 2,
        total: 5,
        determinate: true,
      },
    });
  });

  it("keeps ordinary output intact and exposes no number for prose percentages", () => {
    const { instance } = collector();
    const reading = instance.observe("Downloaded 10 files (50%)\n");
    expect(reading).toEqual({ text: "Downloaded 10 files (50%)\n" });
  });

  it("holds a faster update back and publishes it once the interval has passed", () => {
    const { clock, instance } = collector();
    expect(instance.observe(record({ current: 1, total: 5 })).progress?.current).toBe(1);
    clock.at += 10;
    expect(instance.observe(record({ current: 2, total: 5 })).progress).toBeUndefined();
    clock.at += 10;
    expect(instance.observe(record({ current: 3, total: 5 })).progress).toBeUndefined();
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS;
    expect(instance.observe(record({ current: 4, total: 5 })).progress?.current).toBe(4);
  });

  it("does not republish a value that has not changed", () => {
    const { clock, instance } = collector();
    instance.observe(record({ current: 2, total: 5 }));
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS * 2;
    expect(instance.observe(record({ current: 2, total: 5 })).progress).toBeUndefined();
  });

  it("hands the held-back value out when the call finishes", () => {
    const { clock, instance } = collector();
    instance.observe(record({ current: 1, total: 5 }));
    clock.at += 10;
    expect(instance.observe(record({ current: 5, total: 5 })).progress).toBeUndefined();
    expect(instance.finish().progress?.current).toBe(5);
    expect(instance.finish().progress).toBeUndefined();
  });

  it("lets an explicit protocol outrank a command-reading adapter", () => {
    const noisy: ProgressAdapter = {
      id: "noisy",
      matches: () => true,
      read: () => [
        { scopeId: "x", scopeLabel: "Guess", current: 1, total: 100, totalKind: "fixed" },
      ],
    };
    const { clock, instance } = collector([emitterProgressAdapter, noisy]);
    expect(instance.observe(record({ current: 2, total: 5 })).progress?.scopeId).toBe(
      "emitter:scan:1",
    );
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS;
    expect(instance.observe("no control line\n").progress?.scopeId).toBe("noisy:x");
  });

  it("replaces the row when a different scope starts", () => {
    const { clock, instance } = collector();
    instance.observe(record({ current: 1, total: 5 }));
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS;
    expect(
      instance.observe(record({ scopeId: "second", current: 1, total: 9 })).progress?.scopeId,
    ).toBe("emitter:second");
  });

  it("keeps the measured value when one scope reports a lower count", () => {
    const { clock, instance } = collector();
    instance.observe(record({ current: 4, total: 5 }));
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS;
    expect(instance.observe(record({ current: 2, total: 5 })).progress).toBeUndefined();
    expect(instance.current?.current).toBe(4);
  });

  it("restarts a completed scope that counts again", () => {
    const { clock, instance } = collector();
    instance.observe(record({ current: 5, total: 5 }));
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS;
    expect(instance.observe(record({ current: 1, total: 5 })).progress?.current).toBe(1);
  });

  it("keeps a wording change without losing the measurement", () => {
    const { clock, instance } = collector();
    instance.observe(record({ current: 3, total: 5, phase: "reading" }));
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS;
    const reading = instance.observe(record({ current: 3, total: 5, phase: "writing" }));
    expect(reading.progress?.phase).toBe("writing");
    expect(reading.progress?.current).toBe(3);
    expect(determinate(reading.progress)).toBe(true);
  });

  it("drops the bar when the total was only estimated", () => {
    const { clock, instance } = collector();
    instance.observe(record({ current: 1, total: 5 }));
    clock.at += PROGRESS_PUBLISH_INTERVAL_MS;
    const reading = instance.observe(record({ current: 2, total: 8, totalKind: "reestimated" }));
    expect(determinate(reading.progress)).toBe(false);
    expect(reading.progress?.total).toBe(8);
  });

  it("counts without a bar when no total was published", () => {
    const { instance } = collector();
    const reading = instance.observe(record({ current: 12, totalKind: "unknown" }));
    expect(reading.progress?.determinate).toBe(false);
    expect(reading.progress?.current).toBe(12);
  });

  it("drops an observation whose namespaced scope does not fit the contract", () => {
    const { instance } = collector();
    expect(
      instance.observe(record({ scopeId: "a".repeat(64), current: 1, total: 2 })).progress,
    ).toBeUndefined();
  });

  it("survives an adapter that throws", () => {
    const broken: ProgressAdapter = {
      id: "broken",
      matches: () => true,
      read: () => {
        throw new Error("boom");
      },
    };
    const { instance } = collector([broken, emitterProgressAdapter]);
    expect(instance.observe(record({ current: 1, total: 2 })).progress?.scopeId).toBe(
      "emitter:scan:1",
    );
  });

  it("reads only adapters that recognize the command", () => {
    const scoped: ProgressAdapter = {
      id: "scoped",
      matches: (command) => command.startsWith("dd "),
      read: () => [{ scopeId: "bytes", scopeLabel: "Copied", current: 1 }],
    };
    expect(collector([scoped], "python3 run.py").instance.observe("x\n").progress).toBeUndefined();
    expect(
      collector([scoped], "dd if=a of=b status=progress").instance.observe("x\n").progress?.scopeId,
    ).toBe("scoped:bytes");
  });

  it("ignores output after the call finished", () => {
    const { instance } = collector();
    instance.finish();
    expect(instance.observe(record({ current: 1, total: 2 })).progress).toBeUndefined();
  });
});
