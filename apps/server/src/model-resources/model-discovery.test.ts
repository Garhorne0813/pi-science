import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { discoverModelRows, MODEL_DISCOVERY_LIMITS } from "./model-discovery.js";
import { ModelResourceService } from "./model-resource-service.js";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-discovery-review-")); vi.stubEnv("PI_SCIENCE_HOME", root); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const url = "http://127.0.0.1:9999/v1/models";

it("paginates Anthropic by bounded same-endpoint cursors and deduplicates models", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ data: [{ id: "a" }, { id: "b" }], has_more: true, last_id: "b" })).mockResolvedValueOnce(json({ data: [{ id: "b" }, { id: "c" }], has_more: false }));
  expect((await discoverModelRows(url, "anthropic", {}, true)).map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect(String(fetch.mock.calls[1]![0])).toBe(`${url}?limit=100&after_id=b`);
});
it("maps protocol-specific fields and preserves explicit false without inventing absent values", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [{ id: "claude", max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: false }, thinking: { supported: true } } }, { id: "unknown" }] }));
  const result = await new ModelResourceService().testProviderConfiguration({ base_url: "http://127.0.0.1:9999/v1", protocol: "anthropic", auth: { kind: "none" } });
  expect(result.models[0]).toMatchObject({ kind: "chat", capabilities: { context_window: 200000, max_output_tokens: 64000, vision: false, reasoning: true } });
  expect(result.models[1]?.capabilities).toEqual({});
});
it.each(["pages", "models", "cursor", "malformed-cursor"])("rejects incomplete %s results without returning a partial catalog", async (limit) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ data: [{ id: "a" }, { id: "b" }], has_more: true, last_id: limit === "malformed-cursor" ? undefined : "a" }));
  await expect(discoverModelRows(url, "anthropic", {}, true, { ...MODEL_DISCOVERY_LIMITS, ...(limit === "pages" ? { pages: 1 } : limit === "models" ? { models: 1 } : {}) })).rejects.toMatchObject({ code: "discovery_incomplete" });
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
});
it("does not leak credentials or partial results on a second-page failure", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ data: [{ id: "a" }], has_more: true, last_id: "a" })).mockResolvedValueOnce(json({ error: "secret-do-not-echo" }, 401));
  const error = await discoverModelRows(url, "anthropic", { "x-api-key": "secret-do-not-echo" }, true).catch((error: Error) => error);
  expect(error).toMatchObject({ code: "discovery_auth" }); expect(String(error)).not.toContain("secret-do-not-echo");
});
it.each([[403, "discovery_auth"], [404, "discovery_unsupported"], [429, "discovery_rate_limited"], [500, "discovery_failed"]])("classifies HTTP %s using a safe code", async (status, code) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "private-key" }, Number(status)));
  await expect(discoverModelRows(url, "openai", {}, true)).rejects.toMatchObject({ code });
});
it("rejects malformed JSON, non-model payloads and excessive response bytes", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const payload of ["not-json", "null", "[]", '{"unexpected":true}']) {
    fetch.mockResolvedValueOnce(new Response(payload));
    await expect(discoverModelRows(url, "openai", {}, true)).rejects.toMatchObject({ code: "discovery_invalid_response" });
  }
  fetch.mockResolvedValueOnce(json({ data: [{ id: "too-large" }] }));
  await expect(discoverModelRows(url, "openai", {}, true, { ...MODEL_DISCOVERY_LIMITS, bytes: 4 })).rejects.toMatchObject({ code: "discovery_incomplete" });
});
it("enforces one deadline and aborts the outstanding page request", async () => {
  let signal: AbortSignal | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); });
  await expect(discoverModelRows(url, "anthropic", {}, true, { ...MODEL_DISCOVERY_LIMITS, timeoutMs: 25 })).rejects.toMatchObject({ code: "discovery_timeout" });
  expect(signal?.aborted).toBe(true);
});
it("revalidates each page against the current outbound policy", async () => {
  vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [{ id: "a" }], has_more: true, last_id: "a" }));
  await expect(discoverModelRows("https://models.example/v1/models", "anthropic", {}, false)).rejects.toMatchObject({ code: "discovery_failed" });
  expect(fetch).toHaveBeenCalledTimes(1); expect(lookup).toHaveBeenCalledTimes(2);
});

it("enforces one response byte budget across all pages", async () => {
  const page = { data: [{ id: "a" }], has_more: true, last_id: "a" };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ data: [{ id: "b" }], has_more: false }));
  await expect(discoverModelRows(url, "anthropic", {}, true, { ...MODEL_DISCOVERY_LIMITS, bytes: Buffer.byteLength(JSON.stringify(page)) + 5 })).rejects.toMatchObject({ code: "discovery_incomplete" });
  expect(fetch).toHaveBeenCalledTimes(2);
});
