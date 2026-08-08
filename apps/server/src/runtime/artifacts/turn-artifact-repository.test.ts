import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TurnArtifactRepository } from "./turn-artifact-repository.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-turn-repo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

describe("turn artifact repository", () => {
  it("persists and queries records per session", async () => {
    const repository = new TurnArtifactRepository();
    const cwd = await workspace();
    await repository.append(cwd, {
      turn_id: "turn-1", session_id: "session-a", assistant_message_id: "msg-1",
      ended_at: "2026-01-01T00:00:00.000Z",
      artifacts: [{ path: "work/plot.png", kind: "image", mime: "image/png", size: 10 }],
    });
    await repository.append(cwd, {
      turn_id: "turn-2", session_id: "session-a", assistant_message_id: "msg-2",
      ended_at: "2026-01-01T00:00:01.000Z",
      artifacts: [{ path: "work/a.csv", kind: "table", mime: "text/csv", size: 20 }],
    });
    await repository.append(cwd, {
      turn_id: "turn-3", session_id: "session-b", assistant_message_id: "msg-3",
      ended_at: "2026-01-01T00:00:02.000Z",
      artifacts: [{ path: "other.txt", kind: "text", mime: "text/plain", size: 5 }],
    });

    const sessionA = await repository.forSession(cwd, "session-a");
    expect(sessionA.map((record) => record.turn_id)).toEqual(["turn-1", "turn-2"]);
    expect(sessionA[1]!.artifacts[0]).toMatchObject({ path: "work/a.csv", kind: "table" });

    const sessionB = await repository.forSession(cwd, "session-b");
    expect(sessionB.map((record) => record.turn_id)).toEqual(["turn-3"]);

    const missing = await repository.forSession(cwd, "session-nope");
    expect(missing).toEqual([]);
  });

  it("nextTurnOrdinal returns 1 with no records and keeps counting per session", async () => {
    const repository = new TurnArtifactRepository();
    const cwd = await workspace();

    expect(await repository.nextTurnOrdinal(cwd, "session-a")).toBe(1);

    await repository.append(cwd, {
      turn_id: "turn-1", session_id: "session-a", assistant_message_id: "msg-1",
      ended_at: "2026-01-01T00:00:00.000Z", turn_ordinal: 1,
      artifacts: [],
    });
    await repository.append(cwd, {
      turn_id: "turn-2", session_id: "session-a", assistant_message_id: "msg-2",
      ended_at: "2026-01-01T00:00:01.000Z", turn_ordinal: 2,
      artifacts: [],
    });
    expect(await repository.nextTurnOrdinal(cwd, "session-a")).toBe(3);

    // Other sessions are unaffected; ordinals on other records are ignored.
    await repository.append(cwd, {
      turn_id: "turn-3", session_id: "session-b", assistant_message_id: "msg-3",
      ended_at: "2026-01-01T00:00:02.000Z", turn_ordinal: 7,
      artifacts: [],
    });
    expect(await repository.nextTurnOrdinal(cwd, "session-a")).toBe(3);
  });

  it("nextTurnOrdinal ignores missing or invalid ordinals", async () => {
    const repository = new TurnArtifactRepository();
    const cwd = await workspace();
    await repository.append(cwd, {
      turn_id: "turn-1", session_id: "session-a", assistant_message_id: "msg-1",
      ended_at: "2026-01-01T00:00:00.000Z",
      artifacts: [],
    });
    await repository.append(cwd, {
      turn_id: "turn-2", session_id: "session-a", assistant_message_id: "msg-2",
      ended_at: "2026-01-01T00:00:01.000Z", turn_ordinal: "not-a-number" as unknown as number,
      artifacts: [],
    });
    expect(await repository.nextTurnOrdinal(cwd, "session-a")).toBe(1);
  });
});
