import { useEffect, useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { apiRequest } from "../../lib/client/api";

interface EnvironmentRevision {
  environment_id: string;
  revision_id: string;
  display_name: string;
  language: "python" | "r";
  status: "creating" | "ready" | "failed" | "archived";
  packages: string[];
  failure?: { message: string };
}

interface Binding { revision_id?: string; display_name?: string; ready: boolean }

export function EnvironmentSettings({ workspaceCwd }: { workspaceCwd: string | null }) {
  const [environments, setEnvironments] = useState<EnvironmentRevision[]>([]);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const list = await apiRequest<{ environments: EnvironmentRevision[] }>("/api/environments");
    setEnvironments(list.environments);
    if (workspaceCwd) setBinding(await apiRequest<Binding>(`/api/environments/workspace?cwd=${encodeURIComponent(workspaceCwd)}`));
  };

  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [workspaceCwd]);

  const create = async () => {
    setBusy("create"); setError(null);
    try {
      await apiRequest("/api/environments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `analysis-${Date.now()}`, display_name: "Analysis", language: "python" }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const bind = async (revisionId: string) => {
    if (!workspaceCwd) return;
    setBusy(revisionId); setError(null);
    try {
      setBinding(await apiRequest<Binding>(`/api/environments/workspace?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision_id: revisionId }) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  return (
    <section className="py-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div><h2 className="text-sm font-medium text-text">Shared environments</h2><p className="mt-1 text-xs text-muted">Micromamba environments are reused across projects; each Session still gets an isolated Kernel.</p></div>
        <button type="button" onClick={() => void create()} disabled={busy !== null} className="flex h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-50">{busy === "create" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} New environment</button>
      </div>
      {error && <p role="alert" className="mb-3 rounded-input bg-error/10 px-3 py-2 text-xs text-error">{error}</p>}
      <div className="overflow-hidden rounded-card border border-faint">
        {environments.length === 0 ? <p className="p-4 text-xs text-muted">No shared environments yet. The Python Standard environment is created when first needed.</p> : environments.map((environment) => {
          const active = binding?.revision_id === environment.revision_id;
          return <div key={environment.revision_id} className="flex items-center gap-3 border-b border-faint p-3 last:border-b-0">
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm text-text">{environment.display_name}<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">{environment.language}</span></div><p className="mt-1 truncate font-mono text-[10px] text-muted">{environment.revision_id} · {environment.packages.join(" ")}</p>{environment.failure && <p className="mt-1 text-xs text-error">{environment.failure.message}</p>}</div>
            {active ? <span className="flex items-center gap-1 text-xs text-ok"><Check size={13} /> Active</span> : workspaceCwd && environment.status === "ready" ? <button type="button" disabled={busy !== null} onClick={() => void bind(environment.revision_id)} className="rounded-input border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-2 disabled:opacity-50">{busy === environment.revision_id ? "Switching…" : "Use"}</button> : <span className="text-xs text-muted">{environment.status}</span>}
          </div>;
        })}
      </div>
    </section>
  );
}
