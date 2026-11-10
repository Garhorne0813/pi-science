import { expect, it } from "vitest";
import { applicationErrorStatus } from "./application-error.js";
import { ApplicationError } from "../modules/application-error.js";
import { InMemorySqliteStateStore } from "../storage/sqlite/state-store.js";
import { SqliteStateError } from "../storage/sqlite/errors.js";

it("preserves domain failures across the worker without reclassifying them as storage failures", async () => {
  const store = new InMemorySqliteStateStore();
  try {
    await store.start();
    let failure: unknown;
    try {
      await store.memory({
        context: { ownerId: "owner", projectId: "project", actor: "user" },
        action: "read",
        input: { id: "absent" },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApplicationError);
    expect(failure).toMatchObject({ kind: "not_found", code: "memory_not_found" });
    expect(failure).not.toBeInstanceOf(SqliteStateError);
    expect(applicationErrorStatus(failure as ApplicationError)).toBe(404);
    await expect(store.get("SELECT * FROM absent_table")).rejects.toBeInstanceOf(SqliteStateError);
  } finally {
    await store.close();
  }
});
