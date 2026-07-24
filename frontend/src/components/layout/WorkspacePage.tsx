import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import { cn } from "../../lib/cn";

export function WorkspacePage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("h-full overflow-y-auto bg-bg [scrollbar-gutter:stable]", className)}>
      <div className="mx-auto w-full max-w-[1120px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
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
        <h1 className="font-serif text-2xl text-text sm:text-[28px]">{title}</h1>
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
