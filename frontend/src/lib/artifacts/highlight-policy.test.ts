import { describe, expect, it } from "vitest";
import {
  MAX_AUTO_CHARS,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  codeViewLanguage,
  shouldSkipAutoDetect,
  shouldSkipHighlight,
} from "./highlight-policy";

describe("shouldSkipHighlight", () => {
  it("keeps normal source files highlighted", () => {
    expect(shouldSkipHighlight("print('hello')\n")).toBe(false);
    expect(shouldSkipHighlight("x".repeat(MAX_HIGHLIGHT_CHARS))).toBe(false);
    expect(shouldSkipHighlight(Array.from({ length: MAX_HIGHLIGHT_LINES }, () => "x").join("\n"))).toBe(false);
  });

  it("skips files above the character guard", () => {
    expect(shouldSkipHighlight("x".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(true);
  });

  it("skips files above the line guard even when they are small in bytes", () => {
    expect(shouldSkipHighlight(Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "x").join("\n"))).toBe(true);
  });
});

describe("shouldSkipAutoDetect", () => {
  it("allows auto-detection at and below the cap", () => {
    expect(shouldSkipAutoDetect("")).toBe(false);
    expect(shouldSkipAutoDetect("x".repeat(MAX_AUTO_CHARS))).toBe(false);
  });

  it("skips auto-detection above the cap", () => {
    expect(shouldSkipAutoDetect("x".repeat(MAX_AUTO_CHARS + 1))).toBe(true);
  });
});

describe("codeViewLanguage", () => {
  it("forces molecule previews to plain text", () => {
    expect(codeViewLanguage("molecule", undefined)).toBe("plaintext");
    expect(codeViewLanguage("molecule", "pdb")).toBe("plaintext");
  });

  it("forces genome previews to plain text", () => {
    expect(codeViewLanguage("genome", undefined)).toBe("plaintext");
    expect(codeViewLanguage("genome", "vcf")).toBe("plaintext");
  });

  it("passes text languages through unchanged", () => {
    expect(codeViewLanguage("text", "json")).toBe("json");
    expect(codeViewLanguage("text", undefined)).toBeUndefined();
  });
});
