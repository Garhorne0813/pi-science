import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Hand, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sessionApprovalSchema, approvalPreferencesSchema, type ApprovalMode } from "@pi-science/contracts";
import { request, responseError } from "../../lib/client/http";
import { useRuntimeStore } from "../../lib/agent-runtime";

export function ApprovalModeMenu({ cwd, sessionId, disabled }: { cwd: string; sessionId: string | null; disabled: boolean }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const [approval, setApproval] = useState<{ mode: ApprovalMode; revision: number }>({ mode: "ask", revision: 0 });
  const [loading, setLoading] = useState(true);
  const [defaultUnavailable, setDefaultUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const [error, setError] = useState("");
  const [resetKind, setResetKind] = useState<"runtime" | "kernel" | null>(null);
  const identity = `${cwd}\0${sessionId ?? ""}`;
  const latest = useRef(identity); latest.current = identity;
  const retryMode = useRef<ApprovalMode | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const labels = { ask: zh ? "请求批准" : "Ask for approval", auto: zh ? "帮我批准" : "Approve safe actions", full: zh ? "完全访问" : "Full access" };
  const descriptions = {
    ask: zh ? "新增网络权限和需要审批的工具调用时询问" : "Ask for new network permissions and approval-gated tools",
    auto: zh ? "工作区内执行和公网 HTTPS；仅自动批准明确标注为安全只读的工具" : "Workspace execution and public HTTPS; auto-approve explicitly safe read-only tools",
    full: zh ? "访问用户目录文件、公网 HTTPS，并自动批准工具；禁止规则仍生效" : "Access home-directory files and public HTTPS; auto-approve tools; denials still apply",
  };
  const icons = { ask: Hand, auto: ShieldCheck, full: ShieldAlert };
  const Icon = icons[approval.mode];
  // The trigger keeps its accessible name when the label is hidden on phones.
  const statusLabel = saving ? (zh ? "切换中…" : "Switching…") : loading ? (zh ? "加载模式…" : "Loading policy…") : defaultUnavailable ? (zh ? "选择审批模式" : "Choose approval mode") : labels[approval.mode];
  const triggerLabel = `${zh ? "审批模式" : "Approval mode"}: ${statusLabel}`;
  const endpoint = (id: string) => `/api/sessions/${encodeURIComponent(id)}/approval-mode?${new URLSearchParams({ cwd })}`;
  useEffect(() => {
    let cancelled = false;
    const draft = useRuntimeStore.getState().draftApproval;
    setApproval({ mode: !sessionId && draft?.cwd === cwd ? draft.approval.mode : "ask", revision: 0 }); setError(""); retryMode.current = null; setResetKind(null); setConfirmFull(false); setSaving(false); setDefaultUnavailable(false); setLoading(true);
    let refreshSequence = 0;
    const refresh = () => {
      const sequence = ++refreshSequence;
      if (!sessionId) {
        if (useRuntimeStore.getState().draftApproval?.cwd === cwd) { setLoading(false); return; }
        void request("/api/settings/approval").then(async (res) => {
          if (!res.ok) throw new Error(zh ? "无法读取默认审批模式，请明确选择模式。" : "Could not load the default approval mode. Choose a mode explicitly.");
          const parsedPreferences = approvalPreferencesSchema.safeParse(await res.json());
          if (!parsedPreferences.success) throw new Error(zh ? "默认审批配置无效，请明确选择模式。" : "Default approval settings are invalid. Choose a mode explicitly.");
          const preferences = parsedPreferences.data;
          const currentDraft = useRuntimeStore.getState().draftApproval;
          if (!cancelled && sequence === refreshSequence && currentDraft?.cwd !== cwd) {
            setApproval({ mode: preferences.defaultMode, revision: 0 }); setDefaultUnavailable(false); setError("");
          }
        }).catch((err) => { if (!cancelled && sequence === refreshSequence && useRuntimeStore.getState().draftApproval?.cwd !== cwd) { setDefaultUnavailable(true); setError(String(err.message ?? err)); } })
          .finally(() => { if (!cancelled && sequence === refreshSequence) setLoading(false); });
        return;
      }
      void request(endpoint(sessionId)).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(responseError(data, "Could not load approval mode"));
      const parsed = sessionApprovalSchema.parse(data);
      if (!cancelled) {
        setApproval((current) => current.revision > parsed.revision ? current : parsed);
        if (data.transitionPending === true) {
          retryMode.current = parsed.mode;
          setError(zh ? "审批变更尚未完成，请重试。" : "Approval transition is incomplete. Retry to finish revoking old permissions.");
        }
      }
    }).catch((err) => { if (!cancelled) setError(String(err.message ?? err)); })
      .finally(() => { if (!cancelled) setLoading(false); }); };
    refresh();
    const broadcast = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("pi-science-approval");
    channel.current = broadcast;
    if (broadcast) broadcast.onmessage = (event) => {
      if (!sessionId && event.data?.type === "approval.preferences.changed") refresh();
      if (sessionId && event.data?.cwd === cwd && event.data?.sessionId === sessionId) refresh();
    };
    const onApprovalChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.cwd === cwd && detail?.sessionId === sessionId) refresh();
    };
    window.addEventListener("pi-science-approval-mode-changed", onApprovalChanged);
    window.addEventListener("pi-science-approval-preferences-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.removeEventListener("pi-science-approval-preferences-changed", refresh); window.removeEventListener("pi-science-approval-mode-changed", onApprovalChanged); window.removeEventListener("focus", refresh); broadcast?.close(); if (channel.current === broadcast) channel.current = null; };
  // The endpoint is scoped exclusively by these two values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sessionId]);
  const change = async (mode: ApprovalMode) => {
    if (disabled || saving || loading) return;
    const initiatingIdentity = identity;
    retryMode.current = mode;
    setSaving(true); setError(""); setResetKind(null);
    try {
      if (!sessionId) {
        useRuntimeStore.setState({ draftApproval: { cwd, approval: { mode, acknowledgeFullAccess: mode === "full" } } });
        setApproval({ mode, revision: 0 }); setDefaultUnavailable(false);
        return;
      }
      const id = sessionId;
      const res = await request(endpoint(id), { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, revision: sessionId ? approval.revision : 0, acknowledgeFullAccess: mode === "full" }) });
      const data = await res.json();
      if (!res.ok) {
        const current = sessionApprovalSchema.safeParse(data.data);
        if (latest.current === initiatingIdentity && current.success) setApproval((previous) => previous.revision > current.data.revision ? previous : current.data);
        throw new Error(responseError(data, "Could not change approval mode"));
      }
      const parsed = sessionApprovalSchema.parse(data);
      channel.current?.postMessage({ type: "approval.mode.changed", cwd, sessionId: id, ...parsed });
      if (latest.current === initiatingIdentity) {
        setApproval((current) => current.revision > parsed.revision ? current : parsed);
        setResetKind(data.runtimeRestarted === true ? "runtime" : data.kernelRestartCount > 0 ? "kernel" : null);
      }
    } catch (err) { if (latest.current === initiatingIdentity) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (latest.current === initiatingIdentity) { setSaving(false); setConfirmFull(false); } }
  };
  return <>
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild><button type="button" aria-label={zh ? "审批模式" : "Approval mode"} title={triggerLabel} disabled={disabled || loading || saving}
        className={`flex min-h-7 min-w-7 shrink-0 items-center gap-1 rounded-input px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50 ${approval.mode === "full" ? "text-orange-500" : "text-muted"}`}>
        <Icon size={14} className="shrink-0" /><span className="truncate max-lg:hidden">{statusLabel}</span>
      </button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content onCloseAutoFocus={(event) => { if (confirmFull) event.preventDefault(); }} side="top" align="start" sideOffset={8} className="ui-popover z-[90] w-80 max-w-[calc(100vw-24px)] rounded-card p-1.5 text-text">
        <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">{zh ? "当前会话的审批方式" : "Approval policy for this conversation"}</DropdownMenu.Label>
        {(["ask", "auto", "full"] as const).map((mode) => { const ItemIcon = icons[mode]; return <DropdownMenu.Item key={mode}
          onSelect={() => { if (mode !== approval.mode || defaultUnavailable) { if (mode === "full") setConfirmFull(true); else void change(mode); } }}
          className={`flex cursor-default items-start gap-2 rounded-input p-2 outline-none data-[highlighted]:bg-surface-2 ${mode === "full" ? "text-orange-500" : ""}`}>
          <ItemIcon size={16} className="mt-0.5 shrink-0" /><div className="flex-1"><div className="text-sm">{labels[mode]}</div><div className="mt-0.5 text-xs opacity-75">{descriptions[mode]}</div></div>{approval.mode === mode && <Check size={15} className="mt-1 shrink-0" />}
        </DropdownMenu.Item>; })}
        <div className="px-2 py-1.5 text-[11px] text-muted">{zh ? "新模式用于之后的工具调用；需要撤销权限或重绑内核时会重置运行环境。任务进行中不可切换。" : "New calls use the selected policy. Revoking permissions or rebinding kernels may reset the runtime. Stop active tasks first."}</div>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {resetKind && <span role="status" className="max-w-60 text-xs text-muted">{resetKind === "runtime" ? (zh ? "已重置运行环境以重新绑定权限，内核变量已清除。" : "Runtime reset to rebind permissions; kernel variables were cleared.") : (zh ? "已回收旧权限内核，内核变量已清除；会话运行环境保持连接。" : "Old kernel permissions were revoked; kernel variables were cleared. The conversation runtime remains connected.")}</span>}
    {error && <span role="alert" className="max-w-60 text-xs text-error-text">{error}{retryMode.current && <button type="button" disabled={saving || disabled} className="ml-2 min-h-7 text-link" onClick={() => void change(retryMode.current!)}>{zh ? "重试" : "Retry"}</button>}</span>}
    <Dialog.Root open={confirmFull} onOpenChange={setConfirmFull}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
      <Dialog.Content className="ui-popover fixed left-1/2 top-1/2 z-[101] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-card p-5 text-text">
        <Dialog.Title className="text-base font-medium">{zh ? "启用此会话的完全访问？" : "Enable full access for this conversation?"}</Dialog.Title>
        <Dialog.Description className="mt-3 text-sm text-muted">{zh ? "智能体将能够读取和修改用户目录内的文件、访问公网 HTTPS，并自动批准当前会话的工具调用。已有禁止规则、应用私有数据和受限子任务边界仍保留。需要重新绑定内核权限时会重置运行环境。仅在信任本次任务时启用。" : "The agent can read and modify home-directory files, use public HTTPS, and automatically approve this conversation’s tools. Existing denials, private application data and confined-task boundaries remain protected. Rebinding kernel permissions may reset the runtime. Enable only for tasks you trust."}</Dialog.Description>
        <div className="mt-5 flex justify-end gap-3"><Dialog.Close asChild><button type="button" className="rounded-input px-3 py-1.5 text-sm">{zh ? "取消" : "Cancel"}</button></Dialog.Close><button type="button" disabled={saving || disabled} onClick={() => void change("full")} className="rounded-input bg-orange-600 px-3 py-1.5 text-sm text-white">{zh ? "启用完全访问" : "Enable full access"}</button></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </>;
}
