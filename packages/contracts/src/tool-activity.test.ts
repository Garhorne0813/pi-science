import { describe, expect, it } from "vitest";
import {
  activityCategory,
  activityFileLabel,
  activityProgramName,
  activityPurposeText,
  activityQueryText,
  activityReadTarget,
  activityUrlLabel,
  scrubActivityText,
} from "./tool-activity.js";

describe("activity classification", () => {
  it.each([
    ["READ", "read"],
    ["rg", "search"],
    ["glob", "browse"],
    ["patch", "edit"],
    ["bash", "execute"],
    ["python", "compute"],
    ["r", "compute"],
    ["rscript", "compute"],
    ["r_kernel", "compute"],
    ["fetch", "web"],
    ["fetch_url", "web"],
    ["read_url", "web"],
    ["subagent_control", "delegate"],
    ["pubmed", "literature"],
    ["image_gen", "generate"],
    ["task", "delegate"],
    ["unknown", "other"],
  ])("classifies %s", (tool, expected) => {
    expect(activityCategory({ tool })).toBe(expected);
  });
  it.each(["python", "read_file", "search_pubmed", "bash", "r"])(
    "does not lend built-in semantics to an MCP name ending in %s",
    (name) => {
      expect(activityCategory({ tool: `mcp__stats__${name}` })).toBe("other");
    },
  );
  it("classifies an MCP tool only by the kind it reports", () => {
    expect(activityCategory({ tool: "mcp__stats__python", presentationKind: "search" })).toBe(
      "search",
    );
    expect(activityCategory({ tool: "mcp__stats__python", presentationKind: "read" })).toBe("read");
  });
  it("prioritizes child, exact tool, kind, then other", () => {
    expect(
      activityCategory({ tool: "read", presentationKind: "edit", childSessionId: "child" }),
    ).toBe("delegate");
    expect(activityCategory({ tool: "read", presentationKind: "edit" })).toBe("read");
    expect(activityCategory({ tool: "unknown", presentationKind: "FETCH" })).toBe("web");
    expect(activityCategory({ tool: "unknown", presentationKind: "unknown" })).toBe("other");
  });
  it.each([
    ["read", "read"],
    ["search", "search"],
    ["fetch", "web"],
    ["edit", "edit"],
    ["execute", "execute"],
    ["compute", "compute"],
    ["verify", "execute"],
    ["artifact", "generate"],
    ["interaction", "other"],
    ["system", "other"],
    ["other", "other"],
  ])("maps fallback %s", (presentationKind, expected) => {
    expect(activityCategory({ tool: "extension", presentationKind })).toBe(expected);
  });
});
describe("safe program name", () => {
  it("accepts plain commands only and caps names", () => {
    expect(activityProgramName({ command: "/usr/bin/pnpm test" })).toBe("pnpm");
    expect(activityProgramName({ command: "x".repeat(50) })).toBe(`${"x".repeat(39)}…`);
  });
  it.each([
    "`",
    "$",
    "|",
    "&",
    ";",
    "<",
    ">",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    '"',
    "'",
    "\\",
    "=",
    "!",
    "*",
    "?",
    "~",
    "#",
    "^",
  ])("rejects shell character %s", (char) => {
    expect(activityProgramName({ command: `cmd ${char}secret` })).toBeUndefined();
  });
  it.each(
    "env export set unset exec command builtin source eval alias sudo doas nohup xargs cd if then else elif fi for while until do done case esac function declare local typeset let shift trap time nice ionice stdbuf".split(
      " ",
    ),
  )("rejects %s", (command) => {
    expect(activityProgramName({ command })).toBeUndefined();
  });
  it.each([
    { command: "a\nb" },
    { command: ["cmd"] },
    { code: "cmd" },
    { script: "cmd" },
    { command: "/" },
    { command: ".bad" },
    { command: "" },
  ])("rejects unverified input", (input) => {
    expect(activityProgramName(input)).toBeUndefined();
  });
});
describe("read target", () => {
  it.each([
    [{ path: "src/a.ts", offset: 120, limit: 40 }, "a.ts:120-159"],
    [{ file_path: "a.ts", start_line: "120" }, "a.ts:120"],
    [{ path: "a.ts", limit: 40 }, "a.ts"],
    [{ path: "a.ts", offset: 0 }, "a.ts"],
    [{ path: "a.ts", offset: 2, limit: -1 }, "a.ts"],
    [{ path: "a.ts", offset: 1_000_000 }, "a.ts"],
  ])("formats target", (input, expected) => {
    expect(activityReadTarget(input)).toBe(expected);
  });
  it("caps file labels", () => {
    expect(activityFileLabel("a".repeat(90))).toBe(`${"a".repeat(79)}…`);
  });
});

describe("display text", () => {
  it("keeps a scientific term that only contains a credential word", () => {
    for (const value of [
      "secreted protein folding",
      "secretory pathway analysis",
      "token binding kinase",
      "api surface review",
    ]) {
      expect(scrubActivityText(value)).toBe(value);
    }
  });
  it.each([
    ["TOKEN=secret_value", "TOKEN=[redacted]"],
    ["API_KEY=abc123", "API_KEY=[redacted]"],
    ["--token=abc123", "--token=[redacted]"],
    ["--api-key=abc123", "--api-key=[redacted]"],
    ["Authorization: Bearer abc123", "Authorization: [redacted]"],
    ["https://user:pass@example.com/paper", "https://example.com/paper"],
  ])("removes the credential in %s", (input, expected) => {
    expect(scrubActivityText(input)).toBe(expected);
  });
  it("leaves a non-credential flag and a short assignment alone", () => {
    expect(scrubActivityText("--seed=42")).toBe("--seed=42");
    expect(scrubActivityText("MAX_TOKENS=100")).toBe("MAX_TOKENS=100");
  });
  it("bounds and flattens a purpose line", () => {
    expect(activityPurposeText("  run\n  the   tests  ")).toBe("run the tests");
    expect(activityPurposeText("x".repeat(200))).toHaveLength(160);
    expect(activityPurposeText("x".repeat(200)).endsWith("…")).toBe(true);
  });
  it("formats a query and a URL as themselves", () => {
    expect(activityQueryText("  secreted   protein  folding ")).toBe("secreted protein folding");
    expect(activityUrlLabel("https://user:pass@example.com/paper?token=secret#top")).toBe(
      "https://example.com/paper",
    );
    expect(activityUrlLabel("https://example.com")).toBe("https://example.com");
    expect(activityUrlLabel("not a url")).toBe("not a url");
  });
  it("truncates on code points so a surrogate pair is never split", () => {
    const clipped = activityQueryText("😀".repeat(5), 4);
    expect(clipped.endsWith("…")).toBe(true);
    expect(Array.from(clipped)).toHaveLength(4);
    for (let index = 0; index < clipped.length; index++) {
      const unit = clipped.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = clipped.charCodeAt(index + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        index += 1;
      } else {
        expect(unit >= 0xdc00 && unit <= 0xdfff).toBe(false);
      }
    }
    expect(activityQueryText("a".repeat(4), 4)).toBe("aaaa");
  });
});
