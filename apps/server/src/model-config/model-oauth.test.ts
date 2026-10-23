import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { ModelOAuthService } from "./model-oauth-service.js";
import { ModelConfigService, modelConfigPath } from "./model-config-service.js";
import { ModelCredentialAdapter } from "./model-credential-adapter.js";
import { agentModels } from "../runtime/agent/worker/agent-models.js";

let root: string;
const brokers: ModelOAuthService[] = [];
const credential = (expires = Date.now() + 3600000): OAuthCredential => ({ type: "oauth", access: "access-not-for-browser", refresh: "refresh-not-for-browser", expires, clientId: "issued-client-id", scopes: ["chatgpt.tokens.use.direct"] });
const fakeAuth = (login: OAuthAuth["login"]): OAuthAuth => ({ name: "Test subscription", isSubscription: true, login, refresh: async (c) => c, toAuth: async (c) => ({ apiKey: c.access }) });
function broker(service = new ModelConfigService(), auth?: OAuthAuth, timeoutMs?: number) {
  const result = new ModelOAuthService(service, { ...(auth ? { oauth: () => auth } : {}), timeoutMs }); brokers.push(result); return result;
}
async function waitFor<T>(read: () => T, accept: (value: T) => boolean) {
  let value = read(); await vi.waitFor(() => { value = read(); expect(accept(value)).toBe(true); }, { timeout: 5000, interval: 10 }); return value;
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-oauth-")); vi.stubEnv("PI_SCIENCE_HOME", root); });
afterEach(async () => { await Promise.all(brokers.splice(0).map((b) => b.close())); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("real pi-ai 0.99.2 OAuth adapters", () => {
  it("runs ChatGPT PKCE/manual callback, stores the grant, restores it and supplies auth to a Worker registry", async () => {
    let verifier = "";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.openai.com/api/accounts/oauth/token");
      const body = new URLSearchParams(init?.body as URLSearchParams); verifier = body.get("code_verifier")!;
      expect(body.get("client_id")).toBe("issued-client-id");
      return Response.json({ access_token: "access-not-for-browser", refresh_token: "refresh-not-for-browser", expires_in: 3600, id_token: "provider-id-token", scope: "openid chatgpt.tokens.use.direct" });
    });
    vi.stubGlobal("fetch", fetch);
    const service = new ModelConfigService(), flows = broker(service);
    const started = await flows.start("openai", 0);
    const pending = await waitFor(() => flows.get(started.id), (s) => Boolean(s.prompt));
    const event = pending.events.find((event) => event.type === "auth_url"); expect(event?.type).toBe("auth_url");
    if (!event || event.type !== "auth_url") throw new Error("Missing provider authorization URL");
    const url = new URL(event.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    flows.respond(started.id, pending.prompt!.id, `http://127.0.0.1:1455/auth/callback?state=${url.searchParams.get("state")}&code=test-code&client_id=issued-client-id`);
    const done = await waitFor(() => flows.get(started.id), (s) => s.status !== "authorizing"); expect(done.status).toBe("succeeded");
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(JSON.stringify(done)).not.toMatch(/access-not-for-browser|refresh-not-for-browser|test-code/);
    expect(await readFile(modelConfigPath(), "utf8")).not.toMatch(/access-not-for-browser|refresh-not-for-browser/);
    expect(await new ModelConfigService().view("openai")).toMatchObject({ configured: true, authentication: { source: "oauth", resolved: true, oauth: { account: null, plan: null } } });
    expect((await agentModels().getAuth("openai"))?.auth.apiKey).toBe("access-not-for-browser");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched OAuth state and preserves a previous API connection", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const service = new ModelConfigService(); await service.setCredential("openai", 0, { source: "managed", secret: "original-api-key" });
    const before = service.readSync(), flows = broker(service);
    await expect(flows.start("openai", 1)).rejects.toMatchObject({ code: "auth_replacement_required" });
    const started = await flows.start("openai", 1, true), pending = await waitFor(() => flows.get(started.id), (s) => Boolean(s.prompt));
    flows.respond(started.id, pending.prompt!.id, "http://127.0.0.1:1455/auth/callback?state=wrong&code=private-code&client_id=issued-client-id");
    const failed = await waitFor(() => flows.get(started.id), (s) => s.status !== "authorizing");
    expect(failed).toMatchObject({ status: "failed", error_code: "oauth_login_failed" }); expect(JSON.stringify(failed)).not.toContain("private-code");
    expect(service.readSync()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
  it("runs the SDK Copilot device-code flow and preserves account-specific auth metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) return Response.json({ device_code: "private-device-code", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 60 });
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "github-refresh-token" });
      if (url.endsWith("/copilot_internal/v2/token")) return Response.json({ token: "copilot-access-token", expires_at: Math.floor(Date.now() / 1000) + 3600 });
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-4.1", model_picker_enabled: true, policy: { state: "enabled" } }] });
      throw new Error("Unexpected SDK endpoint");
    }));
    const flows = broker(), started = await flows.start("github-copilot", 0);
    const prompt = await waitFor(() => flows.get(started.id), (s) => Boolean(s.prompt)); flows.respond(started.id, prompt.prompt!.id, "");
    const waiting = await waitFor(() => flows.get(started.id), (s) => s.events.some((e) => e.type === "device_code"));
    expect(JSON.stringify(waiting)).not.toContain("private-device-code");
    expect(waiting.events).toContainEqual(expect.objectContaining({ type: "device_code", userCode: "ABCD-1234" }));
    expect((await waitFor(() => flows.get(started.id), (s) => s.status !== "authorizing")).status).toBe("succeeded");
    const auth = await agentModels().getAuth("github-copilot"); expect(auth?.auth.apiKey).toBe("copilot-access-token"); expect(auth?.auth.baseUrl).toBe("https://api.individual.githubcopilot.com");
  });
});

