import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contentDigest, randomIdSuffix } from "./research-identity";


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("research identity helpers", () => {
  it("uses crypto.randomUUID for id suffixes when available", () => {
    vi.stubGlobal("crypto", webcrypto);
    const suffix = randomIdSuffix();
    expect(suffix).toMatch(/^[a-z0-9]{12}$/);
    expect(randomIdSuffix(32)).toMatch(/^[a-z0-9]{32}$/);
    expect(randomIdSuffix()).not.toBe(suffix);
  });

  it("computes sha256 content digests via crypto.subtle when available", async () => {
    vi.stubGlobal("crypto", webcrypto);
    expect(await contentDigest("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const digest = await contentDigest("evaluator-content");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await contentDigest("evaluator-content")).toBe(digest);
    expect(await contentDigest("other-content")).not.toBe(digest);
  });

  it("falls back to insecure-context-safe implementations without crypto APIs", async () => {
    vi.stubGlobal("crypto", {});
    const suffix = randomIdSuffix();
    expect(suffix).toMatch(/^[a-z0-9]{12}$/);
    expect(randomIdSuffix(32)).toMatch(/^[a-z0-9]{32}$/);
    expect(randomIdSuffix()).not.toBe(suffix);
    expect(await contentDigest("")).toBe("fnv1a:cbf29ce484222325");
    const digest = await contentDigest("evaluator-content");
    expect(digest).toMatch(/^fnv1a:[0-9a-f]{16}$/);
    expect(await contentDigest("evaluator-content")).toBe(digest);
    expect(await contentDigest("other-content")).not.toBe(digest);
  });
});
