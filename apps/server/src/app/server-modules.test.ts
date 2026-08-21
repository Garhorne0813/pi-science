import { describe, expect, it } from "vitest";
import { createServerModules } from "./server-modules.js";

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
  });
});
