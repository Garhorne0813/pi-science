import { describe, expect, it } from "vitest";
import type { EnvironmentRevision } from "../../../runtime/workspace/workspace-environment.js";
import { SqliteStateStore } from "../state-store.js";
import { EnvironmentRepository } from "./environment-repository.js";

function revision(integritySnapshot: string[]): EnvironmentRevision {
  return {
    environment_id: "env_test",
    revision_id: "rev_test",
    name: "test",
    display_name: "Test",
    language: "python",
    status: "ready",
    prefix: "/tmp/pi-science-environment-repository-test",
    packages: ["python=3.12"],
    platform: "test",
    created_at: new Date().toISOString(),
    integrity_snapshot: integritySnapshot,
  };
}

describe("EnvironmentRepository legacy import", () => {
  it("does not overwrite an existing revision with a stale legacy snapshot", async () => {
    const store = new SqliteStateStore({ path: ":memory:" });
    await store.start();
    try {
      const repository = new EnvironmentRepository(store);
      expect(await repository.importLegacy([revision(["v2:first"])], "fingerprint-1")).toEqual({
        rows: 1,
        skipped: false,
      });
      expect(await repository.importLegacy([revision(["v2:stale"])], "fingerprint-2")).toEqual({
        rows: 0,
        skipped: false,
      });
      expect((await repository.get("rev_test"))?.integrity_snapshot).toEqual(["v2:first"]);
    } finally {
      await store.close();
    }
  });
});
