import { useEffect, useState, useCallback } from "react";
import { Key, Trash2, Eye, EyeOff, Check, Loader2, Cpu, Puzzle, FlaskConical, Server } from "lucide-react";
import { cn } from "../../lib/cn";

type Tab = "llm" | "extensions" | "mcp" | "compute";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "llm", label: "LLM", icon: <Cpu size={14} /> },
  { id: "extensions", label: "Extensions", icon: <Puzzle size={14} /> },
  { id: "mcp", label: "MCP", icon: <FlaskConical size={14} /> },
  { id: "compute", label: "Compute", icon: <Server size={14} /> },
];

interface Provider {
  id: string; name: string; models: string[]; has_key: boolean;
}

interface Config {
  api_keys: Record<string, boolean>; model: string; thinking: string; providers: Provider[];
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("llm");
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

        {tab === "llm" && <LLMTab config={config!} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} saveModel={saveModel} />}
        {tab === "extensions" && <ExtensionsTab />}
        {tab === "mcp" && <MCPTab />}
        {tab === "compute" && <ComputeTab />}
      </div>
    </div>
  );
}

/* ── LLM Tab ── */

function LLMTab({ config, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, deleteKey, saveModel }: any) {
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
    </div>
  );
}

/* ── Extensions Tab ── */

function ExtensionsTab() {
  return (
    <div className="space-y-6">
      <Section title="Installed Extensions">
        <p className="text-[11px] text-muted mb-3">
          Extensions loaded from the pi runtime. Install via <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">npm install</code> in the pi repo.
        </p>
        <ExtCard name="MCP Adapter" pkg="pi-mcp-adapter" desc="Bridges MCP servers into pi. One proxy tool for all servers with lazy loading and OAuth support." checked />
        <ExtCard name="Subagents" pkg="pi-subagents" desc="Delegate work to focused child agents: scout, researcher, planner, worker, reviewer, oracle." checked />
        <ExtCard name="Web Access" pkg="pi-web-access" desc="Web search, URL fetching, YouTube/video understanding. Multi-provider with smart fallbacks." checked />
        <ExtCard name="Context Mode" pkg="context-mode" desc="Sandboxed code execution (12 languages) + FTS5 knowledge index. Reduces context bloat by up to 98% in long scientific sessions. Auto-installs ctx_execute, ctx_search, ctx_index tools." checked />
      </Section>
    </div>
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
        {checked && <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok ring-1 ring-ok/30"><Check size={10} className="inline mr-0.5" />Installed</span>}
      </div>
    </div>
  );
}

/* ── MCP Tab ── */

function MCPTab() {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/mcp").then(r => r.json()).then(d => {
      const map: Record<string, boolean> = {};
      (d.servers || []).forEach((s: string) => { map[s] = true; });
      setEnabled(map);
    }).finally(() => setLoading(false));
  }, []);

  const toggle = async (id: string, on: boolean) => {
    setEnabled((prev) => ({ ...prev, [id]: on }));
    await fetch(`/api/settings/mcp/${id}?enabled=${on}`, { method: "PUT" });
  };

  if (loading) return <div className="text-sm text-muted py-4"><Loader2 size={16} className="animate-spin inline mr-2" />Loading…</div>;

  return (
    <div className="space-y-6">
      <Section title="Science MCP Connectors">
        <p className="text-[11px] text-muted mb-3">
          Open-source scientific MCP servers. Enable to give the agent access to literature databases, material properties, weather data, and more.
          Requires the MCP Adapter extension.
        </p>
        <div className="space-y-2">
          <McpRow id="paper-search" label="Literature Search" disc="all fields" desc="arXiv, PubMed, Crossref, Semantic Scholar, bioRxiv/medRxiv" src="github.com/openags/paper-search-mcp" keyEnv={null} enabled={!!enabled["paper-search"]} onToggle={toggle} />
          <McpRow id="biomcp" label="Biomedical Databases" disc="biology" desc="PubMed, ClinicalTrials.gov, genomic variants" src="github.com/genomoncology/biomcp" keyEnv={null} enabled={!!enabled["biomcp"]} onToggle={toggle} />
          <McpRow id="materials-project" label="Materials Project" disc="materials" desc="Material properties, crystal structures, phase diagrams" src="github.com/luffysolution-svg/mcp-materials-project" keyEnv="MP_API_KEY" enabled={!!enabled["materials-project"]} onToggle={toggle} />
          <McpRow id="fred" label="FRED Economic Data" disc="economics" desc="GDP, inflation, unemployment (Federal Reserve)" src="github.com/tosin2013/fred-mcp" keyEnv="FRED_API_KEY" enabled={!!enabled["fred"]} onToggle={toggle} />
          <McpRow id="open-meteo" label="Weather & Climate" disc="earth/climate" desc="Current & historical weather, air quality (free, no key)" src="github.com/isdaniel/mcp_weather_server" keyEnv={null} enabled={!!enabled["open-meteo"]} onToggle={toggle} />
        </div>
      </Section>
    </div>
  );
}

