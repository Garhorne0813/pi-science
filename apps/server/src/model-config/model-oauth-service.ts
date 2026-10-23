import { randomBytes, randomUUID } from "node:crypto";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AuthEvent, AuthPrompt, OAuthAuth } from "@earendil-works/pi-ai";
import type { ModelOAuthSessionView } from "@pi-science/contracts";
import { configPath, readJson, withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";
import { ModelConfigService, configError } from "./model-config-service.js";

type Session = {
  view: ModelOAuthSessionView; controller: AbortController; task?: Promise<void>; revision: number; committing?: boolean;
  pending?: { id: string; resolve: (value: string) => void; reject: (cause: unknown) => void };
};
type Options = { timeoutMs?: number; oauth?: (id: string) => OAuthAuth | undefined; published?: (revision: number) => Promise<"published" | "reload_pending"> };
const active = (session: Session) => session.view.status === "authorizing";
const safeUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};

/** Bridge pi-ai 0.99.2's public provider interaction to authenticated Settings APIs.
 * Sessions are scoped to this server/configuration owner; tokens never enter DTOs.
 */
export class ModelOAuthService {
  private sessions = new Map<string, Session>();
  constructor(private readonly service = new ModelConfigService(), private readonly options: Options = {}) {}
  private auth(id: string) { return this.options.oauth ? this.options.oauth(id) : builtinModels().getProvider(id)?.auth.oauth; }
  private prune() {
    for (const [id, session] of this.sessions) if (!active(session) && session.view.expires_at + 300000 < Date.now()) this.sessions.delete(id);
    if (this.sessions.size >= 32) for (const [id, session] of this.sessions) { if (!active(session)) { this.sessions.delete(id); break; } }
  }
  async start(id: string, revision: number, replaceExisting = false) {
    this.prune();
    const auth = this.auth(id), snapshot = this.service.readSync();
    if (!auth?.isSubscription) throw configError("unsupported_auth", "Subscription authorization is unavailable");
    if (snapshot.revision !== revision) throw configError("revision_conflict", "Configuration changed");
    if (this.sessions.size >= 32 || [...this.sessions.values()].filter(active).length >= 4 || [...this.sessions.values()].some((s) => active(s) && s.view.provider_id === id)) throw configError("oauth_busy", "Authorization is already in progress");
    const view = await this.service.view(id, snapshot);
    if (view.authentication.source !== "oauth" && (snapshot.credential_refs[id] || snapshot.keyless_providers.includes(id)) && !replaceExisting) throw configError("auth_replacement_required", "Confirm replacement of the existing authentication");
    const native = builtinModels().getProvider(id);
    if (view.config?.baseUrl && view.config.baseUrl !== native?.baseUrl) throw configError("unsupported_auth", "Subscription authorization requires the native endpoint");
    const session: Session = { revision, controller: new AbortController(), view: { id: randomBytes(24).toString("hex"), provider_id: id, status: "authorizing", expires_at: Date.now() + (this.options.timeoutMs ?? 600000), events: [] } };
    if ([...this.sessions.values()].some((entry) => active(entry) && entry.view.provider_id === id)) throw configError("oauth_busy", "Authorization is already in progress");
    this.sessions.set(session.view.id, session);
    session.task = this.run(session, auth);
    return this.public(session);
  }
  get(id: string) { const session = this.sessions.get(id); if (!session) throw configError("oauth_session_missing", "Authorization session is unavailable"); return this.public(session); }
  current(providerId: string) { this.prune(); const session = [...this.sessions.values()].reverse().find((s) => s.view.provider_id === providerId); return session ? this.public(session) : null; }
  respond(id: string, promptId: string, value: string) {
    const session = this.sessions.get(id);
    if (!session || !active(session) || session.pending?.id !== promptId) throw configError("oauth_prompt_conflict", "Authorization step changed");
    const prompt = session.view.prompt!;
    if (prompt.type === "select" && !prompt.options?.some((item) => item.id === value)) throw configError("invalid_config", "Invalid selection");
    const pending = session.pending;
    session.pending = undefined; delete session.view.prompt;
    pending.resolve(value);
    return this.public(session);
  }
  cancel(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw configError("oauth_session_missing", "Authorization session is unavailable");
    if (session.committing && active(session)) throw configError("oauth_busy", "Authorization is being saved");
    if (active(session)) { session.view.status = "cancelled"; session.view.error_code = "oauth_cancelled"; session.controller.abort(); }
    return this.public(session);
  }
  async close() { for (const session of this.sessions.values()) if (active(session) && !session.committing) this.cancel(session.view.id); await Promise.all([...this.sessions.values()].map((s) => s.task)); this.sessions.clear(); }
  private public(session: Session): ModelOAuthSessionView { return structuredClone(session.view); }
  private notify(session: Session, event: AuthEvent) {
    if (!active(session) || session.controller.signal.aborted) return;
    // Only provider interaction fields; never an exception or credential object.
    const events = session.view.events;
    if (event.type === "auth_url") { const url = safeUrl(event.url); if (url) events.push({ type: event.type, url, ...(event.instructions ? { instructions: event.instructions.slice(0, 2000) } : {}) }); }
    else if (event.type === "device_code") { const url = safeUrl(event.verificationUri); if (url) events.push({ type: event.type, userCode: event.userCode.slice(0, 200), verificationUri: url, expiresInSeconds: event.expiresInSeconds }); }
    else events.push({ type: event.type, message: event.message.slice(0, 2000), ...(event.type === "info" && event.links ? { links: event.links.flatMap((link) => { const url = safeUrl(link.url); return url ? [{ url, ...(link.label ? { label: link.label.slice(0, 200) } : {}) }] : []; }) } : {}) });
    // Preserve the actionable authorization URL/device code while bounding progress.
    if (events.length > 20) { const index = events.findIndex((item) => item.type === "info" || item.type === "progress"); events.splice(index >= 0 ? index : 0, 1); }
  }
  private prompt(session: Session, prompt: AuthPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = prompt.signal ? AbortSignal.any([session.controller.signal, prompt.signal]) : session.controller.signal;
      if (signal.aborted) { reject(new DOMException("Authorization cancelled", "AbortError")); return; }
      const id = randomUUID();
      const finish = (value?: string, error?: unknown) => {
        signal.removeEventListener("abort", abort);
        if (session.pending?.id === id) { session.pending = undefined; delete session.view.prompt; }
        if (error) reject(error); else resolve(value ?? "");
      };
      const abort = () => finish(undefined, new DOMException("Authorization cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      session.view.prompt = { id, type: prompt.type, message: prompt.message.slice(0, 2000), ...("placeholder" in prompt ? { placeholder: prompt.placeholder } : {}), ...(prompt.type === "select" ? { options: prompt.options.map((item) => ({ ...item })) } : {}) };
      session.pending = { id, resolve: (value) => finish(value), reject: (cause) => finish(undefined, cause) };
    });
  }
  private async deviceId() {
    const path = configPath("model-oauth-device.json");
    return withFileWriteLock(path, async () => {
      const stored = await readJson<{ id?: string }>(path, {});
      if (stored.id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(stored.id)) return stored.id;
      const id = randomUUID(); await writeJsonAtomic(path, { id }, { mode: 0o600 }); return id;
    });
  }
  private async run(session: Session, auth: OAuthAuth) {
    const timer = setTimeout(() => { if (active(session) && !session.committing) { session.view.status = "expired"; session.view.error_code = "oauth_timeout"; session.controller.abort(); } }, Math.max(1, session.view.expires_at - Date.now()));
    timer.unref();
    try {
      const deviceId = await this.deviceId();
      const credential = await auth.login({ signal: session.controller.signal, prompt: (prompt) => this.prompt(session, prompt), notify: (event) => this.notify(session, event) }, { getDeviceId: () => deviceId });
      session.controller.signal.throwIfAborted();
      if (credential.expires <= Date.now()) throw configError("invalid_oauth_grant", "Authorization is already expired");
      session.committing = true;
      const snapshot = await this.service.setOAuthCredential(session.view.provider_id, session.revision, credential, session.controller.signal);
      // Persistence is the success boundary; failed reload must not invite another login.
      try { session.view.runtime = await this.options.published?.(snapshot.revision) ?? "published"; } catch { session.view.runtime = "reload_pending"; }
      session.view.status = "succeeded";
    } catch (error) {
      if (active(session)) { session.view.status = "failed"; session.view.error_code = (error as { code?: string }).code === "revision_conflict" ? "revision_conflict" : "oauth_login_failed"; }
    } finally {
      clearTimeout(timer); session.pending?.reject(new DOMException("Authorization ended", "AbortError")); session.pending = undefined; delete session.view.prompt;
      // PKCE URLs and user/device codes are unnecessary after the flow settles.
      session.view.events = [];
    }
  }
}
