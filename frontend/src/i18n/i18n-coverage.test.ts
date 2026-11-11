import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "./index";
import { useUiStore } from "../lib/ui";
import en from "./locales/en.json";
import zhHans from "./locales/zh-Hans.json";


const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});


function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}


function literalTranslationKeys(): string[] {
  const keys = new Set<string>();
  const pattern = /\b(?:t|i18n\.t)\(\s*["']([^"']+)["']/g;
  for (const file of sourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) keys.add(match[1]);
  }
  for (const key of [
    "fits.colormap.magma",
    "fits.colormap.viridis",
    "fits.colormap.gray",
    "fits.stretch.linear",
    "fits.stretch.log",
    "fits.stretch.asinh",
    "tableChart.chartType.line",
    "tableChart.chartType.bar",
    "tableChart.chartType.scatter",
    "molecule.style.stick",
    "molecule.style.sphere",
    "molecule.style.cartoon",
  ]) keys.add(key);
  return [...keys].sort();
}


describe("i18n resource coverage", () => {
  it("keeps locale JSON files in exact key parity", () => {
    expect(Object.keys(zhHans).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps translation resources outside the initialization module", () => {
    const source = readFileSync(path.join(srcRoot, "i18n", "index.ts"), "utf8");
    expect(source.split("\n").length).toBeLessThan(50);
    expect(source).toContain('./locales/en.json');
    expect(source).toContain('./locales/zh-Hans.json');
  });

  it("translates every literal UI key in English and Simplified Chinese", async () => {
    const missing: string[] = [];
    for (const language of ["en", "zh-Hans"]) {
      await i18n.changeLanguage(language);
      for (const key of literalTranslationKeys()) {
        const translated = i18n.t(key, {
          lng: language,
          count: 2,
          error: "test",
          format: "VCF",
          max: 10,
          min: 1,
          mean: 5,
          shown: 2,
          total: 3,
          value: "0.100",
          x: 1,
          y: 2,
          element: "A",
          strand: "+",
          score: 1,
        });
        if (translated === key) missing.push(`${language}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("does not hard-code accessible control labels in JSX", () => {
    const hardCoded: string[] = [];
    const pattern = /aria-label\s*=\s*["']([^"']+)["']/g;
    for (const file of sourceFiles(srcRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        hardCoded.push(`${path.relative(srcRoot, file)}:${match[1]}`);
      }
    }
    expect(hardCoded).toEqual([]);
  });

  it("persists and applies the language selected in Settings", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: vi.fn(), setItem } });

    useUiStore.getState().setLocale("zh-CN");

    await vi.waitFor(() => expect(i18n.language).toBe("zh-Hans"));
    expect(useUiStore.getState().locale).toBe("zh-Hans");
    expect(setItem).toHaveBeenCalledWith("pi-science.locale", JSON.stringify("zh-Hans"));
  });
});


/** Count-bearing keys whose copy cannot inflect (labels, units, past tense,
 *  parenthetical counts). Everything else with {{count}} must ship a real
 *  singular/plural pair, otherwise English prints "~1 rows". */
const PLURAL_INVARIANT_KEYS = new Set([
  "conversation.activity.failureSummary",
  "conversation.activity.executionDetails",
  // The count-only progress copy interpolates a number and a dynamic unit token ("items", "files"); no noun inflects.
  "conversation.activity.progressCount",
  "settings.mcpPage.importLegacy",
  "settings.mcpPage.importSelected",
  "phase.stableCount",
  "knowledge.safetyReferences",
  "conversation.generatedFilesLabel",
  "conversation.referencedFilesLabel",
  "conversation.moreColumns",
  "runs.succeededCount",
  "memory.schedulerDiagnostic",
  "memory.unchangedFields",
  "memory.elapsedSeconds",
]);


describe("i18n plural resources", () => {
  it("gives every countable key singular and plural variants in both languages", () => {
    const missing: string[] = [];
    for (const [key, value] of Object.entries(en)) {
      if (typeof value !== "string" || !value.includes("{{count}}")) continue;
      if (/_one$|_other$/.test(key)) continue;
      if (PLURAL_INVARIANT_KEYS.has(key)) continue;
      for (const suffix of ["_one", "_other"]) {
        if (!(`${key}${suffix}` in en)) missing.push(`en:${key}${suffix}`);
        if (!(`${key}${suffix}` in zhHans)) missing.push(`zh-Hans:${key}${suffix}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves English singular and plural forms from the count", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("provenance.packageCount", { count: 1 })).toBe("1 package");
    expect(i18n.t("provenance.packageCount", { count: 3 })).toBe("3 packages");
    expect(i18n.t("office.truncatedPrefix", { count: 1 })).toBe("Showing first 1 row");
    expect(i18n.t("office.truncatedPrefix", { count: 2 })).toBe("Showing first 2 rows");
    expect(i18n.t("knowledge.reviewCreated", { count: 1 })).toBe("1 new proposal created");
    expect(i18n.t("knowledge.reviewCreated", { count: 2 })).toBe("2 new proposals created");
  });

  it("no longer relies on the deprecated _plural suffix", () => {
    expect(Object.keys(en).filter((key) => key.endsWith("_plural"))).toEqual([]);
  });
});

