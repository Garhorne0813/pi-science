import { useRef, useState, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryContent, MemoryRecord } from "@pi-science/contracts";
import { MemoryDialog } from "./MemoryDialog";
import { SettingsSelectMenu } from "../settings/SettingsSelectMenu";
import {
  memoryButton,
  memoryPrimary,
  memoryInput,
  type MemoryCategory,
} from "./memory-ui";
export function MemoryEditor({
  record,
  categories,
  busy,
  error,
  save,
  close,
}: {
  record: MemoryRecord | null;
  categories: MemoryCategory[];
  busy: boolean;
  error?: string;
  save: (c: MemoryContent) => Promise<void>;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [initial] = useState<MemoryContent>(() =>
    record
      ? {
          scope: record.scope,
          kind: record.kind,
          title: record.title,
          body: record.body,
          artifactId: record.artifactId,
          artifactVersionId: record.artifactVersionId,
          subjectFrameId: record.subjectFrameId,
          categoryId: record.categoryId,
          evidenceLevel: record.evidenceLevel,
          sources: record.sources,
        }
      : {
          scope: "project",
          kind: "preference",
          title: "",
          body: "",
          evidenceLevel: "user_stated",
          sources: [],
        },
  );
  const [value, set] = useState(initial);
  const body = useRef<HTMLTextAreaElement>(null);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  useLayoutEffect(() => {
    if (body.current) {
      body.current.style.height = "auto";
      body.current.style.height =
        Math.min(400, Math.max(160, body.current.scrollHeight)) + "px";
    }
  }, [value.body]);
  const dismiss = () => {
    if (!busy && (!dirty || window.confirm(t("memory.discardDraft")))) close();
  };
  const select = (
    field: "scope" | "kind" | "evidenceLevel" | "categoryId",
    options: { value: string; label: string }[],
    change?: (next: string) => void,
  ) => (
    <SettingsSelectMenu
      variant="field"
      ariaLabel={t(
        field === "categoryId" ? "memory.filter.categoryId" : `memory.${field}`,
      )}
      value={value[field] ?? ""}
      options={options}
      disabled={busy || (field === "scope" && !!record)}
      onSelect={(next) =>
        change ? change(next) : set({ ...value, [field]: next || undefined })
      }
    />
  );
  const source = (
    index: number,
    patch: Partial<MemoryContent["sources"][number]>,
  ) =>
    set({
      ...value,
      sources: value.sources.map((s, i) =>
        i === index ? { ...s, ...patch } : s,
      ),
    });
  return (
    <MemoryDialog
      title={
        record
          ? t("memory.editRecord", { title: record.title })
          : t("memory.create")
      }
      close={dismiss}
      size="editor"
      scrollBody={false}
      busy={busy}
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value);
        }}
      >
        <fieldset
          disabled={busy}
          className="min-h-0 space-y-5 overflow-y-auto overscroll-contain p-5"
        >
          {error && (
            <p
              role="alert"
              className="rounded-input bg-error-fill/10 p-3 text-ui-label text-error-text"
            >
              {error}
            </p>
          )}
          <label className="block space-y-2 text-ui-label font-medium">
            {t("memory.recordTitle")}
            <input
              required
              maxLength={200}
              className={memoryInput}
              value={value.title}
              onChange={(e) => set({ ...value, title: e.target.value })}
            />
          </label>
          <label className="block space-y-2 text-ui-label font-medium">
            {t("memory.body")}
            <textarea
              ref={body}
              required
              rows={6}
              maxLength={4000}
              className={memoryInput + " resize-y leading-6"}
              value={value.body}
              onChange={(e) => set({ ...value, body: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <p className="text-ui-label font-medium">{t("memory.scope")}</p>
              {select(
                "scope",
                ["profile", "project", "artifact", "frame"].map((v) => ({
                  value: v,
                  label: t(`memory.scopeLabel.${v}`),
                })),
                (next) =>
                  set({
                    ...value,
                    scope: next as MemoryContent["scope"],
                    artifactId: undefined,
                    artifactVersionId: undefined,
                    subjectFrameId: undefined,
                  }),
              )}
            </div>
            <div className="space-y-2">
              <p className="text-ui-label font-medium">{t("memory.kind")}</p>
              {select(
                "kind",
                [
                  "preference",
                  "workflow",
                  "environment",
                  "reference",
                  "observation",
                  "finding",
                  "decision",
                ].map((v) => ({ value: v, label: t(`memory.kindLabel.${v}`) })),
              )}
            </div>
            <div className="space-y-2">
              <p className="text-ui-label font-medium">
                {t("memory.filter.categoryId")}
              </p>
              {select("categoryId", [
                { value: "", label: t("memory.noCategory") },
                ...categories.map((c) => ({ value: c.id, label: c.name })),
                ...(value.categoryId &&
                !categories.some((c) => c.id === value.categoryId)
                  ? [
                      {
                        value: value.categoryId,
                        label: t("memory.unavailableCategory"),
                      },
                    ]
                  : []),
              ])}
            </div>
            <div className="space-y-2">
              <p className="text-ui-label font-medium">
                {t("memory.evidenceLevel")}
              </p>
              {select(
                "evidenceLevel",
                ["user_stated", "observed", "inferred"].map((v) => ({
                  value: v,
                  label: t(`memory.evidenceLabel.${v}`),
                })),
              )}
            </div>
          </div>
          {(value.scope === "artifact" || value.scope === "frame") && (
            <section className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-card border border-faint bg-surface-2/40 p-4">
              {(value.scope === "artifact"
                ? ["artifactId", "artifactVersionId"]
                : (["subjectFrameId"] as const)
              ).map((field) => (
                <label key={field} className="block space-y-2 text-ui-label">
                  {t(`memory.${field}`)}
                  <input
                    required={field !== "artifactVersionId"}
                    className={memoryInput}
                    value={value[field as "artifactId"] ?? ""}
                    onChange={(e) =>
                      set({ ...value, [field]: e.target.value || undefined })
                    }
                  />
                </label>
              ))}
            </section>
          )}
          <section className="space-y-3 border-t border-faint pt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-ui-label font-semibold">
                {t("memory.sourceReferences")}
              </h3>
              <button
                type="button"
                className={memoryButton}
                onClick={() =>
                  set({
                    ...value,
                    sources: [...value.sources, { kind: "file", locator: "" }],
                  })
                }
              >
                {t("memory.addSource")}
              </button>
            </div>
            <p className="text-ui-caption text-muted">
              {t("memory.sourceEditHelp")}
            </p>
            {value.sources.map((s, index) => (
              <div
                key={index}
                className="space-y-3 rounded-card border border-faint bg-surface-2/40 p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-40">
                    <SettingsSelectMenu
                      ariaLabel={t("memory.sourceKind")}
                      variant="field"
                      value={s.kind}
                      options={[
                        "file",
                        "message",
                        "session",
                        "run",
                        "artifact",
                        "memory",
                      ].map((v) => ({
                        value: v,
                        label: t(`memory.sourceType.${v}`),
                      }))}
                      disabled={busy}
                      onSelect={(kind) =>
                        source(index, {
                          kind: kind as typeof s.kind,
                          version: undefined,
                          digest: undefined,
                          projectId: undefined,
                        })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="ml-auto min-h-9 rounded-input px-2 text-ui-caption text-error-text hover:bg-error-fill/10"
                    onClick={() =>
                      set({
                        ...value,
                        sources: value.sources.filter((_, i) => i !== index),
                      })
                    }
                  >
                    {t("memory.removeSource")}
                  </button>
                </div>
                <label className="block space-y-2 text-ui-caption text-muted">
                  {t(`memory.sourceLocation.${s.kind}`, {
                    defaultValue: t("memory.sourceLocator"),
                  })}
                  <input
                    required
                    className={memoryInput}
                    value={s.locator}
                    onChange={(e) =>
                      source(index, {
                        locator: e.target.value,
                        digest: undefined,
                      })
                    }
                  />
                </label>
                <label className="block space-y-2 text-ui-caption text-muted">
                  {t("memory.sourceVersion")}
                  <input
                    className={memoryInput}
                    value={s.version ?? ""}
                    onChange={(e) =>
                      source(index, {
                        version: e.target.value || undefined,
                        digest: undefined,
                      })
                    }
                  />
                </label>
                {(s.digest || s.projectId) && (
                  <details className="text-ui-caption text-muted">
                    <summary className="cursor-pointer">
                      {t("memory.referenceDetails")}
                    </summary>
                    <dl className="mt-2 space-y-1 break-all">
                      {s.projectId && (
                        <div>
                          {t("memory.sourceField.projectId")}: {s.projectId}
                        </div>
                      )}
                      {s.digest && (
                        <div>
                          {t("memory.sourceDigest")}: {s.digest}
                        </div>
                      )}
                    </dl>
                  </details>
                )}
              </div>
            ))}
          </section>
        </fieldset>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-faint bg-surface-raised px-5 py-4">
          <p role="status" className="text-ui-caption text-muted">
            {dirty
              ? t("memory.unsavedChanges")
              : record
                ? t("memory.editCreatesProposal")
                : t("memory.sourceEditHelp")}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              className={memoryButton}
              onClick={dismiss}
            >
              {t("common.cancel")}
            </button>
            <button disabled={busy || !dirty} className={memoryPrimary}>
              {t(busy ? "common.saving" : "memory.save")}
            </button>
          </div>
        </footer>
      </form>
    </MemoryDialog>
  );
}
