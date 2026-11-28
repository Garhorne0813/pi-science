import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalRuntimeModelRef } from "./model-ref.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-model-ref-"));
  vi.stubEnv("PI_SCIENCE_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("canonicalRuntimeModelRef", () => {
  it("maps a retired DeepSeek Flash id to its catalog successor", () => {
    expect(canonicalRuntimeModelRef("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-flash");
  });

  it("leaves current and unknown model ids untouched", () => {
    expect(canonicalRuntimeModelRef("deepseek/deepseek-flash")).toBe("deepseek/deepseek-flash");
    expect(canonicalRuntimeModelRef("deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(canonicalRuntimeModelRef("lab/custom-model")).toBe("lab/custom-model");
  });
});
