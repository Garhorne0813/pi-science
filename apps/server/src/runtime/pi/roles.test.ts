import { describe, expect, it } from "vitest";
import { assertCommandAllowed, ROLE_PROFILES } from "./roles.js";

describe("role command enforcement", () => {
  it("allows everything without a role (backwards compatible)", () => {
    expect(assertCommandAllowed(undefined, "bash")).toEqual({ allowed: true });
    expect(assertCommandAllowed(undefined, "fork")).toEqual({ allowed: true });
  });

  it("restricts the reviewer to its read-only surface", () => {
    expect(assertCommandAllowed("result_reviewer", "get_state")).toEqual({ allowed: true });
    expect(assertCommandAllowed("result_reviewer", "get_messages")).toEqual({ allowed: true });
    expect(assertCommandAllowed("result_reviewer", "prompt")).toEqual({ allowed: true });
    expect(assertCommandAllowed("result_reviewer", "abort")).toEqual({ allowed: true });
    expect(assertCommandAllowed("result_reviewer", "bash")).toEqual({ allowed: false, error: 'role "result_reviewer" does not permit command "bash"' });
    expect(assertCommandAllowed("result_reviewer", "fork")).toMatchObject({ allowed: false });
    expect(assertCommandAllowed("result_reviewer", "export_html")).toMatchObject({ allowed: false });
  });

  it("bookmarker may not prompt or run code", () => {
    expect(assertCommandAllowed("bookmarker", "get_messages")).toEqual({ allowed: true });
    expect(assertCommandAllowed("bookmarker", "prompt")).toMatchObject({ allowed: false });
    expect(assertCommandAllowed("bookmarker", "bash")).toMatchObject({ allowed: false });
  });

  it("science remains unrestricted and unknown roles default to allowed", () => {
    expect(assertCommandAllowed("science", "bash")).toEqual({ allowed: true });
    expect(assertCommandAllowed("science", "fork")).toEqual({ allowed: true });
    expect(assertCommandAllowed("mystery-role", "anything")).toEqual({ allowed: true });
  });

  it("profiles declare the expected scopes and computational flags", () => {
    expect(ROLE_PROFILES.result_reviewer).toMatchObject({ write_scope: [], computational: false });
    expect(ROLE_PROFILES.bookmarker).toMatchObject({ read_scope: ["transcript"], write_scope: ["bookmarks"], computational: false });
    expect(ROLE_PROFILES.science?.computational).toBe(true);
  });
});
