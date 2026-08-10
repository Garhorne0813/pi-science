import { describe, expect, it } from "vitest";
import { parseSuggestions } from "./suggestions";

describe("parseSuggestions", () => {
  it("extracts pipe-separated follow-ups and strips the comment", () => {
    const { clean, suggestions } = parseSuggestions("Answer body.\n\n<!--suggest: 换个数据集试试？ | Plot the residuals | Compare to baseline-->");
    expect(suggestions).toEqual(["换个数据集试试？", "Plot the residuals", "Compare to baseline"]);
    expect(clean).toBe("Answer body.");
  });

  it("returns the input untouched when no suggest comment exists", () => {
    const text = "Plain answer.\n\n<!-- other comment -->";
    expect(parseSuggestions(text)).toEqual({ clean: text, suggestions: [] });
  });

  it("drops empties, caps at three, and rejects over-long items", () => {
    const long = "q".repeat(121);
    expect(parseSuggestions(`x <!--suggest: a ||  | ${long} | b | c | d-->`).suggestions).toEqual(["a", "b", "c"]);
  });

  it("uses the last suggest comment and strips every one from the clean text", () => {
    const { clean, suggestions } = parseSuggestions("A <!--suggest: old--> B <!-- suggest: new one -->");
    expect(suggestions).toEqual(["new one"]);
    expect(clean).toBe("A  B");
  });

  it("repairs a repeated nested marker and removes duplicate suggestions", () => {
    const { clean, suggestions } = parseSuggestions(
      "完成。\n<!--suggest:帮我看看需求。<!--suggest:帮我看看这个工作区里有什么 | 我想这个工作区里有什么 | 我想这个工作区里有什么-->",
    );

    expect(clean).toBe("完成。");
    expect(suggestions).toEqual([
      "帮我看看需求。",
      "帮我看看这个工作区里有什么",
      "我想这个工作区里有什么",
    ]);
    expect(suggestions.join("")).not.toContain("<!--suggest:");
  });

  it("deduplicates suggestions across spacing, width, case, and terminal punctuation", () => {
    expect(parseSuggestions(
      "x <!--suggest: Plot results |  plot   results. | Ｐｌｏｔ results！ | Compare baseline -->",
    ).suggestions).toEqual(["Plot results", "Compare baseline"]);
  });
});
