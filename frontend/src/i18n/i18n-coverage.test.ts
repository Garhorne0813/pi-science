import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "./index";
import { useUiStore } from "../lib/store";


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
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(fullPath);
  }
  return files;
}


function literalTranslationKeys(): string[] {
  const keys = new Set<string>();
  const pattern = /\bt\(\s*"([^"]+)"/g;
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
  ]) keys.add(key);
  return [...keys].sort();
}


describe("i18n resource coverage", () => {
  it("translates every literal UI key in English and Simplified Chinese", () => {
    const missing: string[] = [];
    for (const language of ["en", "zh-Hans"]) {
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

  it("persists and applies the language selected in Settings", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: vi.fn(), setItem } });

    useUiStore.getState().setLocale("zh-CN");

    await vi.waitFor(() => expect(i18n.language).toBe("zh-Hans"));
    expect(useUiStore.getState().locale).toBe("zh-Hans");
    expect(setItem).toHaveBeenCalledWith("pi-science.locale", JSON.stringify("zh-Hans"));
  });
});