it("cancels pending prompts without modifying credentials and rejects stale prompt answers", async () => {
  const flows = broker(undefined, fakeAuth(async (i) => { await i.prompt({ type: "manual_code", message: "Paste code" }); return credential(); }));
  const started = await flows.start("openai", 0), pending = await waitFor(() => flows.get(started.id), (s) => Boolean(s.prompt));
  expect(flows.cancel(started.id).status).toBe("cancelled");
  expect(() => flows.respond(started.id, pending.prompt!.id, "code")).toThrow();
  await flows.close(); expect(new ModelConfigService().readSync().revision).toBe(0);
});
it("times out the flow and sanitizes provider failures", async () => {
  const flows = broker(undefined, fakeAuth(async (i) => { await i.prompt({ type: "secret", message: "Code" }); throw new Error("upstream-token-value"); }), 40);
  const started = await flows.start("openai", 0);
  expect((await waitFor(() => flows.get(started.id), (s) => s.status === "expired")).error_code).toBe("oauth_timeout");
  const denied = broker(undefined, fakeAuth(async () => { throw new Error("upstream-token-value"); }));
  const another = await denied.start("openai", 0); const failed = await waitFor(() => denied.get(another.id), (s) => s.status === "failed");
  expect(JSON.stringify(failed)).not.toContain("upstream-token-value");
});
it("does not overwrite concurrent configuration changes when authorization completes", async () => {
  const service = new ModelConfigService(), flows = broker(service, fakeAuth(async (i) => { await i.prompt({ type: "text", message: "Confirm" }); return credential(); }));
  const started = await flows.start("openai", 0), pending = await waitFor(() => flows.get(started.id), (s) => Boolean(s.prompt));
  await service.setCredential("openai", 0, { source: "managed", secret: "newer-api-key" });
  flows.respond(started.id, pending.prompt!.id, "confirmed");
  const failed = await waitFor(() => flows.get(started.id), (s) => s.status === "failed"); expect(failed.error_code).toBe("revision_conflict");
  expect((await new ModelCredentialAdapter(service).read("openai"))).toEqual({ type: "api_key", key: "newer-api-key" });
});
it("refreshes once across concurrent Worker snapshots without changing native revision", async () => {
  const service = new ModelConfigService(); await service.setOAuthCredential("openai", 0, credential(Date.now() - 1000));
  const revision = service.readSync().revision;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: "chatgpt.tokens.use.direct" })));
  const snapshot = service.readSync();
  const [a, b] = await Promise.all([agentModels({ modelConfigSnapshot: snapshot }).getAuth("openai"), agentModels({ modelConfigSnapshot: snapshot }).getAuth("openai")]);
  expect(a?.auth.apiKey).toBe("fresh-access"); expect(b?.auth.apiKey).toBe("fresh-access"); expect(fetch).toHaveBeenCalledTimes(1);
  expect(service.readSync().revision).toBe(revision); expect((await new ModelCredentialAdapter(service).read("openai"))?.type).toBe("oauth");
});
it("preserves failed refresh grants, and cannot resurrect logout or adopt a reauthorized account", async () => {
  const service = new ModelConfigService(); await service.setOAuthCredential("openai", 0, credential(Date.now() - 1000));
  const snapshot = service.readSync(), old = new ModelCredentialAdapter(service, snapshot);
  await expect(old.modify("openai", async () => { throw new Error("refresh-denied"); })).rejects.toThrow("refresh-denied");
  expect(await old.read("openai")).toMatchObject({ type: "oauth", access: "access-not-for-browser", refresh: "refresh-not-for-browser" });
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { release = r; });
  const pending = old.modify("openai", async (c) => { entered(); await gate; return { ...c as OAuthCredential, access: "late-token", expires: Date.now() + 3600000 }; });
  await waiting; await service.setCredential("openai", 1, { source: "remove" }); release(); expect(await pending).toBeUndefined();
  expect(await old.read("openai")).toBeUndefined();
  await service.setOAuthCredential("openai", 2, { ...credential(), access: "different-account" });
  expect(await old.read("openai")).toBeUndefined(); expect((await agentModels().getAuth("openai"))?.auth.apiKey).toBe("different-account");
});
it("serializes refresh mutations across separate Node processes", async () => {
  const service = new ModelConfigService(); await service.setOAuthCredential("openai", 0, credential(Date.now() - 1000));
  const count = join(root, "refresh-count"), adapterModule = new URL("./model-credential-adapter.ts", import.meta.url).href;
  const script = `import { ModelCredentialAdapter } from ${JSON.stringify(adapterModule)}; import { appendFile } from 'node:fs/promises'; await new ModelCredentialAdapter().modify('openai', async (c) => { if (c.expires > Date.now()) return undefined; await appendFile(${JSON.stringify(count)}, 'refresh\\n'); await new Promise(r => setTimeout(r, 100)); return {...c, access:'cross-process', expires:Date.now()+3600000}; });`;
  const childEnvironment = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!] ]));
  const child = () => new Promise<void>((resolve, reject) => { const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...childEnvironment, PI_SCIENCE_HOME: root }, stdio: ["ignore", "ignore", "pipe"] }); let error = ""; processChild.stderr.on("data", (chunk) => { error += String(chunk); }); processChild.on("error", reject); processChild.on("close", (code) => code === 0 ? resolve() : reject(new Error(error))); });
  await Promise.all([child(), child()]); expect((await readFile(count, "utf8")).trim().split("\n")).toHaveLength(1);
  expect((await agentModels().getAuth("openai"))?.auth.apiKey).toBe("cross-process"); expect(service.readSync().revision).toBe(1);
}, 15000);

