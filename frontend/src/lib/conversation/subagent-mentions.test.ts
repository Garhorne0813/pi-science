import { describe, expect, it } from "vitest";
import { visibleUserMessage } from "../files/file-references";
import { injectSubagentMentions, stripSubagentMentionBlock, type SubagentMention } from "./subagent-mentions";

const mention = (name: string, start = 0): SubagentMention => ({ id: name, name, start, end: start + name.length + 1 });

describe("subagent mentions", () => {
  it("adds a deduplicated delegation block and keeps it out of the visible message", () => {
    const message = injectSubagentMentions("@reviewer @reviewer inspect this", [mention("reviewer"), mention("reviewer", 10)]);
    expect(message.match(/- "reviewer"/g)).toHaveLength(1);
    expect(message).toContain("Use the installed subagent tool");
    expect(visibleUserMessage(message)).toBe("@reviewer @reviewer inspect this");
  });

  it("supports runtime-qualified names and ignores unsafe names", () => {
    const message = injectSubagentMentions("hello", [mention("Science.Auditor"), mention("bad name")]);
    expect(message).toContain('- "Science.Auditor"');
    expect(message).not.toContain("bad name");
    expect(stripSubagentMentionBlock("hello")).toBe("hello");
  });
});
