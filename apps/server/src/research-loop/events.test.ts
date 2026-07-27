import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitResearchEvent, subscribeResearchEvents, type ResearchEvent } from "./events.js";
import { ResearchRepository } from "./repository.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("research events", () => {
  it("delivers events to subscribers of the same workspace only and stops after unsubscribe", () => {
    const a: ResearchEvent[] = [];
    const b: ResearchEvent[] = [];
    const offA = subscribeResearchEvents("/tmp/pi-science-events-a", (event) => a.push(event));
    const offB = subscribeResearchEvents("/tmp/pi-science-events-b", (event) => b.push(event));
    emitResearchEvent("/tmp/pi-science-events-a", { type: "research.record", loop_id: "loop-1" });
    expect(a).toEqual([{ type: "research.record", loop_id: "loop-1" }]);
    expect(b).toEqual([]);
    offA();
    emitResearchEvent("/tmp/pi-science-events-a", { type: "research.record", loop_id: "loop-2" });
    expect(a).toHaveLength(1);
    offB();
  });

  it("keeps delivering to later listeners when an earlier listener throws", () => {
    const seen: ResearchEvent[] = [];
    const offBroken = subscribeResearchEvents("/tmp/pi-science-events-c", () => { throw new Error("broken listener"); });
    const off = subscribeResearchEvents("/tmp/pi-science-events-c", (event) => seen.push(event));
    expect(() => emitResearchEvent("/tmp/pi-science-events-c", { type: "research.record" })).not.toThrow();
    expect(seen).toEqual([{ type: "research.record" }]);
    offBroken();
    off();
    expect(() => emitResearchEvent("/tmp/pi-science-events-c", { type: "research.record" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("emits research.record with the loop id when the repository appends a record", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-research-events-"));
    cleanup.push(cwd);
    const seen: ResearchEvent[] = [];
    const off = subscribeResearchEvents(cwd, (event) => seen.push(event));
    await new ResearchRepository(cwd).append("loop.created", { title: "Event source" }, { loop_id: "loop-events" });
    off();
    expect(seen).toEqual([{ type: "research.record", loop_id: "loop-events", record_type: "loop.created" }]);
  });
});
