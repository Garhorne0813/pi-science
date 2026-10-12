import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = new URL("./check-http-health.mjs", import.meta.url);
async function probe(url, deadline) {
  const started = performance.now();
  const child = spawn(process.execPath, [fileURLToPath(script), url, ...(deadline === undefined ? [] : [String(deadline)])], { stdio: "ignore" });
  const timeout = setTimeout(() => child.kill(), 6000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.notEqual(code, null, "probe exceeded the test watchdog");
    return { code, elapsed: performance.now() - started };
  } finally { clearTimeout(timeout); }
}

test("HTTP probe bounds stalled headers and a continuously streaming body", { timeout: 15000 }, async () => {
  const intervals = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/headers") return;
    if (req.url === "/body") {
      res.writeHead(200);
      const interval = setInterval(() => res.write("still streaming\n"), 30);
      intervals.add(interval);
      res.on("close", () => { clearInterval(interval); intervals.delete(interval); });
      return;
    }
    res.writeHead(req.url === "/error" ? 503 : 200);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await probe(base)).code, 0);
    assert.equal((await probe(`${base}/error`)).code, 1);
    assert.equal((await probe(base, (Date.now() - 1000) / 1000)).code, 1);
    for (const path of ["headers", "body"]) {
      const result = await probe(`${base}/${path}`);
      assert.equal(result.code, 1);
      assert.ok(result.elapsed < 4000, "request exceeded its 2-second bound");
      const capped = await probe(`${base}/${path}`, (Date.now() + 400) / 1000);
      assert.equal(capped.code, 1);
      assert.ok(capped.elapsed < 1500, "remaining startup deadline was ignored");
    }
  } finally {
    for (const interval of intervals) clearInterval(interval);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
