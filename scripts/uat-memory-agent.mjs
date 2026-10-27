// Opt-in live-provider UAT. Requires a production build and configured model credentials.
// Uses a private temporary home/workspace; never changes the operator's Memory settings.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, open } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "pi-memory-agent-live-"));
const home = join(fixture, "home"), cwd = join(fixture, "workspace");
const sourceHome = process.env.PI_SCIENCE_LIVE_SOURCE_HOME || join(homedir(), ".pi-science");
const token = randomUUID();
let server, log;
const report = { model: null, checks: [], sessions: [], writes: [] };
try {
  await mkdir(home, { mode: 0o700 });
  await mkdir(cwd);
  // Memory UAT needs no scientific packages; a real lightweight venv avoids
  // provisioning an unrelated Conda scientific environment for this workspace.
  const venv = spawnSync(process.env.PI_SCIENCE_LIVE_PYTHON || "python3",
    ["-m", "venv", "--without-pip", join(cwd, ".venv")], { encoding: "utf8" });
  assert.equal(venv.status, 0, "Live UAT requires Python 3 with venv support");
  for (const name of ["config.json", "models.json", "credentials.json", "model-resources.json"]) {
    try { await copyFile(join(sourceHome, name), join(home, name)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  report.model = process.env.PI_SCIENCE_LIVE_MODEL || config.model;
  assert.ok(report.model, "Configure a model before running live UAT");
  config.skill_policy = { mode: "none" };
  await writeFile(join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  log = await open(join(fixture, "server.log"), "w", 0o600);
  server = spawn(process.execPath, [join(root, "apps/server/dist/app/main.js")], {
    cwd: join(root, "apps/server"), stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, PI_SCIENCE_HOME: home, PI_SCIENCE_WORKSPACES: join(fixture, "workspaces"),
      PI_SCIENCE_PORT: String(port), PI_SCIENCE_BACKEND_URL: base, PI_SCIENCE_HOST: "127.0.0.1",
      PI_SCIENCE_INTERNAL_TOKEN: token, PI_SCIENCE_REQUIRE_INTERNAL_TOKEN: "1",
      PI_SCIENCE_SQLITE_STATE: "1", PI_SCIENCE_AI_TITLES: "0", PI_SCIENCE_OPEN_BROWSER: "0",
      PI_SCIENCE_FRONTEND_DIST: join(root, "frontend/dist") },
  });
  async function api(path, method = "GET", body) {
    if (method !== "GET") console.log("Live UAT:", method, path.split("?")[0]);
    const response = await fetch(base + path, { method, headers: {
      "x-pi-science-internal-token": token, "content-type": "application/json",
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  const readyDeadline = Date.now() + 30000;
  while (true) {
    try { await api("/internal/ready"); break; }
    catch (error) {
      if (server.exitCode !== null || Date.now() > readyDeadline) throw error;
      await delay(200);
    }
  }
  const q = `?cwd=${encodeURIComponent(cwd)}`;
  const { connectors } = await api("/api/mcp/connectors");
  for (const connector of connectors.filter(item => item.enabled)) {
    await api(`/api/mcp/connectors/${connector.connector_id}/settings`, "PUT", {
      enabled: false, revision: connector.settings_revision,
      include_tools: connector.include_tools, exclude_tools: connector.exclude_tools,
      approval_mode: connector.approval_mode,
    });
  }
  await api("/api/workspaces/open", "POST", { path: cwd });
  async function createSession() {
    const result = await api("/api/sessions", "POST", { cwd,
      config: { model: report.model, thinking: "low", skills: [], extensions: [] } });
    report.sessions.push(result.id);
    return result.id;
  }
  async function turn(id, message) {
    await api(`/api/sessions/${id}/prompt${q}`, "POST", { message, client_message_id: randomUUID() });
    const deadline = Date.now() + 120000;
    while (true) {
      const state = await api(`/api/sessions/${id}/state${q}`);
      if (!state.is_streaming && !state.is_compacting) break;
      assert.ok(Date.now() < deadline, "Live turn timed out");
      await delay(300);
    }
    const response = await fetch(base + `/api/sessions/${id}/export${q}&format=jsonl`, {
      headers: { "x-pi-science-internal-token": token },
    });
    assert.equal(response.status, 200);
    return (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  const session = await createSession();
  const prompt = "记住我是一个算法工程师。请用 write_memory 将这条明确身份事实存入 profile，不要添加任何推测出的偏好。";
  const disabled = await turn(session, prompt);
  assert.ok(disabled.some(m => m.role === "toolResult" && m.toolName === "write_memory" &&
    JSON.stringify(m.content).includes("Enable Settings → Memory")), "Expected actionable disabled feedback");
  report.checks.push("Disabled Memory returns actionable feedback through a real model tool call");
  const { revision, ...settings } = await api("/api/memory/settings");
  await api("/api/memory/settings", "PATCH", { expectedRevision: revision,
    settings: { ...settings, enabled: true } });
  const messages = await turn(session, prompt);
  const results = messages.filter(m => m.role === "toolResult" && m.toolName === "write_memory");
  assert.ok(results.at(-1) && !results.at(-1).isError, "Live memory write failed");
  const { records } = await api("/api/memory/records" + q + "&scope=profile");
  assert.equal(records.length, 1);
  const record = records[0];
  const user = messages.findLast(m => m.role === "user");
  assert.deepEqual(record.sources.map(s => ({ kind: s.kind, locator: s.locator })),
    [{ kind: "message", locator: `${session}@${user.id}` }]);
  assert.equal(record.status, "pending_review");
  const modelWrites = messages.filter(m => m.role === "assistant").flatMap(m => m.content)
    .filter(c => c.type === "toolCall" && c.name === "write_memory");
  for (const call of modelWrites) {
    assert.ok(!(call.arguments.content.sources || []).some(s => ["message", "session"].includes(s.kind)));
    assert.ok(!call.arguments.content.subjectFrameId);
  }
  report.writes.push({ id: record.id, body: record.body, status: record.status, sources: record.sources });
  report.checks.push("ID-free real model write persists with the exact trusted user message source");
  report.checks.push("Professional identity remains pending human review");
  await api(`/api/memory/records/${record.id}/approve${q}`, "POST", {
    expectedRevision: record.revision, contentHash: record.contentHash,
  });
  const next = await createSession();
  const recalled = await turn(next, "根据已保存的记忆，我的职业是什么？请直接回答，不要猜测，也不要写入新记忆。");
  const answer = recalled.filter(m => m.role === "assistant").flatMap(m => m.content)
    .filter(c => c.type === "text").map(c => c.text).join("\n");
  assert.match(answer, /算法工程师|algorithm engineer/i);
  report.answer = answer;
  report.checks.push("A new session recalls the approved identity through a real model request");
  const reportPath = process.env.PI_SCIENCE_LIVE_REPORT || join(tmpdir(), "pi-science-memory-agent-live-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit"); server.kill("SIGTERM");
    await Promise.race([exited, delay(10000)]);
    if (server.exitCode === null) { server.kill("SIGKILL"); await exited; }
  }
  await log?.close();
  await rm(fixture, { recursive: true, force: true });
}
