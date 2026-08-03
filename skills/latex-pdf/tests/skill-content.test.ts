import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const fixtures = JSON.parse(fs.readFileSync(path.join(skillDir, "tests", "fixtures.json"), "utf8")) as Array<{
  prompt: string;
  expected_trigger: boolean;
  trigger_terms: string[];
}>;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function mentions(text: string, terms: string[]): boolean {
  const hay = normalize(text);
  return terms.some((t) => hay.includes(normalize(t)));
}

describe("latex-pdf skill content", () => {
  it("declares explicit license and matching directory name", () => {
    expect(skill).toMatch(/^license: Apache-2\.0/m);
    expect(path.basename(skillDir)).toBe("latex-pdf");
    expect(skill).toMatch(/^name: latex-pdf/m);
  });

  it("describes trigger conditions in the first description line", () => {
    const lines = skill.split("\n");
    const idx = lines.findIndex((l) => l.trimStart().startsWith("description:"));
    expect(idx).toBeGreaterThanOrEqual(0);
    const contentLine = lines.slice(idx + 1).find((l) => l.trim().length > 0) ?? "";
    expect(contentLine).toMatch(/generate latex documents and compile them to pdf/i);
    expect(contentLine.length).toBeLessThan(220);
  });

  it("declares both compilers as optional commands with fallback semantics", () => {
    expect(skill).toMatch(/name: tectonic[\s\S]*?kind: command[\s\S]*?optional: true/);
    expect(skill).toMatch(/name: pdflatex[\s\S]*?kind: command[\s\S]*?optional: true/);
    expect(skill).toMatch(/name: xelatex[\s\S]*?kind: command[\s\S]*?optional: true/);
    expect(skill).toMatch(/At least one of tectonic, pdflatex or xelatex/);
  });

  it("discloses Tectonic as MIT in third_party", () => {
    expect(skill).toMatch(/name: Tectonic[\s\S]*?license: MIT/);
  });

  it("requires compiler availability check before compiling", () => {
    expect(skill).toMatch(/command -v tectonic/);
    expect(skill).toMatch(/command -v pdflatex/);
    expect(skill).toMatch(/stop and report/);
  });

  it("mandates actual compilation with verbatim error quoting, no fabrication", () => {
    expect(skill).toMatch(/tectonic <file>\.tex/);
    expect(skill).toMatch(/halt-on-error/);
    expect(skill).toMatch(/quote the \*\*actual error lines\*\* from the log verbatim/);
    expect(skill).toMatch(/Never claim a compilation succeeded without running it/);
  });

  it("validates the produced artifact and reports workspace-relative paths", () => {
    expect(skill).toMatch(/Confirm the PDF exists/);
    expect(skill).toMatch(/workspace-relative path/);
    expect(skill).toMatch(/never emit `file:\/\/` URLs/);
  });

  it("handles CJK documents via xelatex/ctex instead of pdflatex", () => {
    expect(skill).toMatch(/xelatex/);
    expect(skill).toMatch(/ctex|xeCJK/);
  });

  it("matches trigger fixtures", () => {
    for (const f of fixtures) {
      expect(mentions(f.prompt, f.trigger_terms)).toBe(f.expected_trigger);
    }
  });
});
