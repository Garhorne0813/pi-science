import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { readLastConversation } from "../../lib/conversation/last-conversation";

export function BackToConversationLink() {
  const { t } = useTranslation();
  const { cwd = "" } = useParams<{ cwd: string }>();
  const location = useLocation();
  const runtimeSessionId = useRuntimeStore(state => state.cwd === cwd ? state.activeSessionId : null);
  const querySessionId = new URLSearchParams(location.search).get("session_id");
  const sessionId = querySessionId || runtimeSessionId || readLastConversation(cwd);
  const root = `/workspace/${encodeURIComponent(cwd)}`;
  const to = sessionId ? `${root}/session/${encodeURIComponent(sessionId)}` : root;
  return <Link to={to} className="mb-2 inline-flex min-h-8 items-center gap-1.5 rounded-input pr-2 text-sm font-medium text-accent hover:bg-surface-2"><ArrowLeft size={15} />{t("conversation.backToConversation")}</Link>;
}

export function WorkspacePage({ children, className, contentClassName }: { children: ReactNode; className?: string; contentClassName?: string }) {
  return (
    <div className={cn("h-full overflow-y-auto bg-bg [scrollbar-gutter:stable]", className)}>
      <div className={cn("mx-auto w-full max-w-[1120px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8", contentClassName)}>
        {children}
      </div>
    </div>
  );
}

export function WorkspacePageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <BackToConversationLink />
        <h1 className="text-2xl font-medium tracking-tight text-text sm:text-[28px]">{title}</h1>
        {description && <div className="mt-1 max-w-[680px] text-sm leading-6 text-muted md:overflow-hidden md:text-ellipsis md:whitespace-nowrap">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function WorkspacePageRefreshButton({
  label,
  loading = false,
  onClick,
}: {
  label: string;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
    </button>
  );
}
