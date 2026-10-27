import { afterEach, expect, it, vi } from "vitest";
import { DeepSeekWeb, deepSeekQuery } from "./deepseek.js";

const result = { title: "Research", url: "https://example.com/research", snippet: "Short", summary: "Detailed evidence", date: null };
afterEach(() => { vi.unstubAllGlobals(); });
const text = (value: Awaited<ReturnType<DeepSeekWeb["search"]>>) => value.content.map(part => part.type === "text" ? part.text : "").join("\n");

it("uses official Search/Fetch endpoints, Bearer authentication and provider-specific schemas", async () => {
  const transport = vi.fn(async (url, _init) => Response.json(String(url).endsWith("search") ? { results: [result] } : { title: "Article", content: "# Markdown evidence" }));
  vi.stubGlobal("fetch", transport);
  const web = new DeepSeekWeb();
  const search = await web.search({ query: "evidence", numResults: 3 }, "test-key");
  expect(transport.mock.calls[0]![0]).toBe("https://api.deepseek.com/v1/tools/search");
  expect(transport.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" } });
  expect(JSON.parse(transport.mock.calls[0]![1].body)).toEqual({ query: "evidence", count: 3, need_content: false });
  expect(text(search)).toContain("Detailed evidence");
  expect(search.details).toMatchObject({ provider: "deepseek", searchId: search.details.responseId });
  const page = await web.fetch("https://93.184.216.34/article", "test-key");
  expect(transport.mock.calls[1]![0]).toBe("https://api.deepseek.com/v1/tools/fetch");
  expect(JSON.parse(transport.mock.calls[1]![1].body)).toEqual({ url: "https://93.184.216.34/article" });
  expect(text(page)).toContain("# Markdown evidence");
  const count = transport.mock.calls.length;
  expect(text(web.page(page.details.responseId as string, 0, 5))).toContain("web_fetch");
  expect(transport).toHaveBeenCalledTimes(count);
});
it("maps domain and recency filters and checks Unicode length after adding them", () => {
  expect(deepSeekQuery({ query: "science", domainFilter: ["example.com", "other.org", "-ads.org"], recencyFilter: "week" }, new Date("2026-10-22T00:00:00Z")))
    .toBe("science site:example.com OR site:other.org -site:ads.org after:2026-10-15");
  expect(deepSeekQuery({ query: "🔬".repeat(128) })).toBe("🔬".repeat(128));
  expect(() => deepSeekQuery({ query: "🔬".repeat(129) })).toThrow("1–128");
  expect(() => deepSeekQuery({ query: "x".repeat(120), domainFilter: ["example.com"] })).toThrow("including site/date filters");
  expect(() => deepSeekQuery({ query: "science", domainFilter: ["example.com OR injected"] })).toThrow("hostnames");
});
it("rejects missing credentials and private targets without sending a request", async () => {
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  const web = new DeepSeekWeb();
  await expect(web.search({ query: "science" })).rejects.toThrow("API key");
  await expect(web.fetch("http://127.0.0.1/private", "key")).rejects.toThrow("private or reserved");
  expect(transport).not.toHaveBeenCalled();
});
it.each([401, 402, 403, 404, 429, 500])("reports HTTP %s without leaking the key or silently switching providers", async (status) => {
  const transport = vi.fn(async () => Response.json({ error: { message: "Rejected test-secret" } }, { status })); vi.stubGlobal("fetch", transport);
  const error = await new DeepSeekWeb().search({ query: "science" }, "test-secret").catch(error => error);
  expect(error.message).toContain(`HTTP ${status}`);
  expect(error.message).not.toContain("test-secret");
  expect(transport).toHaveBeenCalledOnce();
});
it("handles empty results, malformed payloads and bounded response bodies", async () => {
  const transport = vi.fn().mockResolvedValueOnce(Response.json({ results: [] })).mockResolvedValueOnce(Response.json({ results: [{}] }))
    .mockResolvedValueOnce(new Response("not json")).mockResolvedValueOnce(new Response("large", { headers: { "content-length": String(6 * 1024 * 1024) } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(6 * 1024 * 1024)));
  vi.stubGlobal("fetch", transport);
  const web = new DeepSeekWeb();
  expect(text(await web.search({ query: "science" }, "key"))).toContain("No matching results");
  await expect(web.search({ query: "science" }, "key")).rejects.toThrow("invalid search result");
  await expect(web.search({ query: "science" }, "key")).rejects.toThrow("invalid JSON");
  await expect(web.search({ query: "science" }, "key")).rejects.toThrow("size limit");
  await expect(web.search({ query: "science" }, "key")).rejects.toThrow("size limit");
});
it("forwards cancellation and evicts old cache entries", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    init.signal.throwIfAborted();
    return Response.json({ results: [] });
  }));
  const web = new DeepSeekWeb();
  await expect(web.search({ query: "science" }, "key", AbortSignal.abort())).rejects.toThrow();
  const first = await web.search({ query: "first" }, "key");
  for (let index = 0; index < 50; index++) await web.search({ query: `query ${index}` }, "key");
  expect(() => web.page(first.details.responseId as string)).toThrow("expired");
});
