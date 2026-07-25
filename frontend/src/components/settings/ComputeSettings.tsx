import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/api";

interface Machine {
  label: string;
  host: string;
  user: string;
  port: number;
  identity_file: string;
  scheduler: string;
}

interface ProbeResult {
  reachable?: boolean;
  cores?: number;
  memory?: string;
  gpus?: number;
  has_slurm?: boolean;
  error?: string;
}

const EMPTY_FORM = { host: "", label: "", user: "", port: 22, identity_file: "", scheduler: "" };

export function ComputeSettings() {
  const { t } = useTranslation();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [probing, setProbing] = useState<Record<string, true | ProbeResult>>({});
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiRequest<{ machines?: Machine[] }>("/api/compute/machines", { signal });
      setMachines(data.machines || []);
      setError("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleAdd = async () => {
    if (!form.host.trim()) return;
    setAdding(true);
    setError("");
    try {
      await apiRequest("/api/compute/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm(EMPTY_FORM);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (label: string) => {
    try {
      await apiRequest(`/api/compute/machines/${encodeURIComponent(label)}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleProbe = async (machine: Machine) => {
    setProbing((current) => ({ ...current, [machine.label]: true }));
    try {
      const params = new URLSearchParams({ host: machine.host, user: machine.user, port: String(machine.port), identity_file: machine.identity_file });
      const info = await apiRequest<ProbeResult>(`/api/compute/probe?${params}`, { method: "POST" });
      setProbing((current) => ({ ...current, [machine.label]: info }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setProbing((current) => ({ ...current, [machine.label]: { reachable: false, error: message } }));
      setError(message);
    }
  };

  if (loading) return <div className="py-4 text-sm text-muted">{t("common.loading")}</div>;

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{t("settings.computePage.title")}</h2>
      <p className="text-[11px] text-muted">
        {t("settings.computePage.description")} {t("settings.computePage.savedTo")} <code className="rounded bg-surface-2 px-1 font-mono text-[11px]">.pi-science/compute.json</code>.
      </p>
      <div className="rounded-card border border-border bg-surface p-4">
        <div className="mb-2 grid grid-cols-3 gap-2">
          <input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder={t("settings.computePage.label")} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
          <input value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder={t("settings.computePage.hostname")} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs text-text outline-none" />
          <input value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })} placeholder={t("settings.computePage.user")} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
        </div>
        <div className="flex items-center gap-2">
          <select value={form.scheduler} onChange={(event) => setForm({ ...form, scheduler: event.target.value })} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none">
            <option value="">{t("settings.computePage.directSsh")}</option>
            <option value="slurm">Slurm</option>
          </select>
          <button onClick={() => void handleAdd()} disabled={!form.host.trim() || adding} className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40">
            {adding ? t("settings.computePage.adding") : t("settings.computePage.add")}
          </button>
          {error && <span role="alert" className="text-xs text-error">{error}</span>}
        </div>
      </div>
      {machines.length === 0 ? (
        <p className="text-[12px] italic text-muted/60">{t("settings.computePage.empty")}</p>
      ) : machines.map((machine) => {
        const probe = probing[machine.label];
        return (
          <div key={machine.label} className="rounded-card border border-border bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-text">{machine.label}</span>
                <span className="ml-2 font-mono text-[11px] text-muted">{machine.user}@{machine.host}:{machine.port}</span>
                {machine.scheduler && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-accent">{machine.scheduler}</span>}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => void handleProbe(machine)} disabled={probe === true} className="rounded-input px-2 py-1 text-[11px] text-link hover:bg-surface-2">
                  {probe === true ? <Loader2 size={12} className="animate-spin" /> : probe ? t("settings.computePage.probed") : t("settings.computePage.probe")}
                </button>
                <button onClick={() => void handleDelete(machine.label)} className="rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10"><Trash2 size={12} /></button>
              </div>
            </div>
            {probe && probe !== true && <div className="mt-2 rounded-input bg-surface-2 p-2 font-mono text-[10px] text-muted">{probe.reachable ? `Cores: ${probe.cores} · RAM: ${probe.memory} · GPUs: ${probe.gpus} · Slurm: ${probe.has_slurm ? "yes" : "no"}` : `Error: ${probe.error || "unreachable"}`}</div>}
          </div>
        );
      })}
    </section>
  );
}
