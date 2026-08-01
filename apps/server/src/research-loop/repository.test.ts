import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { metadataRoot, readJsonLines } from "../storage/persistence.js";
import { ResearchRepository } from "./repository.js";
import type { ResearchRecord } from "./types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-research-records-"));
  cleanup.push(cwd);
  await mkdir(metadataRoot(cwd), { recursive: true });
  return cwd;
}

function logPath(cwd: string): string { return join(metadataRoot(cwd), "research-records-v2.jsonl"); }

function record(index: number): ResearchRecord {
  return {
    schema_version: 2, record_id: `record-${index}`, record_type: "loop.state_changed",
    workspace_id: "/tmp/research", loop_id: `loop-${index % 3}`, created_at: new Date().toISOString(),
    producer: "test", payload: { index, filler: "x".repeat(index % 7) },
  };
}

/** The cold read the cache must stay bit-identical to. */
function cold(cwd: string): Promise<ResearchRecord[]> { return readJsonLines<ResearchRecord>(logPath(cwd)); }

describe("research record reads", () => {
  it("matches a cold full read after every append", async () => {
    const cwd = await workspace();
    const repository = new ResearchRepository(cwd);
    expect(await repository.records()).toEqual([]);
    for (let index = 0; index < 25; index += 1) {
      const batch = 1 + Math.floor(Math.random() * 4);
      for (let item = 0; item < batch; item += 1) await appendFile(logPath(cwd), `${JSON.stringify(record(index * 10 + item))}\n`, "utf8");
      expect(await repository.records()).toEqual(await cold(cwd));
    }
    expect((await repository.records()).length).toBeGreaterThan(25);
  });

  it("reports a torn tail exactly like a cold read and consumes it once completed", async () => {
    const cwd = await workspace();
    const repository = new ResearchRepository(cwd);
    await appendFile(logPath(cwd), `${JSON.stringify(record(1))}\n`, "utf8");
    expect(await repository.records()).toEqual(await cold(cwd));

    const serialized = JSON.stringify(record(2));
    await appendFile(logPath(cwd), serialized.slice(0, 12), "utf8");
    expect(await repository.records()).toEqual(await cold(cwd));
    expect(await repository.records()).toHaveLength(1);

    await appendFile(logPath(cwd), serialized.slice(12), "utf8");
    expect(await repository.records()).toEqual(await cold(cwd));
    expect(await repository.records()).toHaveLength(2);

    await appendFile(logPath(cwd), `\n${JSON.stringify(record(3))}\n`, "utf8");
    const complete = await repository.records();
    expect(complete).toEqual(await cold(cwd));
    expect(complete).toHaveLength(3);
  });

  it("re-reads in full when the log shrinks or is replaced", async () => {
    const cwd = await workspace();
    const repository = new ResearchRepository(cwd);
    for (const index of [1, 2, 3]) await appendFile(logPath(cwd), `${JSON.stringify(record(index))}\n`, "utf8");
    expect(await repository.records()).toHaveLength(3);

    await truncate(logPath(cwd), 0);
    await appendFile(logPath(cwd), `${JSON.stringify(record(9))}\n`, "utf8");
    const shrunk = await repository.records();
    expect(shrunk).toEqual(await cold(cwd));
    expect(shrunk.map((row) => row.record_id)).toEqual(["record-9"]);

    await writeFile(logPath(cwd), [record(7), record(8)].map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
    expect(await repository.records()).toEqual(await cold(cwd));

    await rm(logPath(cwd));
    expect(await repository.records()).toEqual([]);
  });

  it("parses only the appended byte range", async () => {
    const cwd = await workspace();
    const repository = new ResearchRepository(cwd);
    for (let index = 0; index < 200; index += 1) await appendFile(logPath(cwd), `${JSON.stringify(record(index))}\n`, "utf8");
    const before = await repository.records();
    await appendFile(logPath(cwd), `${JSON.stringify(record(999))}\n`, "utf8");
    const after = await repository.records();

    expect(after).toHaveLength(before.length + 1);
    // Identity proves the prefix was reused: a full re-read would rebuild every object.
    expect(after[0]).toBe(before[0]);
    expect(after[before.length - 1]).toBe(before[before.length - 1]);
    expect(after.at(-1)?.record_id).toBe("record-999");
  });

  it("hands every caller its own array", async () => {
    const cwd = await workspace();
    const repository = new ResearchRepository(cwd);
    await appendFile(logPath(cwd), `${JSON.stringify(record(1))}\n`, "utf8");
    const first = await repository.records();
    first.push(record(99));
    expect(await repository.records()).toHaveLength(1);
  });

  it("appends under the lock and keeps reads consistent with the file", async () => {
    const cwd = await workspace();
    const repository = new ResearchRepository(cwd);
    await Promise.all([0, 1, 2, 3, 4].map((index) => repository.append("loop.created", { index }, { loop_id: `loop-${index}` })));
    const records = await repository.records();
    expect(records).toEqual(await cold(cwd));
    expect(records).toHaveLength(5);
    expect(new Set(records.map((row) => row.record_id)).size).toBe(5);
  });
});
