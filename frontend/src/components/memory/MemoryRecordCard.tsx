import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/ui";
import { useTranslation } from "react-i18next";
import { MemorySources } from "./MemorySources";
import type { MemoryCategory } from "./memory-ui";
import type { MemoryRecord } from "@pi-science/contracts";
import { useRef } from "react";

export function MemoryRecordCard({
  record: r,
  review,
  busy,
  onEdit,
  onArchive,
  onDelete,
  onHistory,
  onApprove,
  onReject,
  cwd,
  categories = [],
}: {
  record: MemoryRecord;
  cwd?: string;
  categories?: MemoryCategory[];
  review: boolean;
  busy: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onHistory: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const openingEditor = useRef(false);
  const status =
    r.status === "active" && r.reviewStatus === "approved"
      ? "approved"
      : r.status;
  const pending = ["pending_review", "needs_review"].includes(r.status);
  const actionClass =
    "min-h-9 rounded-input border border-border px-3 text-ui-caption text-text transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50";
  return (
    <article
      data-memory-id={r.id}
      className="relative min-w-0 rounded-card border border-faint bg-surface"
    >
      <details className="group">
        <summary
          className={`cursor-pointer list-none rounded-card px-3 py-3 outline-none transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent/25 [&::-webkit-details-marker]:hidden ${review ? "" : "pr-12"}`}
          aria-label={t("memory.viewRecord", { title: r.title })}
        >
          <div className="flex min-w-0 items-start gap-2">
            <ChevronRight
              size={14}
              className="mt-0.5 shrink-0 text-muted transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="min-w-0 break-words text-ui-label font-semibold line-clamp-1 group-open:line-clamp-none">
                  {r.title}
                </h2>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-4 ${pending ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted"}`}
                >
                  {t(`memory.statusLabel.${status}`)}
                </span>
              </div>
              <p className="mt-0.5 text-ui-caption text-muted">
                {t(`memory.scopeLabel.${r.scope}`)} ·{" "}
                {t(`memory.kindLabel.${r.kind}`)}
                {categories.find((c) => c.id === r.categoryId)?.name && (
                  <> · {categories.find((c) => c.id === r.categoryId)?.name}</>
                )}
              </p>
              <p className="mt-1 line-clamp-2 break-words text-ui-label leading-5 text-muted group-open:hidden">
                {r.body}
              </p>
            </div>
          </div>
        </summary>
        <div className="space-y-3 border-t border-faint px-3 py-3 sm:pl-8">
          <p className="whitespace-pre-wrap break-words text-ui-body leading-relaxed">
            {r.body}
          </p>
          <div className="text-ui-caption text-muted">
            <p>
              {t("memory.version", { version: r.revision })} ·{" "}
              {t(`memory.reviewLabel.${r.reviewStatus}`)}
            </p>
            {r.sources.length > 0 && (
              <div className="mt-2">
                <h3 className="font-medium">{t("memory.sourceReferences")}</h3>
                <MemorySources
                  sources={r.sources}
                  cwd={cwd}
                  projectId={r.projectId}
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {review && (
              <>
                <button
                  disabled={busy}
                  className={cn(
                    actionClass,
                    "border-transparent bg-accent-fill text-accent-fg hover:bg-accent-fill/90",
                  )}
                  onClick={onApprove}
                >
                  {t("memory.approve")}
                </button>
                <button
                  disabled={busy}
                  className={actionClass}
                  onClick={onReject}
                >
                  {t("memory.reject")}
                </button>
              </>
            )}
            <button disabled={busy} className={actionClass} onClick={onHistory}>
              {t("memory.history")}
            </button>
          </div>
        </div>
      </details>
      {!review && (
        <div className="absolute right-2 top-2">
          <DropdownMenu.Root
            modal={false}
            onOpenChange={(open) => {
              if (open) openingEditor.current = false;
            }}
          >
            <DropdownMenu.Trigger asChild>
              <button
                ref={menuTrigger}
                disabled={busy}
                aria-label={t("memory.recordActions", { title: r.title })}
                className="flex h-9 w-9 items-center justify-center rounded-input text-muted hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50"
              >
                <MoreHorizontal size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                onCloseAutoFocus={(event) => {
                  if (openingEditor.current) event.preventDefault();
                }}
                align="end"
                sideOffset={4}
                collisionPadding={8}
                className="ui-popover z-[110] min-w-40 rounded-card p-1 text-ui-caption text-text shadow-lg"
              >
                {(
                  [
                    ["edit", onEdit],
                    ["archive", onArchive],
                    ["delete", onDelete],
                  ] as const
                ).map(([action, handler]) => (
                  <DropdownMenu.Item
                    key={action}
                    disabled={busy}
                    onSelect={() => {
                      openingEditor.current = action === "edit";
                      if (openingEditor.current) menuTrigger.current?.focus();
                      handler();
                    }}
                    className={`flex min-h-9 cursor-default select-none items-center rounded-input px-3 outline-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50 ${action === "delete" ? "text-error-text" : ""}`}
                  >
                    {t(`memory.${action}`)}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </article>
  );
}
