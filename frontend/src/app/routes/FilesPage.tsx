import { useTranslation } from "react-i18next";
import { ArrowRight, Link2, Trash2 } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";

import { WorkspacePage, WorkspacePageHeader } from "../../components/layout/WorkspacePage";
import { FileBrowser } from "../../components/sidebar/FileBrowser";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { getClient, getSessionName } from "../../lib/client/pi-science-client";
import { readLastConversation } from "../../lib/conversation/last-conversation";
import { useUiStore } from "../../lib/ui";

export function FilesPage() {
  const { t } = useTranslation();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const [searchParams] = useSearchParams();
  const fileType = searchParams.get("type") === "notebook"
    ? "notebook"
    : "all";
  const runtimeSessionId = useRuntimeStore((state) => state.cwd === workspaceCwd ? state.activeSessionId : null);
  const sessions = useRuntimeStore((state) => state.sessions);
  const querySessionId = searchParams.get("session_id");
  const targetsNewConversation = searchParams.get("conversation") === "new";
  const conversationKey = targetsNewConversation ? null : querySessionId || runtimeSessionId || readLastConversation(workspaceCwd);
  const allReferences = useUiStore((state) => state.workspaceReferences);
  const references = allReferences.filter((reference) => reference.cwd === workspaceCwd && reference.conversationKey === conversationKey);
  const clearWorkspaceReferences = useUiStore((state) => state.clearWorkspaceReferences);
  const session = conversationKey ? sessions.find((item) => item.id === conversationKey) : null;
  const [resolvedConversationName, setResolvedConversationName] = useState("");
  useEffect(() => {
    setResolvedConversationName("");
    if (!conversationKey || session?.name) return;
    let cancelled = false;
    void getClient().listSessions(workspaceCwd).then((items) => {
      const match = items.find((item) => item.id === conversationKey);
      if (!cancelled && match?.name) setResolvedConversationName(match.name);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [conversationKey, session?.name, workspaceCwd]);
  const conversationLabel = conversationKey
    ? session?.name || resolvedConversationName || getSessionName(workspaceCwd, conversationKey) || conversationKey.slice(0, 8)
    : t("files.newConversationTarget");
  const workspaceRoot = `/workspace/${encodeURIComponent(workspaceCwd)}`;
  const conversationHref = conversationKey ? `${workspaceRoot}/session/${encodeURIComponent(conversationKey)}` : `${workspaceRoot}/new`;

  return (
    <WorkspacePage
      className="overflow-hidden"
      contentClassName="flex h-full max-w-none flex-col px-4 py-4 sm:px-6 lg:px-6 lg:py-5"
    >
      <WorkspacePageHeader
        title={t("nav.files")}
        description={t("files.pageDescription")}
      />
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
        <FileBrowser cwd={workspaceCwd} embedded mode="page" fileType={fileType} conversationKey={conversationKey} />
        {references.length > 0 && <div role="status" className="mt-3 flex shrink-0 flex-wrap items-center gap-3 rounded-card border border-accent/25 bg-accent/5 px-3 py-2.5 shadow-sm">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"><Link2 size={15} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text">{t("files.pendingReferences", { count: references.length })}</div>
            <div className="truncate text-[11px] text-muted">{t("files.referenceTarget", { conversation: conversationLabel })}</div>
          </div>
          <button type="button" onClick={() => clearWorkspaceReferences(workspaceCwd, conversationKey)} className="inline-flex min-h-8 items-center gap-1.5 rounded-input px-2 text-xs text-muted hover:bg-surface-hover hover:text-error-text"><Trash2 size={13} />{t("files.clearReferences")}</button>
          <Link to={conversationHref} className="inline-flex min-h-8 items-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg hover:opacity-90">{t("files.returnToConversation")}<ArrowRight size={13} /></Link>
        </div>}
      </div>
    </WorkspacePage>
  );
}