function McpRow({ id, label, disc, desc, src, keyEnv, enabled, onToggle }: {
  id: string; label: string; disc: string; desc: string; src: string; keyEnv: string | null; enabled: boolean; onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">{label}</span>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{disc}</span>
          </div>
          <p className="text-[11px] text-muted mt-0.5">{desc}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <a href={`https://${src}`} target="_blank" className="font-mono text-[10px] text-link hover:underline">{src}</a>
            {keyEnv && <span className="text-[10px] text-warn">Needs {keyEnv}</span>}
            {enabled && <span className="text-[10px] text-ok">Enabled</span>}
          </div>
        </div>
        <button
          onClick={() => onToggle(id, !enabled)}
          className={cn(
            "shrink-0 rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
            enabled ? "bg-ok text-white" : "bg-surface-2 text-muted hover:bg-surface hover:text-text",
          )}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

/* ── Compute Tab ── */

interface Machine {
  host: string; label: string; user: string; port: number; identity_file: string; scheduler: string;
}

function ComputeTab() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ host: "", label: "", user: "", port: 22, identity_file: "", scheduler: "" });
  const [adding, setAdding] = useState(false);
  const [probing, setProbing] = useState<Record<string, any>>({});
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/compute/machines");
      const d = await res.json();
      setMachines(d.machines || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!form.host.trim()) return;
    setAdding(true); setError("");
    try {
      await fetch("/api/compute/machines", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      setForm({ host: "", label: "", user: "", port: 22, identity_file: "", scheduler: "" });
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setAdding(false); }
  };

  const handleDelete = async (label: string) => {
    await fetch(`/api/compute/machines/${label}`, { method: "DELETE" });
    await load();
  };

  const handleProbe = async (machine: Machine) => {
    setProbing((p: any) => ({ ...p, [machine.label]: true }));
    try {
      const params = new URLSearchParams({ host: machine.host, user: machine.user, port: String(machine.port), identity_file: machine.identity_file });
      const res = await fetch(`/api/compute/probe?${params}`, { method: "POST" });
      const info = await res.json();
      setProbing((p: any) => ({ ...p, [machine.label]: info }));
    } catch (e) { console.error(e); }
    finally { setProbing((p: any) => ({ ...p, [machine.label]: false })); }
  };

  if (loading) return <div className="text-sm text-muted py-4">Loading…</div>;

  return (
    <div className="space-y-6">
      <Section title="Remote Machines">
        <p className="text-[11px] text-muted mb-3">
          Configure SSH servers, GPU boxes, or Slurm clusters for remote computation.
          Config is saved to <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">.pi-science/compute.json</code>.
        </p>

        {/* Add form */}
        <div className="rounded-card border border-border bg-surface p-4 mb-3">
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Label*" className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
            <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="Hostname*" className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none font-mono" />
            <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="User" className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <select value={form.scheduler} onChange={(e) => setForm({ ...form, scheduler: e.target.value })} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none">
              <option value="">Direct SSH</option>
              <option value="slurm">Slurm</option>
            </select>
            <button onClick={handleAdd} disabled={!form.host.trim() || adding}
              className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40">{adding ? "Adding…" : "Add Machine"}</button>
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </div>

        {/* Machine list */}
        {machines.length === 0 ? (
          <p className="text-[12px] text-muted/60 italic">No machines configured</p>
        ) : (
          machines.map((m) => (
            <div key={m.label} className="rounded-card border border-border bg-surface px-4 py-3 mb-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-text">{m.label}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted">{m.user}@{m.host}:{m.port}</span>
                  {m.scheduler && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-accent">{m.scheduler}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleProbe(m)} disabled={!!probing[m.label]}
                    className="rounded-input px-2 py-1 text-[11px] text-link hover:bg-surface-2">
                    {probing[m.label] === true ? <Loader2 size={12} className="animate-spin" /> : probing[m.label] ? "Probed" : "Probe"}
                  </button>
                  <button onClick={() => handleDelete(m.label)} className="rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {probing[m.label] && typeof probing[m.label] === "object" && (
                <div className="mt-2 rounded-input bg-surface-2 p-2 font-mono text-[10px] text-muted">
                  {probing[m.label].reachable
                    ? `Cores: ${probing[m.label].cores} · RAM: ${probing[m.label].memory} · GPUs: ${probing[m.label].gpus} · Slurm: ${probing[m.label].has_slurm ? "yes" : "no"}`
                    : `Error: ${probing[m.label].error || "unreachable"}`}
                </div>
              )}
            </div>
          ))
        )}
      </Section>
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
