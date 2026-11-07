import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { approvalPreferencesSchema } from "@pi-science/contracts";
import { request, responseError } from "../../../lib/client/http";
import { SettingsSelectMenu } from "../SettingsSelectMenu";

type Metrics = { samples: number; transitions: Array<{ transition: string; count: number; failures: number; p95_ms: number | null; worker_restarts: number; kernel_restarts: number }> };
export function ApprovalPreferences() {
  const { i18n, t } = useTranslation(); const zh = i18n.language.startsWith("zh");
  const [mode, setMode] = useState<"ask" | "auto">("ask");
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""); const [metrics, setMetrics] = useState<Metrics | null>(null);
  useEffect(() => {
    let cancelled = false;
    void request("/api/settings/approval").then(async (res) => {
      const data = await res.json(); if (!res.ok) throw new Error(responseError(data, "Unable to load approval preferences"));
      const parsed = approvalPreferencesSchema.parse(data); if (!cancelled) setMode(parsed.defaultMode);
    }).catch((err) => { if (!cancelled) setError(String(err.message ?? err)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const refreshMetrics = async () => {
    try {
      const res = await request("/api/settings/approval-metrics");
      if (!res.ok) throw new Error("Unable to load approval metrics");
      setMetrics(await res.json()); setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const save = async (next: string) => {
    setSaving(true); setError("");
    try {
      const res = await request("/api/settings/approval", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ defaultMode: next }) });
      const data = await res.json(); if (!res.ok) throw new Error(responseError(data, "Unable to save approval preferences"));
      setMode(approvalPreferencesSchema.parse(data).defaultMode);
      window.dispatchEvent(new Event("pi-science-approval-preferences-changed"));
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("pi-science-approval"); channel.postMessage({ type: "approval.preferences.changed" }); channel.close();
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setSaving(false); }
  };
  const title = zh ? "新对话默认审批模式" : "Default approval for new conversations";
  return <section aria-label={title} className="space-y-3">
    <h3 className="text-ui-body font-medium text-text">{title}</h3>
    <p className="text-ui-caption text-muted">{zh ? "仅影响之后创建的对话。已有会话和当前草稿的明确选择保持各自的模式。完全访问需在每个会话单独确认。" : "Applies to future conversations. Existing sessions and explicit draft choices keep their own policy. Full access requires confirmation for each conversation."}</p>
    {loading ? <p role="status">{zh ? "加载中…" : "Loading…"}</p> : <SettingsSelectMenu ariaLabel={title} value={mode} disabled={saving} options={[
      { value: "ask", label: zh ? "请求批准" : "Ask for approval" }, { value: "auto", label: zh ? "帮我批准" : "Approve safe actions" },
    ]} onSelect={(next) => void save(next)} />}
    <p role="status" className="text-ui-caption text-muted">{t(saving ? "common.saving" : "settings.consistency.autoSave")}</p>
    {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}
    <details className="text-ui-caption text-muted"><summary>{zh ? "审批切换性能" : "Approval switch performance"}</summary>
      <p className="my-2">{zh ? "当前服务进程最近 1000 次切换，按方向统计；P95 只计算成功请求。" : "Last 1,000 changes in this server process, grouped by direction. P95 includes successful requests."}</p>
      <button type="button" onClick={() => void refreshMetrics()} className="min-h-9 text-link">{zh ? "刷新统计" : "Refresh metrics"}</button>
      {metrics && <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>{[zh ? "切换" : "Transition", "P95 (ms)", zh ? "次数 / 失败" : "Changes / failures", zh ? "Worker / 内核重置" : "Worker / kernel resets"].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{metrics.transitions.map((row) => <tr key={row.transition}><td className="p-2">{row.transition}</td><td className="p-2">{row.p95_ms?.toFixed(1) ?? "—"}</td><td className="p-2">{row.count} / {row.failures}</td><td className="p-2">{row.worker_restarts} / {row.kernel_restarts}</td></tr>)}</tbody></table>{metrics.samples === 0 && <p>{zh ? "暂无切换记录" : "No changes recorded"}</p>}</div>}
    </details>
  </section>;
}
