import { ConversationProjection } from "../events/conversation/projection.js";
import { ConversationStreams } from "../events/conversation/streams.js";
import { describe, expect, it } from "vitest";
import { toolActivityPresentation, toolActivityTitle } from "./tool-activity-presenters.js";

describe("toolActivityTitle", () => {
  it("hides plan and interaction tools", () => {
    expect(toolActivityTitle("todo", {})).toBeUndefined();
    expect(toolActivityTitle("ask_user_question", {})).toBeUndefined();
  });
  it("creates deterministic titles", () => {
    expect(toolActivityTitle("read", { path: "src/file.ts" })).toBe("Reading file.ts");
    expect(toolActivityTitle("grep", { pattern: "tool.updated" })).toBe(
      "Searching for tool.updated",
    );
  });
  it("uses descriptions but not raw shell commands", () => {
    expect(toolActivityTitle("bash", { command: "pnpm test", description: "Running tests" })).toBe(
      "Running tests",
    );
    expect(toolActivityTitle("bash", { command: "rm -rf x" })).toBe("Running rm");
  });
  it("returns replayable semantics for built-in and opaque tools", () => {
    expect(toolActivityPresentation("notebook_run", {})).toMatchObject({
      version: 1,
      kind: "compute",
      domain: "science",
      importance: "stage",
    });
    expect(toolActivityPresentation("bash", { description: "Run frontend tests" })).toMatchObject({
      kind: "verify",
      domain: "code",
      description: "Run frontend tests",
    });
    expect(toolActivityPresentation("image_gen", {})).toMatchObject({
      kind: "artifact",
      domain: "document",
      narrativeHint: { state: "generate" },
    });
    expect(toolActivityPresentation("bash", { command: "git status" })).toBeUndefined();
  });
});

describe("safe activity titles", () => {
  it.each(["TOKEN=secret cmd", "env cmd", "cmd | other", "cmd 'secret'", "cmd\nother"])(
    "rejects unsafe command %s",
    (command) => {
      expect(toolActivityTitle("bash", { command })).toBe("Running bash");
    },
  );
  it.each([
    [{ path: "a.ts", offset: 120, limit: 40 }, "Reading a.ts:120-159"],
    [{ path: "a.ts", offset: 120 }, "Reading a.ts:120"],
    [{ path: "a.ts" }, "Reading a.ts"],
    [{ path: "a.ts", offset: -1 }, "Reading a.ts"],
  ])("formats read target", (input, expected) => {
    expect(toolActivityTitle("read", input)).toBe(expected);
  });
});

it("projects the read range on the wire", () => {
  const projection = new ConversationProjection(new ConversationStreams({}));
  const [event] = projection.normalize("/workspace", "session", {
    type: "tool.started",
    runId: "run",
    toolCallId: "call",
    toolName: "read",
    args: { path: "a.ts", offset: 120, limit: 40 },
  });
  expect(event).toMatchObject({
    type: "tool.started",
    callId: "call",
    itemId: "call",
    tool: "read",
    status: "running",
    input: { path: "a.ts", offset: 120, limit: 40 },
    title: "Reading a.ts:120-159",
    presentation: { kind: "read", title: "Reading a.ts:120-159" },
  });
});

describe("leak channels", () => {
  it("drops a shell description that repeats the command", () => {
    const title = toolActivityTitle("bash", {
      command: "TOKEN=secret_value pnpm test",
      description: "Run TOKEN=secret_value pnpm test",
    });
    expect(title).toBe("Running bash");
    expect(title).not.toContain("secret_value");
  });
  it("scrubs a credential out of the description it publishes", () => {
    const presentation = toolActivityPresentation("bash", { description: "Run with TOKEN=abc123" });
    expect(presentation?.description).toBe("Run with TOKEN=[redacted]");
    expect(presentation?.title).toBe("Run with TOKEN=[redacted]");
  });
  it("keeps a scientific query intact", () => {
    expect(toolActivityTitle("web_search", { query: "secreted protein folding" })).toBe(
      "Searching the web for secreted protein folding",
    );
    expect(toolActivityTitle("grep", { pattern: "token binding kinase" })).toBe(
      "Searching for token binding kinase",
    );
  });
});
