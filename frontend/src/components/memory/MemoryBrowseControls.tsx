import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { SlidersHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsSelectMenu } from "../settings/SettingsSelectMenu";

export type MemoryFilters = {
  status: string;
  kind: string;
  scope: string;
  categoryId: string;
  sort: string;
};
export function MemoryBrowseControls({
  filters,
  categories,
  hasQuery,
  active,
  update,
  clear,
}: {
  filters: MemoryFilters;
  categories: Array<{ id: string; name: string }>;
  hasQuery: boolean;
  active: boolean;
  update: (patch: Partial<MemoryFilters>) => void;
  clear: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const defaultSort = hasQuery ? "relevance" : "updated_desc";
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 640px)");
    const close = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener("change", close);
    return () => media.removeEventListener("change", close);
  }, []);
  const options = (group: string, values: string[]) => [
    { value: "", label: t("memory.filter.all") },
    ...values.map((value) => ({ value, label: t(`memory.${group}.${value}`) })),
  ];
  const fields: Array<{
    field: keyof MemoryFilters;
    options: Array<{ value: string; label: string }>;
  }> = [
    {
      field: "status",
      options: options("statusLabel", [
        "active",
        "approved",
        "pending_review",
        "needs_review",
        "archived",
        "rejected",
        "superseded",
      ]),
    },
    {
      field: "kind",
      options: options("kindLabel", [
        "preference",
        "workflow",
        "environment",
        "reference",
        "observation",
        "finding",
        "decision",
      ]),
    },
    {
      field: "scope",
      options: options("scopeLabel", [
        "profile",
        "project",
        "artifact",
        "frame",
      ]),
    },
    ...(categories.length
      ? [
          {
            field: "categoryId" as const,
            options: [
              { value: "", label: t("memory.filter.all") },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ],
          },
        ]
      : []),
    {
      field: "sort",
      options: [
        ...(hasQuery
          ? [{ value: "relevance", label: t("memory.sort.relevance") }]
          : []),
        { value: "updated_desc", label: t("memory.sort.updated_desc") },
        { value: "created_desc", label: t("memory.sort.created_desc") },
      ],
    },
  ];
  const count = fields.filter(({ field }) =>
    field === "sort" ? filters.sort !== defaultSort : !!filters[field],
  ).length;
  const summary = fields
    .filter(({ field }) => field === "sort" || filters[field])
    .map(
      ({ field, options }) =>
        options.find((o) => o.value === filters[field])?.label,
    )
    .filter(Boolean)
    .join(" · ");
  const select = (
    { field, options }: (typeof fields)[number],
    mobile = false,
  ) => (
    <label
      key={field}
      className={
        mobile
          ? "flex min-h-14 items-center justify-between gap-4 py-2 text-ui-label text-text"
          : "flex min-w-0 flex-col gap-1 text-ui-caption text-muted sm:w-36"
      }
    >
      <span className="shrink-0">{t(`memory.filter.${field}`)}</span>
      <SettingsSelectMenu
        ariaLabel={t(`memory.filter.${field}`)}
        value={(mobile ? draft : filters)[field]}
        options={options}
        onSelect={(value) =>
          mobile
            ? setDraft((previous) => ({ ...previous, [field]: value }))
            : update({ [field]: value })
        }
        variant={mobile ? "row" : "compact"}
        className={mobile ? "min-h-11 w-auto max-w-[65%]" : "w-full"}
      />
    </label>
  );
  return (
    <>
      <div className="hidden min-w-0 flex-wrap items-end gap-2 sm:flex">
        {fields.map((f) => select(f))}
        {active && (
          <button
            className="min-h-9 rounded-input px-3 text-ui-caption text-muted hover:bg-surface-hover"
            onClick={clear}
          >
            {t("memory.clearFilters")}
          </button>
        )}
      </div>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (value) setDraft({ ...filters });
          setOpen(value);
        }}
      >
        <div className="flex min-w-0 items-center gap-2 sm:hidden">
          <Dialog.Trigger asChild>
            <button
              aria-label={t("memory.filters")}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-input border border-border px-3 text-ui-caption"
            >
              <SlidersHorizontal size={14} />
              {t("memory.filterButton")}
              {count > 0 && (
                <span className="rounded bg-accent-soft px-1.5 text-accent">
                  {count}
                </span>
              )}
            </button>
          </Dialog.Trigger>
          <p
            className="min-w-0 flex-1 truncate text-ui-caption text-muted"
            title={summary}
          >
            {summary}
          </p>
          {active && (
            <button
              aria-label={t("memory.clearFilters")}
              className="flex h-11 w-9 shrink-0 items-center justify-center rounded-input text-muted hover:bg-surface-hover"
              onClick={clear}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px]" />
          <Dialog.Content
            className="ui-dialog fixed inset-x-0 bottom-0 z-[101] flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border border-border bg-surface-raised text-text shadow-pop outline-none"
            aria-describedby={undefined}
          >
            <header className="flex shrink-0 items-center justify-between border-b border-faint px-4 py-3">
              <Dialog.Title className="text-ui-title font-semibold">
                {t("memory.filters")}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  aria-label={t("common.close")}
                  className="flex h-11 w-11 items-center justify-center rounded-input text-muted hover:bg-surface-hover"
                >
                  <X size={18} />
                </button>
              </Dialog.Close>
            </header>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-4">
              <div className="divide-y divide-faint">
                {fields.map((f) => select(f, true))}
              </div>
            </div>
            <footer className="flex shrink-0 gap-3 border-t border-faint px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <button
                className="min-h-11 flex-1 rounded-input border border-border text-ui-label"
                onClick={() =>
                  setDraft({
                    status: "",
                    kind: "",
                    scope: "",
                    categoryId: "",
                    sort: defaultSort,
                  })
                }
              >
                {t("memory.resetFilters")}
              </button>
              <button
                className="min-h-11 flex-1 rounded-input bg-accent-fill text-ui-label font-medium text-accent-fg"
                onClick={() => {
                  update(draft);
                  setOpen(false);
                }}
              >
                {t("memory.applyFilters")}
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
