import { useEffect, useState, useCallback } from "react";
import { Key, Trash2, Eye, EyeOff, Check, Loader2, Cpu, Puzzle, FlaskConical, Languages } from "lucide-react";
import { cn } from "../../lib/cn";
import { shippedLocales } from "../../i18n/config";
import { useUiStore } from "../../lib/store";

type Tab = "general" | "llm" | "extensions" | "mcp";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Languages size={14} /> },
  { id: "llm", label: "LLM", icon: <Cpu size={14} /> },
  { id: "extensions", label: "Extensions", icon: <Puzzle size={14} /> },
  { id: "mcp", label: "MCP", icon: <FlaskConical size={14} /> },
];

interface Provider {
  id: string; name: string; models: string[]; has_key: boolean;
}

interface CustomProvider {
  id: string; name: string; base_url: string; api: string; models: string[]; has_key: boolean;
}

interface Config {
  api_keys: Record<string, boolean>; model: string; thinking: string; providers: Provider[];
  custom_providers: CustomProvider[];
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/config");
      setConfig(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveKey = async (provider: string) => {
    const key = apiKeyInput[provider]?.trim();
    if (!key) return;
    setSaving(provider);
    try {
      await fetch("/api/settings/api-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, api_key: key }) });
      setApiKeyInput((prev) => ({ ...prev, [provider]: "" }));
      await loadConfig();
    } catch (e) { console.error(e); }
    finally { setSaving(null); }
  };

  const deleteKey = async (provider: string) => {
    setSaving(provider);
    try {
      await fetch(`/api/settings/api-key/${provider}`, { method: "DELETE" });
      await loadConfig();
    } catch (e) { console.error(e); }
    finally { setSaving(null); }
  };

  const saveModel = async (model: string, thinking?: string) => {
    setSaving("model");
    try {
      await fetch("/api/settings/model", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, thinking: thinking || config?.thinking || "high" }) });
      await loadConfig();
    } catch (e) { console.error(e); }
    finally { setSaving(null); }
  };

  if (loading) return <div className="flex items-center justify-center h-full text-sm text-muted"><Loader2 size={18} className="animate-spin mr-2" />Loading…</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-8 py-8">
        <h1 className="font-serif text-xl text-text mb-6">Settings</h1>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 rounded-input bg-surface-2 p-0.5 w-fit">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("flex items-center gap-1.5 rounded-input px-3 py-1.5 text-[13px] font-medium transition-colors",
                tab === t.id ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {tab === "general" && <GeneralTab />}
        {tab === "llm" && <LLMTab config={config!} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} saveModel={saveModel} onConfigReload={loadConfig} />}
        {tab === "extensions" && <ExtensionsTab />}
        {tab === "mcp" && <MCPTab />}
      </div>
    </div>
  );
}

