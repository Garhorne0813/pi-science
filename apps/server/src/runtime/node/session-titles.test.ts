import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionTitleRepository } from "./session-titles.js";

const cleanup: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pi-science-titles-${Date.now()}-`));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionTitleRepository", () => {
  it("returns an empty map when no titles were stored", async () => {
    const repo = new SessionTitleRepository();
    const titles = await repo.getTitles(await workspace());
    expect(titles.size).toBe(0);
  });

  it("upserts a title (later write wins for the same session)", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "first");
    await repo.setTitle(cwd, "s1", "second");
    await repo.setTitle(cwd, "s2", "other");
    const titles = await repo.getTitles(cwd);
    expect(titles.get("s1")).toBe("second");
    expect(titles.get("s2")).toBe("other");
    expect(titles.size).toBe(2);
    // The superseded entry is actually removed from the file (not just shadowed).
    const file = join(cwd, ".pi-science", "session-titles.jsonl");
    const raw = await readFile(file, "utf8");
    expect(raw.match(/\"first\"/)).toBeNull();
    expect(raw.match(/\"second\"/)).not.toBeNull();
  });

  it("keeps an existing title when a conditional write races a rename", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "explicit title");

    await expect(repo.setTitleIfAbsent(cwd, "s1", "late AI title")).resolves.toBe("explicit title");
    await expect(repo.getTitles(cwd)).resolves.toEqual(new Map([["s1", "explicit title"]]));
  });

  it("writes a conditional title when no title exists", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();

    await expect(repo.setTitleIfAbsent(cwd, "s1", "AI title")).resolves.toBe("AI title");
    await expect(repo.getTitles(cwd)).resolves.toEqual(new Map([["s1", "AI title"]]));
  });

  it("replaces a derived fallback with a conditional final title", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setDerivedTitle(cwd, "s1", "derived fallback");

    // The derived fallback must not block the AI title.
    await expect(repo.setTitleIfAbsent(cwd, "s1", "AI 标题")).resolves.toBe("AI 标题");
    await expect(repo.getTitleRecords(cwd)).resolves.toEqual(new Map([
      ["s1", { session_id: "s1", title: "AI 标题", updated_at: expect.any(String) }],
    ]));
    // And the stored final record must be final again (no derived marker).
    const file = join(cwd, ".pi-science", "session-titles.jsonl");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain('"derived"');
  });

  it("skips the conditional write when the existence confirmation fails under the lock", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();

    // A session deleted while AI generation ran must not leave an orphan.
    let confirmCalls = 0;
    await expect(repo.setTitleIfAbsent(cwd, "deleted", "late AI title", async () => {
      confirmCalls += 1;
      return false;
    })).resolves.toBeNull();
    expect(confirmCalls).toBe(1);
    await expect(repo.getTitles(cwd)).resolves.toEqual(new Map());

    // A true confirmation proceeds as usual.
    await expect(repo.setTitleIfAbsent(cwd, "alive", "AI title", async () => true)).resolves.toBe("AI title");
    await expect(repo.getTitles(cwd)).resolves.toEqual(new Map([["alive", "AI title"]]));
  });

  it("stores a derived title flagged and refreshes it without touching final titles", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setDerivedTitle(cwd, "s1", "first fallback");
    await repo.setDerivedTitle(cwd, "s1", "second fallback");
    await repo.setTitle(cwd, "s2", "user rename");
    // A late derived write must never replace an explicit rename...
    await repo.setDerivedTitle(cwd, "s2", "stale fallback");

    await expect(repo.getTitleRecords(cwd)).resolves.toEqual(new Map([
      ["s1", { session_id: "s1", title: "second fallback", updated_at: expect.any(String), derived: true }],
      ["s2", { session_id: "s2", title: "user rename", updated_at: expect.any(String) }],
    ]));
  });

  it("moves a title to a replacement id atomically and idempotently", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "old", "carried 标题");
    await repo.setTitle(cwd, "other", "untouched");

    await repo.moveTitle(cwd, "old", "new");
    await expect(repo.getTitles(cwd)).resolves.toEqual(new Map([
      ["new", "carried 标题"],
      ["other", "untouched"],
    ]));
    // Idempotent: moving twice changes nothing further.
    await repo.moveTitle(cwd, "old", "new");
    await expect(repo.getTitles(cwd)).resolves.toEqual(new Map([
      ["new", "carried 标题"],
      ["other", "untouched"],
    ]));
  });

  it("moves a derived flag with the title and keeps a replacement's own title", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setDerivedTitle(cwd, "old", "fallback question");

    // Replacement already owns a final title: the move must not overwrite it.
    await repo.setTitle(cwd, "taken", "final wins");
    await repo.moveTitle(cwd, "old", "taken");
    await expect(repo.getTitleRecords(cwd)).resolves.toEqual(new Map([
      ["taken", { session_id: "taken", title: "final wins", updated_at: expect.any(String) }],
    ]));

    // Without an existing target the derived flag travels so an AI title can
    // still replace the moved fallback.
    await repo.setDerivedTitle(cwd, "old-2", "still derived");
    await repo.moveTitle(cwd, "old-2", "new-2");
    await expect(repo.getTitleRecords(cwd)).resolves.toEqual(new Map([
      ["taken", { session_id: "taken", title: "final wins", updated_at: expect.any(String) }],
      ["new-2", { session_id: "new-2", title: "still derived", updated_at: expect.any(String), derived: true }],
    ]));
  });

  it("treats legacy records without the derived field as final", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(
      join(cwd, ".pi-science", "session-titles.jsonl"),
      '{"session_id":"legacy","title":"old record","updated_at":"2026-01-01T00:00:00.000Z"}\n',
      "utf8",
    );

    // Legacy records block regeneration exactly like explicit renames.
    await expect(repo.setTitleIfAbsent(cwd, "legacy", "AI replacement")).resolves.toBe("old record");
    await repo.setDerivedTitle(cwd, "legacy", "fallback must lose");
    await expect(repo.getTitles(cwd)).resolves.toEqual(new Map([["legacy", "old record"]]));
  });

  it("deletes a title for a session and keeps the others", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "one");
    await repo.setTitle(cwd, "s2", "two");
    await repo.deleteTitle(cwd, "s1");
    const titles = await repo.getTitles(cwd);
    expect(titles.has("s1")).toBe(false);
    expect(titles.get("s2")).toBe("two");
  });

  it("is isolated per workspace", async () => {
    const repo = new SessionTitleRepository();
    const a = await workspace();
    const b = await workspace();
    await repo.setTitle(a, "s1", "in-a");
    expect((await repo.getTitles(b)).size).toBe(0);
    expect((await repo.getTitles(a)).get("s1")).toBe("in-a");
  });

  it("keeps the file as valid JSONL with a trailing newline and leaves no temp files", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    await repo.setTitle(cwd, "s1", "one");
    await repo.setTitle(cwd, "s2", "two");
    await repo.setTitle(cwd, "s1", "one-updated");
    await repo.deleteTitle(cwd, "s2");
    const file = join(cwd, ".pi-science", "session-titles.jsonl");
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      { session_id: "s1", title: "one-updated", updated_at: expect.any(String) },
    ]);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(cwd, ".pi-science"));
    expect(entries).toEqual(expect.not.arrayContaining([expect.stringContaining(".tmp")]));
  });

  it("ignores corrupt records when reading", async () => {
    const repo = new SessionTitleRepository();
    const cwd = await workspace();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(
      join(cwd, ".pi-science", "session-titles.jsonl"),
      '{"session_id":"s1","title":"ok","updated_at":"2026-01-01T00:00:00.000Z"}\nnot-json\n{"session_id":"s2","title":123}\n',
      "utf8",
    );
    const titles = await repo.getTitles(cwd);
    expect(titles.get("s1")).toBe("ok");
    expect(titles.has("s2")).toBe(false);
  });
});
