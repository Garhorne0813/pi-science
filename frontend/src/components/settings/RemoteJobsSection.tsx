/** Remote jobs section for Compute settings (reverse-cs-inspiration 4.5):
 * submit a job to a configured machine, list jobs, refresh status, cancel,
 * and harvest outputs into the workspace as artifacts. */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, RefreshCw, X, Download, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { cn } from "../../lib/ui";

export interface RemoteJob {
  job_id: string;
  machine_label: string;
  host: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  remote_pid: string | null;
  output_glob: string;
  created_at: string;
  exit_code: number | null;
  artifact_ids: string[];
}

interface RemoteJobsSectionProps {
  workspaceCwd: string | null;
  machineLabels: string[];
}

export function RemoteJobsSection({ workspaceCwd, machineLabels }: RemoteJobsSectionProps) {
  const { t } = useTranslation();
  const [command, setCommand] = useState("");
  const [machine, setMachine] = useState("");
  const [outputGlob, setOutputGlob] = useState("*");
  const [jobs, setJobs] = useState<RemoteJob[]>([]);
  const [loading, setLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyJob, setBusyJob] = useState<string | null>(null);

  useEffect(() => {
    if (machineLabels.length > 0 && !machine) setMachine(machineLabels[0]!);
  }, [machineLabels, machine]);

  const load = useCallback(async () => {
    if (!workspaceCwd) return;
    setLoading(true);
    try {
      const data = await apiRequest<{ jobs?: RemoteJob[] }>(`/api/compute/jobs?cwd=${encodeURIComponent(workspaceCwd)}`);
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [workspaceCwd]);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (!workspaceCwd || !command.trim() || !machine) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest(`/api/compute/run?cwd=${encodeURIComponent(workspaceCwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine_label: machine, command: command.trim().split(/\s+/), output_glob: outputGlob.trim() || undefined }),
      });
      setCommand("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (jobId: string, action: string) => {
    if (!workspaceCwd) return;
    setBusyJob(jobId);
    setError(null);
    try {
      await apiRequest(`/api/compute/jobs/${jobId}/${action}?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "POST" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${action} failed`);
    } finally {
      setBusyJob(null);
    }
  };

  if (machineLabels.length === 0) return null;

  return (
    <section className="mt-6">
      <h3 className="mb-3 text-sm font-semibold">{t("settings.computePage.jobsTitle")}</h3>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={machine} onChange={(event) => setMachine(event.target.value)} className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs">
          {machineLabels.map((label) => <option key={label} value={label}>{label}</option>)}
        </select>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("settings.computePage.commandPlaceholder")} className="min-w-[260px] flex-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs" />
        <input value={outputGlob} onChange={(event) => setOutputGlob(event.target.value)} title={t("settings.computePage.outputGlobTitle")} className="w-28 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs" />
        <button onClick={submit} disabled={submitting || !command.trim()} className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2.5 py-1 text-xs text-accent hover:bg-accent/25 disabled:opacity-50">
          {submitting ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          {t("settings.computePage.submitJob")}
        </button>
        <button onClick={() => void load()} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2.5 py-1 text-xs text-muted" title={t("common.refresh")}>
          <RefreshCw size={11} />
        </button>
      </div>
      {error && <div className="mb-2 text-xs text-error">{error}</div>}
      <div className="flex flex-col gap-1.5">
        {loading && <div className="py-4 text-center text-xs text-muted"><Loader2 size={14} className="mx-auto mb-1 animate-spin" /></div>}
        {!loading && jobs.length === 0 && <div className="py-4 text-center text-xs text-muted">{t("settings.computePage.noJobs")}</div>}
        {jobs.map((job) => (
          <div key={job.job_id} className="rounded-md border border-border bg-surface-1/50 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <button onClick={() => setExpanded((p) => ({ ...p, [job.job_id]: !p[job.job_id] }))} className="flex items-center gap-1 text-left">
                {expanded[job.job_id] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="font-mono">{job.job_id.slice(0, 8)}</span>
              </button>
              <span className={cn("rounded px-1.5 py-px text-[10px]", statusTone(job.status))}>{job.status}</span>
              <span className="truncate text-muted">{job.host} · {job.output_glob}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {(job.status === "running" || job.status === "pending") && (
                  <button onClick={() => void act(job.job_id, "cancel")} disabled={busyJob === job.job_id} className="rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted hover:bg-warn/15 hover:text-warn">
                    <X size={10} />
                  </button>
                )}
                {(job.status === "succeeded" || job.status === "failed") && (
                  <button onClick={() => void act(job.job_id, "harvest")} disabled={busyJob === job.job_id} className="rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted hover:bg-accent/15 hover:text-accent" title={t("settings.computePage.harvest")}>
                    <Download size={10} />
                  </button>
                )}
                {busyJob === job.job_id && <Loader2 size={10} className="animate-spin text-muted" />}
              </span>
            </div>
            {expanded[job.job_id] && (
              <div className="mt-1.5 border-t border-border pt-1.5 text-[10px] text-muted">
                <div>pid: {job.remote_pid ?? "—"} · created: {job.created_at} · artifacts: {job.artifact_ids.length}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function statusTone(status: RemoteJob["status"]): string {
  switch (status) {
    case "running": return "bg-accent/15 text-accent";
    case "succeeded": return "bg-ok/15 text-ok";
    case "failed": return "bg-warn/15 text-warn";
    case "cancelled": return "bg-surface-2 text-muted";
    default: return "bg-surface-2 text-muted";
  }
}