function GeneralTab() {
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  return (
    <div className="space-y-6">
      <Section title="Language / 语言">
        <p className="mb-3 text-[11px] text-muted">
          Project Knowledge and scientific inspectors update immediately. Other workbench labels currently remain in English.
        </p>
        <select
          aria-label="Language"
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
          className="min-h-11 w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
        >
          {shippedLocales.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
        </select>
      </Section>
    </div>
  );
}

/* ── LLM Tab ── */

function LLMTab({ config, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, deleteKey, saveModel, onConfigReload }: any) {
  if (!config) return <div className="text-sm text-muted py-4"><Loader2 size={16} className="animate-spin inline mr-2" />Loading…</div>;
  return (
    <div className="space-y-6">
      <Section title="API Keys">
        <p className="text-[11px] text-muted mb-3">Keys stored in <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">~/.pi-science/config.json</code></p>
        <div className="space-y-2">
          {config.providers.map((p: Provider) => (
            <div key={p.id} className={cn("rounded-card border px-4 py-3", p.has_key ? "border-ok/40 bg-ok/5" : "border-border bg-surface")}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-medium text-text">{p.name}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted">{p.id}</span>
                </div>
                {p.has_key && <span className="flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok ring-1 ring-ok/30"><Check size={10} /> Connected</span>}
              </div>
              {p.has_key ? (
                <button onClick={() => deleteKey(p.id)} disabled={saving === p.id} className="rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10 flex items-center gap-1">
                  <Trash2 size={11} /> Remove
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-1 rounded-input border border-border bg-surface-2 px-3 py-1.5">
                    <input type={showKey[p.id] ? "text" : "password"} value={apiKeyInput[p.id] || ""} onChange={(e) => setApiKeyInput((prev: any) => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder={p.id === "anthropic" ? "sk-ant-..." : "sk-..."}
                      className="flex-1 bg-transparent text-[13px] text-text outline-none font-mono"
                      onKeyDown={(e) => { if (e.key === "Enter") saveKey(p.id); }} />
                    <button onClick={() => setShowKey((prev: any) => ({ ...prev, [p.id]: !prev[p.id] }))} className="text-muted hover:text-text">
                      {showKey[p.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                  <button onClick={() => saveKey(p.id)} disabled={!apiKeyInput[p.id]?.trim() || saving === p.id}
                    className="rounded-input bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-fg disabled:opacity-40 flex items-center gap-1">
                    {saving === p.id ? <Loader2 size={12} className="animate-spin" /> : <Key size={12} />} Save
                  </button>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {p.models.map((m: string) => (
                  <button key={m} onClick={() => saveModel(`${p.id}/${m}`)}
                    className={cn("rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
                      config.model === `${p.id}/${m}` ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "text-muted hover:bg-surface-2 hover:text-text")}>{m}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Default Model">
        <div className="rounded-card border border-border bg-surface px-4 py-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm text-text">{config.model}</span>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted ring-1 ring-border">Active</span>
          </div>
          <div>
            <span className="text-[11px] text-muted mb-1.5 block">Thinking Level</span>
            <div className="flex gap-1">
              {["off", "minimal", "low", "medium", "high", "max"].map((level) => (
                <button key={level} onClick={() => saveModel(config.model, level)}
                  className={cn("rounded-input px-2 py-1 text-[11px] font-medium transition-colors",
                    config.thinking === level ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-text")}>{level}</button>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <CustomApiSection providers={config.custom_providers || []} onConfigReload={onConfigReload} />
      <ModelEndpointSection />
    </div>
  );
}

function ModelEndpointSection() {
  type Endpoint = { endpoint_id: string; name: string; base_url: string; protocol: string; enabled: boolean; health: string; data_egress: string; error?: string | null };
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState("openai");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/endpoints");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Unable to load model endpoints");
    setEndpoints(data.endpoints || []);
  }, []);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [load]);

  const add = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    setError(null);
    const response = await fetch("/api/endpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), base_url: baseUrl.trim(), protocol, data_egress: "remote" }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setError(data.detail || "Unable to register endpoint"); return; }
    setName(""); setBaseUrl(""); await load();
  };

  const health = async (endpointId: string) => {
    await fetch(`/api/endpoints/${encodeURIComponent(endpointId)}/health`, { method: "POST" });
    await load();
  };

  const toggle = async (endpoint: Endpoint) => {
    await fetch(`/api/endpoints/${encodeURIComponent(endpoint.endpoint_id)}/enabled?enabled=${!endpoint.enabled}`, { method: "PUT" });
    await load();
  };

  return (
    <Section title="Managed Model Endpoints">
      <p className="mb-3 text-[11px] text-muted">Register a local or remote model service by URL. Credentials remain outside this catalog as secret references.</p>
      {error && <p className="mb-2 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Endpoint name" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none" />
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://host/v1" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
        <button type="button" onClick={() => void add()} className="rounded-input bg-accent px-3 py-2 text-[12px] font-medium text-accent-fg disabled:opacity-40" disabled={!name.trim() || !baseUrl.trim()}>Register</button>
      </div>
      <select value={protocol} onChange={(event) => setProtocol(event.target.value)} className="mt-2 rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none">
        <option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option><option value="native">Native HTTP</option>
      </select>
      <div className="mt-3 space-y-2">
        {endpoints.map((endpoint) => (
          <div key={endpoint.endpoint_id} className="flex items-center gap-3 border-t border-faint pt-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-text">{endpoint.name}<span className="ml-2 font-mono text-[10px] text-muted">{endpoint.base_url}</span></span>
            <span className={cn("text-[10px]", endpoint.health === "ready" ? "text-ok" : endpoint.health === "error" ? "text-error" : "text-muted")}>{endpoint.health}</span>
            <button type="button" onClick={() => void health(endpoint.endpoint_id)} className="rounded-input px-2 py-1 text-[10px] text-muted hover:bg-surface-2">Check</button>
            <button type="button" onClick={() => void toggle(endpoint)} className={cn("rounded-input px-2 py-1 text-[10px]", endpoint.enabled ? "bg-ok/15 text-ok" : "bg-surface-2 text-muted")}>{endpoint.enabled ? "On" : "Off"}</button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function CustomApiSection({ providers, onConfigReload }: { providers: CustomProvider[]; onConfigReload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [discovered, setDiscovered] = useState<CustomProvider | null>(null);
  const [busy, setBusy] = useState<"discover" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discover = async () => {
    if (!baseUrl.trim()) return;
    setBusy("discover");
    setError(null);
    try {
      const res = await fetch("/api/settings/custom-providers/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Custom API", base_url: baseUrl.trim(), api_key: apiKey, api }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Model discovery failed");
      setDiscovered(data.provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!discovered) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/settings/custom-providers/${encodeURIComponent(discovered.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: discovered.name,
          base_url: discovered.base_url,
          api_key: apiKey,
          api: discovered.api,
          models: discovered.models,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Could not save custom provider");
      setDiscovered(null);
      setName(""); setBaseUrl(""); setApiKey("");
      await onConfigReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/settings/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.detail || "Could not remove custom provider");
      return;
    }
    await onConfigReload();
  };

  return (
    <Section title="Custom API">
      <div className="rounded-card border border-border bg-surface px-4 py-4 space-y-3">
        <p className="text-[11px] text-muted">
          Fill in an OpenAI-compatible endpoint. Pi-Science calls <code className="font-mono">/models</code> and adds the discovered models to the model selector.
        </p>
        {error && <p className="rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Provider name (optional)" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none" />
          <select value={api} onChange={(e) => setApi(e.target.value)} className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none">
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
        </div>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className="w-full rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
        <div className="flex gap-2">
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" className="min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
          <button onClick={discover} disabled={!baseUrl.trim() || busy !== null} className="rounded-input bg-accent px-3 py-2 text-[12px] font-medium text-accent-fg disabled:opacity-40">
            {busy === "discover" ? "Discovering…" : "Discover models"}
          </button>
        </div>
        {discovered && (
          <div className="rounded-input border border-accent/30 bg-accent/5 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text">{discovered.name}</span>
              <button onClick={save} disabled={busy !== null} className="rounded-input bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg disabled:opacity-40">
                {busy === "save" ? "Saving…" : "Save provider"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted">{discovered.models.length} models discovered</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {discovered.models.map((model) => <span key={model} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text">{model}</span>)}
            </div>
          </div>
        )}
        {providers.map((provider) => (
          <div key={provider.id} className="flex items-start justify-between gap-3 border-t border-faint pt-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-medium text-text">
                <span className="truncate">{provider.name}</span>
                {provider.has_key && <span className="text-[10px] text-ok">key saved</span>}
              </div>
              <p className="truncate font-mono text-[10px] text-muted">{provider.base_url}</p>
              <p className="mt-1 text-[10px] text-muted">{provider.models.join(", ")}</p>
            </div>
            <button onClick={() => remove(provider.id)} className="shrink-0 rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10">Remove</button>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── Extensions Tab ── */

function ExtensionsTab() {
  const [extensions, setExtensions] = useState<Array<{
    id: string;
    name: string;
    description: string;
    installed: boolean;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/extensions")
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Unable to inspect runtime extensions");
        if (!cancelled) setExtensions(data.extensions || []);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6">
      <Section title="Installed Extensions">
        <p className="text-[11px] text-muted mb-3">
          Status reflects what the next Pi conversation process will actually load. Run <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">bash scripts/fetch-pi.sh</code> after installing or updating the runtime.
        </p>
        {error && <p role="alert" className="mb-3 text-xs text-error">{error}</p>}
        {extensions === null && !error && <p className="text-xs text-muted">Checking runtime…</p>}
        {extensions?.map((extension) => (
          <ExtCard
            key={extension.id}
            name={extension.name}
            pkg={extension.id}
            desc={extension.description}
            checked={extension.installed}
          />
        ))}
      </Section>
      <SkillSettings />
      <AgentProfilesSection />
    </div>
  );
}

function SkillSettings() {
  const [skills, setSkills] = useState<Array<{ name: string; source: string; enabled: boolean }>>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/skills");
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load skills");
      setSkills(data.skills || []);
      setConfigured(data.configured === true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (name: string, enabled: boolean) => {
    setSkills((current) => current.map((skill) => skill.name === name ? { ...skill, enabled } : skill));
    const response = await fetch("/api/settings/skills/toggle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    });
    if (!response.ok) {
      setError("Unable to update skill settings");
      await load();
    } else {
      setConfigured(true);
    }
  };

  const reset = async () => {
    const response = await fetch("/api/settings/skills", { method: "DELETE" });
    if (!response.ok) {
      setError("Unable to reset skill settings");
      return;
    }
    await load();
  };

  return (
    <Section title="Skills">
      <p className="mb-3 text-[11px] text-muted">
        Skills apply to newly started Pi processes. Existing conversations keep their current runtime until restarted.
      </p>
      {error && <p role="alert" className="mb-3 text-xs text-error">{error}</p>}
      {loading ? <p className="text-xs text-muted">Loading skills…</p> : (
        <>
          <div className="space-y-1">
            {skills.map((skill) => (
              <label key={`${skill.source}-${skill.name}`} className="flex items-center gap-3 rounded-input px-2 py-2 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onChange={(event) => void toggle(skill.name, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-text">{skill.name}</span>
                <span className="text-[10px] text-muted">{skill.source}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-faint pt-3">
            <span className="text-[10px] text-muted">{configured ? "Custom allowlist" : "Auto-discovery enabled"}</span>
            <button type="button" onClick={() => void reset()} className="rounded-input px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-text">
              Reset to auto-discover
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

function AgentProfilesSection() {
  type Profile = { name: string; display_name: string; description: string; read_scope: string[]; write_scope: string[]; source: string };
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/agent-profiles");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Unable to load agent profiles");
    setProfiles(data.profiles || []);
  }, []);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [load]);
  const create = async () => {
    const normalized = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!normalized || !displayName.trim()) return;
    const response = await fetch("/api/agent-profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: normalized, display_name: displayName.trim(), description: "User-created profile", read_scope: ["workspace"], write_scope: ["workspace-approved"] }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setError(data.detail || "Unable to create profile"); return; }
    setName(""); setDisplayName(""); await load();
  };
  return (
    <Section title="Agent Profiles">
      <p className="mb-3 text-[11px] text-muted">Profiles make identity, skills, connectors, and read/write scope explicit before a session uses them.</p>
      {error && <p className="mb-2 text-[11px] text-error">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="PROFILE_NAME" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Display name" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none" />
        <button type="button" onClick={() => void create()} className="rounded-input bg-accent px-3 py-2 text-[12px] font-medium text-accent-fg disabled:opacity-40" disabled={!name.trim() || !displayName.trim()}>Create</button>
      </div>
      <div className="mt-3 space-y-2">
        {profiles.map((profile) => <div key={profile.name} className="rounded-input border border-border bg-surface px-3 py-2"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium text-text">{profile.display_name}</span><span className="font-mono text-[10px] text-muted">{profile.name} · {profile.source}</span></div><p className="mt-1 text-[10px] text-muted">read: {profile.read_scope.join(", ") || "none"} · write: {profile.write_scope.join(", ") || "none"}</p></div>)}
      </div>
    </Section>
  );
}

function ExtCard({ name, pkg, desc, checked }: { name: string; pkg: string; desc: string; checked: boolean }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 mb-2">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <span className="text-sm font-medium text-text">{name}</span>
          <span className="ml-2 font-mono text-[10px] text-muted">{pkg}</span>
          <p className="text-[11px] text-muted mt-0.5">{desc}</p>
        </div>
        {checked ? (
          <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok ring-1 ring-ok/30"><Check size={10} className="inline mr-0.5" />Installed</span>
        ) : (
          <span className="rounded-full bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error ring-1 ring-error/20">Missing</span>
        )}
      </div>
    </div>
  );
}

/* ── MCP Tab ── */

function MCPTab() {
  interface McpServer {
    id: string; name: string; description: string; enabled: boolean; health: string;
    auth: string; data_egress: string; transport: string; tools: Array<{ name: string }>;
    terms_url?: string | null; privacy_url?: string | null; error?: string | null;
  }
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/mcp/catalog").then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to inspect MCP connectors");
      setServers(data.servers || []);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
  }, []);

  const toggle = async (id: string, on: boolean) => {
    const previous = servers.find((server) => server.id === id)?.enabled || false;
    setError(null);
    setServers((prev) => prev.map((server) => server.id === id ? { ...server, enabled: on } : server));
    const res = await fetch(`/api/settings/mcp/${id}?enabled=${on}`, { method: "PUT" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setServers((prev) => prev.map((server) => server.id === id ? { ...server, enabled: previous } : server));
      setError(data.detail || `Could not update MCP server: ${res.statusText}`);
    }
  };

  if (loading) return <div className="text-sm text-muted py-4"><Loader2 size={16} className="animate-spin inline mr-2" />Loading…</div>;

  return (
    <div className="space-y-6">
      <Section title="Science MCP Connectors">
        {error && <p className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
        <p className="text-[11px] text-muted mb-3">
          Connector metadata comes from the active MCP configuration. Review health, authentication, and data destination before sending project files.
        </p>
        {servers.length === 0 ? <p className="text-xs text-muted">No MCP servers configured.</p> : (
          <div className="space-y-2">
            {servers.map((server) => <McpRow key={server.id} server={server} onToggle={toggle} />)}
          </div>
        )}
      </Section>
    </div>
  );
}

function McpRow({ server, onToggle }: { server: { id: string; name: string; description: string; enabled: boolean; health: string; auth: string; data_egress: string; transport: string; tools: Array<{ name: string }>; terms_url?: string | null; privacy_url?: string | null; error?: string | null }; onToggle: (id: string, on: boolean) => void }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">{server.name}</span>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{server.transport}</span>
          </div>
          <p className="text-[11px] text-muted mt-0.5">{server.description || server.id}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <span className={cn("text-[10px]", server.health === "ready" ? "text-ok" : server.health === "error" ? "text-error" : "text-muted")}>Health: {server.health}</span>
            <span className={cn("text-[10px]", server.auth === "missing" ? "text-warn" : "text-muted")}>Auth: {server.auth}</span>
            <span className={cn("text-[10px]", server.data_egress === "remote" ? "text-warn" : "text-muted")}>Data: {server.data_egress}</span>
            <span className="text-[10px] text-muted">{server.tools.length} tools</span>
          </div>
          {server.error && <p className="mt-1 text-[10px] text-error">{server.error}</p>}
          {(server.terms_url || server.privacy_url) && <div className="mt-1 flex gap-2 text-[10px]">{server.terms_url && <a href={server.terms_url} target="_blank" className="text-link hover:underline">Terms</a>}{server.privacy_url && <a href={server.privacy_url} target="_blank" className="text-link hover:underline">Privacy</a>}</div>}
        </div>
        <button
          onClick={() => onToggle(server.id, !server.enabled)}
          className={cn(
            "shrink-0 rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
            server.enabled ? "bg-ok text-white" : "bg-surface-2 text-muted hover:bg-surface hover:text-text",
          )}
        >
          {server.enabled ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

/* ── Shared ── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">{title}</h2>
      {children}
    </section>
  );
}
