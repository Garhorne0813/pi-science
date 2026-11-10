import { describe, expect, it } from "vitest";
import {
  readToolProgressStream,
  TOOL_PROGRESS_SENTINEL as sentinel,
} from "./tool-progress-stream.js";

const payload = {
  version: 1,
  scopeId: "files:1",
  scopeLabel: "Files",
  current: 2,
  total: 10,
  unit: "files",
  totalKind: "fixed",
};
const line = (value: unknown) => `${sentinel} ${JSON.stringify(value)}\n`;

describe("readToolProgressStream", () => {
  it("removes valid lines and returns progress", () => {
    expect(readToolProgressStream(line(payload))).toEqual({
      text: "",
      progress: { ...payload, determinate: true },
    });
  });
  it("leaves ordinary numbers and percentages unchanged", () => {
    const text = "Downloaded 10 files (50%)\n42";
    expect(readToolProgressStream(text)).toEqual({ text });
  });
  it("leaves a token away from column zero untouched", () => {
    const text = `ordinary ${sentinel} ${JSON.stringify(payload)}\n`;
    expect(readToolProgressStream(text)).toEqual({ text });
  });
  it("drops valid JSON that is not a progress object", () => {
    expect(readToolProgressStream(line([1, 2]))).toEqual({ text: "" });
  });
  it("returns the newest valid progress", () => {
    expect(
      readToolProgressStream(line(payload) + line({ ...payload, current: 3 })).progress?.current,
    ).toBe(3);
  });
  it("drops malformed JSON without throwing", () => {
    expect(readToolProgressStream(`${sentinel} {broken\n`)).toEqual({ text: "" });
  });
  it("drops incomplete control lines", () => {
    expect(readToolProgressStream(`${sentinel} ${JSON.stringify(payload)}`)).toEqual({ text: "" });
  });
  it("drops control lines longer than 512 bytes", () => {
    expect(readToolProgressStream(line({ ...payload, extra: "é".repeat(256) }))).toEqual({
      text: "",
    });
  });
  it("marks current above total as indeterminate", () => {
    expect(readToolProgressStream(line({ ...payload, current: 11 })).progress?.determinate).toBe(
      false,
    );
  });
  it.each([0, NaN, Infinity])("does not report a determinate total of %s", (total) => {
    const result = readToolProgressStream(line({ ...payload, total }));
    expect(result.text).toBe("");
    expect(result.progress?.determinate).toBe(false);
  });
  it("rejects a payload without scopeId", () => {
    expect(readToolProgressStream(line({ ...payload, scopeId: undefined }))).toEqual({ text: "" });
  });
  it("keeps stdout in order around control lines", () => {
    expect(readToolProgressStream(`before\n${line(payload)}after\n`)).toEqual({
      text: "before\nafter\n",
      progress: { ...payload, determinate: true },
    });
  });
});
