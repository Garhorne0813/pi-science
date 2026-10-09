import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/client/types";
import { groupSessions } from "./WorkspaceSessionList";

const item = (id: string, date?: string, name = id): SessionInfo => ({ id, name, cwd: "proj", updated_at: date });

describe("groupSessions", () => {
  it("uses local calendar boundaries and puts invalid or missing dates in Earlier", () => {
    const now = new Date(2026, 9, 9, 15);
    const date = (day: number, hour = 0) => new Date(2026, 9, day, hour).toISOString();
    const result = groupSessions([
      item("today", date(9)), item("yesterday", date(8)), item("week", date(2)),
      item("old", date(1, 23)), item("invalid", "bad date"), item("missing"),
    ], "", now);
    expect(result.map(group => [group.key, group.sessions.map(session => session.id)])).toEqual([
      ["today", ["today"]], ["yesterday", ["yesterday"]], ["week", ["week"]], ["earlier", ["old", "invalid", "missing"]],
    ]);
  });

  it("filters loaded titles case-insensitively, including localized default titles and ID fallbacks", () => {
    const sessions = [item("abcdefghi"), item("s2", undefined, "Protein Analysis"), item("s3", undefined, "New Session")];
    expect(groupSessions(sessions, " protein ").flatMap(group => group.sessions).map(session => session.id)).toEqual(["s2"]);
    expect(groupSessions(sessions, "新建", new Date(), "新建对话")[0].sessions[0].id).toBe("s3");
    expect(groupSessions([item("abcdefghi", undefined, "")], "abcdefgh")[0].sessions[0].id).toBe("abcdefghi");
    expect(groupSessions(sessions, "unmatched")).toEqual([]);
  });
});