it("does not route a grant mapped to a different provider or persist an expired refresh result", async () => {
  const service = new ModelConfigService(); await service.setOAuthCredential("openai", 0, credential());
  await service.update(1, (snapshot) => { snapshot.credential_refs.anthropic = snapshot.credential_refs.openai!; snapshot.config.providers.anthropic = {}; });
  const adapter = new ModelCredentialAdapter(service, service.readSync());
  expect(await adapter.read("anthropic")).toBeUndefined(); expect((await service.view("anthropic")).authentication.resolved).toBe(false);
  await expect(adapter.modify("openai", async () => credential(Date.now() - 1))).rejects.toMatchObject({ code: "invalid_oauth_grant" });
  expect((await adapter.read("openai"))?.type).toBe("oauth");
});

it("never overwrites a credential whose ownership changed while refresh was in flight", async () => {
  const service = new ModelConfigService(); await service.setOAuthCredential("openai", 0, credential());
  const ref = service.readSync().credential_refs.openai!, adapter = new ModelCredentialAdapter(service, service.readSync());
  await expect(adapter.modify("openai", async () => {
    await service.credentials.put({ id: ref, kind: "api_key", backend: "managed", secret: "mcp-replacement", owner_kind: "mcp", owner_id: "connector" });
    return { ...credential(), access: "must-not-overwrite-mcp" };
  })).rejects.toMatchObject({ code: "credential_owner_conflict" });
  expect((await service.credentials.getForRuntime(ref))?.secret).toBe("mcp-replacement");
});
