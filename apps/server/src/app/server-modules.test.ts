import { describe, expect, it } from "vitest";
import { createServerModules } from "./server-modules.js";
import { InMemorySqliteStateStore } from "../storage/sqlite/state-store.js";

describe("server module graph", () => {
  it("gives every app an isolated runtime graph", () => {
    const first = createServerModules();
    const second = createServerModules();

    expect(first.sessions).not.toBe(second.sessions);
    expect(first.events).not.toBe(second.events);
    expect(first.sessionRepository).not.toBe(second.sessionRepository);
    expect(first.piManager).not.toBe(second.piManager);
    expect(first.settings).not.toBe(second.settings);
    expect(first.jobs).not.toBe(second.jobs);
    expect(first.sqliteEnabled).toBe(false);
    expect(second.sqliteEnabled).toBe(false);
    expect(first.literature).not.toBe(second.literature);
  });

  it("builds the scheduled-task runtime graph only over durable SQLite", () => {
    const enabled = createServerModules(undefined, { sqliteEnabled: true, stateStore: new InMemorySqliteStateStore() });
    expect(enabled.scheduled.service).toBeTruthy();
    expect(enabled.scheduled.scheduler).toBeTruthy();
    expect(enabled.scheduled.dispatcher).toBeTruthy();
    // docs §9.2: the shared LiteratureService instance is injected into the digest executor.
    expect(enabled.scheduled.registry?.get("literature_digest")?.kind).toBe("literature_digest");

    const disabled = createServerModules(undefined, { sqliteEnabled: false });
    expect(disabled.scheduled.service).toBeTruthy();
    expect(disabled.scheduled.scheduler).toBeNull();
    expect(disabled.scheduled.dispatcher).toBeNull();
    expect(disabled.scheduled.registry).toBeNull();
  });
});
