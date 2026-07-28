import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  Server,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/api";
import { cn } from "../../lib/cn";
import { queryClient } from "../../lib/query-client";

type AuthMethod = "key" | "password";

interface Machine {
  label: string;
  host: string;
  user: string;
  port: number;
  identity_file: string;
  scheduler: string;
  auth_method?: AuthMethod;
}

interface ProbeResult {
  reachable?: boolean;
  hostname?: string;
  os?: string;
  cores?: number;
  memory?: string;
  gpus?: number;
  has_slurm?: boolean;
  error?: string;
}

interface ComputeForm extends Machine {
  auth_method: AuthMethod;
  password: string;
}

interface ComputeSettingsProps {
  workspaceCwd: string | null;
}

const EMPTY_FORM: ComputeForm = {
  host: "",
  label: "",
  user: "",
  port: 22,
  identity_file: "~/.ssh/id_rsa",
  scheduler: "",
  auth_method: "key",
  password: "",
};

const fieldClass = "min-h-11 w-full rounded-input border border-border bg-surface-2 px-3 text-xs text-text outline-none transition-colors placeholder:text-muted/60 focus:border-accent focus:ring-1 focus:ring-accent/25";

function ProbeDetails({ result }: { result: ProbeResult }) {
  const { t } = useTranslation();
  if (!result.reachable) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-input border border-error/20 bg-error/5 px-3 py-2.5 text-xs text-error" role="status">
        <AlertCircle size={15} className="mt-0.5 shrink-0" />
        <span>{result.error || t("settings.computePage.unreachable")}</span>
      </div>
    );
  }

  const details = [
    [t("settings.computePage.remoteHostname"), result.hostname || "—"],
    [t("settings.computePage.os"), result.os || "—"],
    [t("settings.computePage.cores"), result.cores ?? "—"],
    [t("settings.computePage.memory"), result.memory || "—"],
    [t("settings.computePage.gpus"), result.gpus ?? "—"],
    ["Slurm", result.has_slurm ? t("settings.computePage.yes") : t("settings.computePage.no")],
  ];

  return (
    <div className="mt-3 rounded-input border border-success/20 bg-success/5 p-3" role="status">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-success">
        <CheckCircle2 size={15} />
        {t("settings.computePage.reachable")}
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3">
        {details.map(([label, value]) => (
          <div key={String(label)} className="min-w-0">
            <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
            <dd className="mt-0.5 truncate font-mono text-[11px] text-text" title={String(value)}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ComputeSettings({ workspaceCwd }: ComputeSettingsProps) {
  const { t } = useTranslation();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ComputeForm>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [draftProbe, setDraftProbe] = useState<true | ProbeResult>();
  const [probing, setProbing] = useState<Record<string, true | ProbeResult>>({});
  const [savedPasswords, setSavedPasswords] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");

  const computeCwd = workspaceCwd || ".";
  const workspaceQuery = `?cwd=${encodeURIComponent(computeCwd)}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await queryClient.fetchQuery({
        queryKey: ["compute", "machines", computeCwd],
        queryFn: () => apiRequest<{ machines?: Machine[] }>(`/api/compute/machines?cwd=${encodeURIComponent(computeCwd)}`),
        staleTime: 0,
      });
      if (signal?.aborted) return;
      setMachines(data.machines || []);
      setError("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [computeCwd]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const probe = async (input: Machine & { password?: string }): Promise<ProbeResult> => apiRequest<ProbeResult>(`/api/compute/probe${workspaceQuery}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const handleAdd = async () => {
    if (!form.host.trim()) return;
    setAdding(true);
    setError("");
    try {
      const { password: _password, ...machine } = form;
      await apiRequest(`/api/compute/machines${workspaceQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(machine),
      });
      setForm(EMPTY_FORM);
      setDraftProbe(undefined);
      await queryClient.invalidateQueries({ queryKey: ["compute", "machines", computeCwd] });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const handleDraftProbe = async () => {
    if (!form.host.trim()) return;
    setDraftProbe(true);
    setError("");
    try {
      setDraftProbe(await probe(form));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setDraftProbe({ reachable: false, error: message });
    }
  };

  const handleDelete = async (label: string) => {
    try {
      await apiRequest(`/api/compute/machines/${encodeURIComponent(label)}${workspaceQuery}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["compute", "machines", computeCwd] });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleProbe = async (machine: Machine) => {
    setProbing((current) => ({ ...current, [machine.label]: true }));
    try {
      const info = await probe({ ...machine, password: machine.auth_method === "password" ? savedPasswords[machine.label] : undefined });
      setProbing((current) => ({ ...current, [machine.label]: info }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setProbing((current) => ({ ...current, [machine.label]: { reachable: false, error: message } }));
    }
  };

  if (loading) return <div className="py-4 text-sm text-muted">{t("common.loading")}</div>;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{t("settings.computePage.title")}</h2>
        <p className="mt-1 text-[11px] leading-5 text-muted">
          {t("settings.computePage.description")} {t("settings.computePage.savedTo")} <code className="rounded bg-surface-2 px-1 font-mono text-[11px]">.pi-science/compute.json</code>.
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="mb-4 flex items-center gap-2">
          <Server size={16} className="text-accent" />
          <h3 className="text-sm font-medium text-text">{t("settings.computePage.connection")}</h3>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-[11px] font-medium text-muted">
            <span>{t("settings.computePage.label")}</span>
            <input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder={t("settings.computePage.labelPlaceholder")} className={fieldClass} />
          </label>
          <label className="space-y-1.5 text-[11px] font-medium text-muted">
            <span>{t("settings.computePage.hostname")}</span>
            <input value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="compute.example.org" className={cn(fieldClass, "font-mono")} />
          </label>
          <label className="space-y-1.5 text-[11px] font-medium text-muted">
            <span>{t("settings.computePage.user")}</span>
            <input value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })} placeholder={t("settings.computePage.userPlaceholder")} className={fieldClass} />
          </label>
          <label className="space-y-1.5 text-[11px] font-medium text-muted">
            <span>{t("settings.computePage.port")}</span>
            <input type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} className={cn(fieldClass, "font-mono")} />
          </label>
          <label className="space-y-1.5 text-[11px] font-medium text-muted">
            <span>{t("settings.computePage.scheduler")}</span>
            <select value={form.scheduler} onChange={(event) => setForm({ ...form, scheduler: event.target.value })} className={fieldClass}>
              <option value="">{t("settings.computePage.directSsh")}</option>
              <option value="slurm">Slurm</option>
            </select>
          </label>
          <fieldset className="space-y-1.5">
            <legend className="text-[11px] font-medium text-muted">{t("settings.computePage.authMethod")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["key", "password"] as const).map((method) => (
                <button key={method} type="button" onClick={() => setForm({ ...form, auth_method: method })} aria-pressed={form.auth_method === method} className={cn("flex min-h-11 items-center justify-center gap-2 rounded-input border px-3 text-xs transition-colors", form.auth_method === method ? "border-accent bg-accent/10 text-text" : "border-border bg-surface-2 text-muted hover:text-text")}>
                  {method === "key" ? <KeyRound size={14} /> : <LockKeyhole size={14} />}
                  {t(`settings.computePage.${method === "key" ? "sshKey" : "password"}`)}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="mt-3">
          {form.auth_method === "key" ? (
            <label className="space-y-1.5 text-[11px] font-medium text-muted">
              <span>{t("settings.computePage.identityFile")}</span>
              <input value={form.identity_file} onChange={(event) => setForm({ ...form, identity_file: event.target.value })} className={cn(fieldClass, "font-mono")} />
            </label>
          ) : (
            <label className="space-y-1.5 text-[11px] font-medium text-muted">
              <span>{t("settings.computePage.password")}</span>
              <span className="relative block">
                <input type={showPassword.draft ? "text" : "password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} className={cn(fieldClass, "pr-11")} autoComplete="new-password" />
                <button type="button" onClick={() => setShowPassword((current) => ({ ...current, draft: !current.draft }))} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted hover:text-text" aria-label={t("settings.computePage.togglePassword")}>
                  {showPassword.draft ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </span>
              <span className="block font-normal leading-4 text-muted/75">{t("settings.computePage.passwordNotSaved")}</span>
            </label>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <button type="button" onClick={() => void handleDraftProbe()} disabled={!form.host.trim() || draftProbe === true || (form.auth_method === "password" && !form.password)} className="flex min-h-11 items-center gap-2 rounded-input border border-border bg-surface-2 px-4 text-xs font-medium text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-40">
            {draftProbe === true ? <Loader2 size={14} className="animate-spin" /> : <Cpu size={14} />}
            {draftProbe === true ? t("settings.computePage.testing") : t("settings.computePage.testConnection")}
          </button>
          <button type="button" onClick={() => void handleAdd()} disabled={!form.host.trim() || adding} className="min-h-11 rounded-input bg-accent px-4 text-xs font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40">
            {adding ? t("settings.computePage.adding") : t("settings.computePage.add")}
          </button>
        </div>
        {draftProbe && draftProbe !== true && <ProbeDetails result={draftProbe} />}
        {error && <p role="alert" className="mt-3 text-xs text-error">{error}</p>}
      </div>

      {machines.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-xs text-muted">{t("settings.computePage.empty")}</p>
      ) : machines.map((machine) => {
        const result = probing[machine.label];
        const passwordAuth = machine.auth_method === "password";
        return (
          <article key={machine.label} className="rounded-card border border-border bg-surface px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">{machine.label}</span>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{passwordAuth ? t("settings.computePage.password") : t("settings.computePage.sshKey")}</span>
                  {machine.scheduler && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-accent">{machine.scheduler}</span>}
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-muted">{machine.user ? `${machine.user}@` : ""}{machine.host}:{machine.port}</p>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => void handleProbe(machine)} disabled={result === true || (passwordAuth && !savedPasswords[machine.label])} className="flex min-h-11 items-center gap-1.5 rounded-input px-3 text-[11px] text-link hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40">
                  {result === true ? <Loader2 size={13} className="animate-spin" /> : <Server size={13} />}
                  {result === true ? t("settings.computePage.testing") : t("settings.computePage.testConnection")}
                </button>
                <button type="button" onClick={() => void handleDelete(machine.label)} className="flex min-h-11 min-w-11 items-center justify-center rounded-input text-error hover:bg-error/10" aria-label={t("common.delete")}><Trash2 size={14} /></button>
              </div>
            </div>

            {passwordAuth && (
              <label className="mt-3 block space-y-1.5 text-[11px] font-medium text-muted">
                <span>{t("settings.computePage.passwordForProbe")}</span>
                <span className="relative block max-w-sm">
                  <input type={showPassword[machine.label] ? "text" : "password"} value={savedPasswords[machine.label] || ""} onChange={(event) => setSavedPasswords((current) => ({ ...current, [machine.label]: event.target.value }))} className={cn(fieldClass, "pr-11")} autoComplete="off" />
                  <button type="button" onClick={() => setShowPassword((current) => ({ ...current, [machine.label]: !current[machine.label] }))} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted hover:text-text" aria-label={t("settings.computePage.togglePassword")}>
                    {showPassword[machine.label] ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </span>
                <span className="block font-normal text-muted/75">{t("settings.computePage.passwordNotSaved")}</span>
              </label>
            )}
            {result && result !== true && <ProbeDetails result={result} />}
          </article>
        );
      })}
    </section>
  );
}
