import { describe, expect, it } from "vitest";
import { proposeCandidates } from "./heuristics.js";

const message = (id: string, text: string) => ({ id, content: [{ type: "text", text }] });

describe("bookmark proposeCandidates", () => {
  it("picks English result-bearing messages", () => {
    const candidates = proposeCandidates([
      message("m1", "Here is the raw data table."),
      message("m2", "The conclusion is that the catalyst works."),
      message("m3", "We saved the cleaned dataset to data/clean.csv."),
    ]);
    expect(candidates).toEqual(["m2", "m3"]);
  });

  it("matches CJK keywords as substrings", () => {
    const candidates = proposeCandidates([
      message("m1", "结论：该材料在高温下稳定。"),
      message("m2", "中间步骤记录如下。"),
      message("m3", "已生成图 3 和表 2。"),
    ]);
    expect(candidates).toEqual(["m1", "m3"]);
  });

  it("returns nothing when no message matches", () => {
    expect(proposeCandidates([message("m1", "just a progress note")])).toEqual([]);
    expect(proposeCandidates([])).toEqual([]);
  });

  it("keeps at most the last two matches", () => {
    const candidates = proposeCandidates([
      message("m1", "Finding one."),
      message("m2", "Finding two."),
      message("m3", "Finding three."),
      message("m4", "Finding four."),
    ]);
    expect(candidates).toEqual(["m3", "m4"]);
  });

  it("tolerates non-text parts", () => {
    const candidates = proposeCandidates([
      { id: "m1", content: [{ type: "tool-call" }] },
      { id: "m2", content: [{ type: "text", text: "Decision recorded." }] },
    ]);
    expect(candidates).toEqual(["m2"]);
  });
});
