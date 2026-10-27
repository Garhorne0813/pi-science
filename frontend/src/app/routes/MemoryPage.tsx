import { MemoryDialog } from "../../components/memory/MemoryDialog";
import { MemoryProposalDiff } from "../../components/memory/MemoryProposalDiff";
import { Settings2, Plus, Download } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  MemoryRecord,
  MemoryContent,
  MemoryBrowseResult,
} from "@pi-science/contracts";
import { memoryRequest, useMemorySettings } from "../../lib/memory";
import {
  MemoryBrowseControls,
  type MemoryFilters,
} from "../../components/memory/MemoryBrowseControls";
import { MemoryRecordCard } from "../../components/memory/MemoryRecordCard";
import { useUiStore } from "../../lib/ui";
type Proposal = {
  status?: string;
  id: string;
  recordId: string;
  expectedRevision: number;
  contentHash: string;
  candidate: MemoryRecord;
  reason: string;
  current?: MemoryRecord;
};
type Run = {
  id: string;
  kind: string;
  status: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  reviewMode: string;
  effectiveReviewMode?: string;
  tokens?: number;
  costUsd?: number;
  model?: string;
  actualModel?: string;
  error?: string;
  reason?: string;
  watermark?: number;
  sessionId?: string;
  messageIds?: string[];
  recordIds?: string[];
  reservedTokens?: number;
  windowStartLocalDate?: string;
  timeZone?: string;
  results?: unknown[];
};
const control =
  "min-w-0 rounded-input border border-border bg-surface px-3 py-2 text-text";
export function MemoryPage() {
  const { cwd = "" } = useParams();
  const { t } = useTranslation();
  const client = useQueryClient();
  const [tab, setTab] = useState("records");
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const requestedPage = Number(params.get("page"));
  const page =
    Number.isSafeInteger(requestedPage) &&
    requestedPage >= 1 &&
    requestedPage <= 1000000
      ? requestedPage
      : 1;
  const filters: MemoryFilters = {
    status: params.get("status") ?? "",
    kind: params.get("kind") ?? "",
    scope: params.get("scope") ?? "",
    categoryId: params.get("categoryId") ?? "",
    sort: params.get("sort") ?? (q.trim() ? "relevance" : "updated_desc"),
  };
  const updateBrowse = (patch: Record<string, string>) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("page");
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (!next.get("q")?.trim() && next.get("sort") === "relevance")
          next.delete("sort");
        return next;
      },
      { replace: true },
    );
  };
  const clearBrowse = () =>
    updateBrowse({
      q: "",
      status: "",
      kind: "",
      scope: "",
      categoryId: "",
      sort: "",
    });
  const activeFilters = !!(
    q ||
    filters.status ||
    filters.kind ||
    filters.scope ||
    filters.categoryId ||
    params.get("sort")
  );
  const browseQuery = new URLSearchParams({
    q,
    page: String(page),
    pageSize: "20",
    sort: filters.sort,
  });
  for (const key of ["status", "kind", "scope", "categoryId"] as const)
    if (filters[key]) browseQuery.set(key, filters[key]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<{ title: string; data: unknown }>();
  const historyRequest = useRef(0);
  useEffect(() => {
    setEditing(null);
    setCreating(false);
    setHistory(undefined);
    historyRequest.current++;
  }, [cwd]);
  const key = ["memory", cwd];
  const records = useQuery({
    queryKey: [...key, "records", browseQuery.toString()],
    queryFn: () =>
      memoryRequest<MemoryBrowseResult>(
        cwd,
        "/records?" + browseQuery.toString(),
      ),
  });
  const categories = useQuery({
    queryKey: [...key, "categories"],
    queryFn: () =>
      memoryRequest<{ categories: Array<{ id: string; name: string }> }>(
        cwd,
        "/categories",
      ),
  });
  const total = records.data?.total ?? records.data?.records.length ?? 0;
  const currentPage = records.data?.page ?? page;
  const totalPages = records.data?.totalPages ?? 1;
  const reviews = useQuery({
    queryKey: [...key, "reviews"],
    queryFn: () =>
      memoryRequest<{ records: MemoryRecord[]; proposals: Proposal[] }>(
        cwd,
        "/reviews",
      ),
    refetchInterval: 15000,
  });
  const settings = useMemorySettings();
  const openSettings = useUiStore((state) => state.openSettings);
  const runs = useQuery({
    queryKey: [...key, "runs"],
    queryFn: () => memoryRequest<{ runs: Run[] }>(cwd, "/background-runs"),
    refetchInterval: tab === "runs" ? 3000 : false,
  });
  async function mutate(path: string, method = "POST", body?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await memoryRequest<Record<string, unknown>>(
        cwd,
        path,
        method,
        body,
      );
      setNotice(
        result.status === "skipped"
          ? t("memory.skipped") + ": " + String(result.reason)
          : t("memory.saved"),
      );
      await client.invalidateQueries({ queryKey: key });
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const decide = (record: MemoryRecord, action: string) =>
    mutate(`/records/${record.id}/${action}`, "POST", {
      expectedRevision: record.revision,
      contentHash: record.contentHash,
    });
  const card = (r: MemoryRecord, review = false) => (
    <MemoryRecordCard
      key={`${r.id}:${r.revision}:${r.contentHash}:${review}`}
      record={r}
      review={review}
      busy={busy}
      onEdit={() => {
        setEditing(r);
        setCreating(false);
      }}
      onArchive={() =>
        void mutate(`/records/${r.id}/archive`, "POST", {
          expectedRevision: r.revision,
          contentHash: r.contentHash,
        })
      }
      onDelete={() => {
        if (window.confirm(t("memory.deleteConfirm")))
          void mutate(`/records/${r.id}`, "DELETE", {
            expectedRevision: r.revision,
            contentHash: r.contentHash,
          });
      }}
      onHistory={() => {
        const request = ++historyRequest.current;
        void memoryRequest(cwd, `/records/${r.id}/history`)
          .then((data) => {
            if (request === historyRequest.current)
              setHistory({ title: r.title, data });
          })
          .catch((e) => setError(String(e)));
      }}
      onApprove={() => void decide(r, "approve")}
      onReject={() => void decide(r, "reject")}
    />
  );
  const loadError =
    records.error ?? reviews.error ?? settings.error ?? runs.error;
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-3 sm:space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold sm:text-2xl">
              {t("memory.title")}
            </h1>
            <p className="hidden text-sm text-muted sm:block">
              {t("memory.description")}
            </p>
          </div>
          <button
            className={
              control + " flex min-h-11 items-center justify-center gap-2"
            }
            aria-label={t("memory.openSettings")}
            onClick={() => openSettings(cwd, "memory")}
          >
            <Settings2 size={16} className="sm:hidden" />
            <span className="hidden sm:inline">{t("memory.openSettings")}</span>
          </button>
        </header>
        <nav
          className="grid grid-cols-3 gap-1 sm:flex sm:flex-wrap sm:gap-2"
          aria-label={t("memory.title")}
        >
          {["records", "reviews", "runs"].map((v) => (
            <button
              key={v}
              aria-pressed={tab === v}
              className={
                control +
                " min-h-11 px-1.5 text-ui-caption sm:px-3 sm:text-sm" +
                (tab === v ? " bg-surface-selected text-accent" : "")
              }
              onClick={() => setTab(v)}
            >
              {t(`memory.${v}`)}
              {v === "reviews" &&
                ` (${(reviews.data?.records.length ?? 0) + (reviews.data?.proposals.length ?? 0)})`}
            </button>
          ))}
        </nav>
        {(error || loadError) && (
          <p role="alert" className="text-error-text">
            {error || String(loadError)}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {settings.data && !settings.data.enabled && (
          <p className="text-muted">{t("memory.disabled")}</p>
        )}
        {tab === "records" && (
          <>
            <div className="flex min-w-0 gap-2">
              <input
                className={control + " min-w-0 flex-1"}
                aria-label={t("memory.search")}
                maxLength={500}
                placeholder={t("memory.search")}
                value={q}
                onChange={(e) => updateBrowse({ q: e.target.value })}
              />
              <button
                className={
                  control +
                  " flex min-h-11 shrink-0 items-center justify-center"
                }
                aria-label={t("memory.create")}
                disabled={busy}
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                }}
              >
                <Plus size={16} className="sm:hidden" />
                <span className="hidden sm:inline">{t("memory.create")}</span>
              </button>
              <button
                className={
                  control +
                  " flex min-h-11 shrink-0 items-center justify-center"
                }
                aria-label={t("memory.export")}
                onClick={() =>
                  void memoryRequest(cwd, "/export")
                    .then((value) => {
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(value, null, 2)], {
                          type: "application/json",
                        }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "memory-export.json";
                      a.click();
                      URL.revokeObjectURL(url);
                    })
                    .catch((e) => setError(String(e)))
                }
              >
                <Download size={16} className="sm:hidden" />
                <span className="hidden sm:inline">{t("memory.export")}</span>
              </button>
            </div>
            <MemoryBrowseControls
              filters={filters}
              categories={categories.data?.categories ?? []}
              hasQuery={!!q.trim()}
              active={activeFilters}
              update={updateBrowse}
              clear={clearBrowse}
            />
            <div
              className="flex flex-wrap items-center justify-between gap-2 text-ui-caption text-muted"
              aria-live="polite"
            >
              {records.isFetching
                ? t("common.loading")
                : t("memory.matchCount", { count: total })}
            </div>
            <details className="space-y-3">
              <summary className="cursor-pointer text-sm text-muted">
                {t("memory.organization")}
              </summary>
              <MemoryOrganization cwd={cwd} busy={busy} mutate={mutate} />
            </details>
            <div className="space-y-2">
              {records.data?.records.map((r) => card(r))}
            </div>
            {records.data?.records.length === 0 && (
              <p className="text-ui-caption text-muted">
                {t(activeFilters ? "memory.noMatches" : "memory.empty")}
              </p>
            )}
            {totalPages > 1 && (
              <nav
                aria-label={t("memory.pagination")}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-faint pt-3 text-ui-caption"
              >
                <span className="text-muted">
                  {t("memory.pageInfo", {
                    page: currentPage,
                    pages: totalPages,
                  })}
                </span>
                <div className="flex gap-2">
                  <button
                    className={control}
                    disabled={records.isFetching || currentPage <= 1}
                    onClick={() =>
                      updateBrowse({ page: String(currentPage - 1) })
                    }
                  >
                    {t("memory.previousPage")}
                  </button>
                  <button
                    className={control}
                    disabled={records.isFetching || currentPage >= totalPages}
                    onClick={() =>
                      updateBrowse({ page: String(currentPage + 1) })
                    }
                  >
                    {t("memory.nextPage")}
                  </button>
                </div>
              </nav>
            )}
          </>
        )}
        {tab === "reviews" && (
          <>
            <p className="text-sm text-muted">{t("memory.approvalMeaning")}</p>
            <div className="space-y-2">
              {reviews.data?.records.map((r) => card(r, true))}
            </div>
            {reviews.data?.proposals.map((p) => (
              <article
                key={p.id}
                className="border border-border rounded-panel p-4 space-y-3"
              >
                <h2>{p.candidate.title}</h2>
                <p>{p.reason}</p>
                <p className="text-ui-caption text-muted">
                  {t("memory.version", { version: p.candidate.revision })}
                </p>
                {p.status === "stale_proposal" && (
                  <p className="text-error-text">{t("memory.stale")}</p>
                )}
                <MemoryProposalDiff
                  current={p.current}
                  candidate={p.candidate}
                />
                {["accept", "reject"].map((a) => (
                  <button
                    key={a}
                    className={control + " mr-2"}
                    disabled={
                      busy ||
                      (a === "accept" &&
                        (p.status === "stale_proposal" || !p.current))
                    }
                    onClick={() =>
                      void mutate(`/dream/proposals/${p.id}/${a}`, "POST", {
                        expectedRevision: p.expectedRevision,
                        contentHash: p.contentHash,
                      })
                    }
                  >
                    {t(a === "accept" ? "memory.approve" : "memory.reject")}
                  </button>
                ))}
              </article>
            ))}
          </>
        )}
        {tab === "runs" && (
          <>
            <p className="text-sm text-muted">{t("memory.runtimeLimit")}</p>
            <button
              className={control}
              disabled={busy}
              onClick={() => void mutate("/dream/run")}
            >
              {t("memory.runDream")}
            </button>
            <button
              className={control + " ml-2"}
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("memory.forceConfirm")))
                  void mutate("/dream/run", "POST", {
                    forceScan: true,
                    confirmedForceScan: true,
                  });
              }}
            >
              {t("memory.forceScan")}
            </button>
            {runs.data?.runs.map((r) => (
              <article
                key={r.id}
                className="border border-border rounded-panel p-4 space-y-2"
              >
                <h2>
                  {r.kind} · {r.status}
                </h2>
                <p className="text-xs">
                  {new Date(r.startedAt ?? r.createdAt).toLocaleString()} —{" "}
                  {r.endedAt ? new Date(r.endedAt).toLocaleString() : "…"} ·{" "}
                  {r.actualModel ?? r.model} ·{" "}
                  {r.effectiveReviewMode ?? r.reviewMode} · {r.tokens ?? 0}{" "}
                  tokens · ${r.costUsd ?? 0} · {r.windowStartLocalDate}{" "}
                  {r.timeZone}
                </p>
                {r.reason && (
                  <p>
                    {t("memory.skipped")}: {r.reason}
                  </p>
                )}
                <p className="text-xs text-muted">
                  {t("memory.readRange")}:{" "}
                  {r.sessionId ?? r.recordIds?.length ?? 0} ·{" "}
                  {r.watermark ?? r.messageIds?.length ?? 0} ·{" "}
                  {t("memory.reservedTokens")}: {r.reservedTokens ?? 0}
                </p>
                {r.results && (
                  <p className="text-sm">
                    {t("memory.changes")}: {r.results.length}
                  </p>
                )}
                {r.error && <p className="text-error-text">{r.error}</p>}
                {["queued", "running"].includes(r.status) && (
                  <button
                    className={control}
                    disabled={busy}
                    onClick={() => void mutate(`/dream/runs/${r.id}/cancel`)}
                  >
                    {t("memory.stop")}
                  </button>
                )}
                {r.status === "failed" && (
                  <button
                    className={control}
                    disabled={busy}
                    onClick={() =>
                      void mutate(`/background-runs/${r.id}/retry`)
                    }
                  >
                    {t("memory.retry")}
                  </button>
                )}
              </article>
            ))}
          </>
        )}
        {(creating || editing) && (
          <MemoryDialog
            title={
              editing
                ? t("memory.editRecord", { title: editing.title })
                : t("memory.create")
            }
            close={() => {
              setCreating(false);
              setEditing(null);
            }}
          >
            {error && (
              <p role="alert" className="text-error-text">
                {error}
              </p>
            )}
            <MemoryEditor
              key={editing ? `${editing.id}:${editing.revision}` : "create"}
              record={editing}
              busy={busy}
              close={() => {
                setCreating(false);
                setEditing(null);
              }}
              save={async (content) => {
                if (
                  await mutate(
                    editing ? `/records/${editing.id}` : "/records",
                    editing ? "PATCH" : "POST",
                    {
                      content,
                      ...(editing
                        ? {
                            expectedRevision: editing.revision,
                            contentHash: editing.contentHash,
                          }
                        : {}),
                    },
                  )
                ) {
                  setCreating(false);
                  setEditing(null);
                }
              }}
            />
          </MemoryDialog>
        )}
        {history !== undefined && (
          <MemoryDialog
            title={t("memory.history") + " · " + history.title}
            close={() => {
              historyRequest.current++;
              setHistory(undefined);
            }}
          >
            <pre className="min-w-0 whitespace-pre-wrap break-words text-ui-caption">
              {JSON.stringify(history.data, null, 2)}
            </pre>
          </MemoryDialog>
        )}
      </div>
    </main>
  );
}
function MemoryEditor({
  record,
  busy,
  save,
  close,
}: {
  record: MemoryRecord | null;
  busy: boolean;
  save: (value: MemoryContent) => Promise<void>;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<MemoryContent>(
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
  return (
    <form
      className="border border-border p-4 rounded-panel space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save(value);
      }}
    >
      <label className="block">
        {t("memory.recordTitle")}
        <input
          required
          className={control + " w-full"}
          value={value.title}
          onChange={(e) => setValue({ ...value, title: e.target.value })}
        />
      </label>
      <label className="block">
        {t("memory.body")}
        <textarea
          required
          className={control + " w-full"}
          value={value.body}
          onChange={(e) => setValue({ ...value, body: e.target.value })}
        />
      </label>
      {(["scope", "kind"] as const).map((field) => (
        <label key={field} className="block">
          {t(`memory.${field}`)}
          <select
            className={control + " ml-2"}
            disabled={!!record && field === "scope"}
            value={value[field]}
            onChange={(e) => setValue({ ...value, [field]: e.target.value })}
          >
            {(field === "scope"
              ? ["profile", "project", "artifact", "frame"]
              : [
                  "preference",
                  "workflow",
                  "environment",
                  "reference",
                  "observation",
                  "finding",
                  "decision",
                ]
            ).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      ))}
      {(
        [
          "artifactId",
          "artifactVersionId",
          "subjectFrameId",
          "categoryId",
        ] as const
      ).map((field) => (
        <label key={field} className="block text-sm">
          {t(`memory.${field}`)}
          <input
            className={control + " w-full"}
            value={value[field] ?? ""}
            onChange={(e) =>
              setValue({ ...value, [field]: e.target.value || undefined })
            }
          />
        </label>
      ))}
      <fieldset className="space-y-2">
        <legend>{t("memory.sources")}</legend>
        {value.sources.map((source, index) => (
          <div key={index} className="flex gap-2 flex-wrap">
            <select
              aria-label={t("memory.sourceKind")}
              className={control}
              value={source.kind}
              onChange={(e) =>
                setValue({
                  ...value,
                  sources: value.sources.map((s, i) =>
                    i === index
                      ? { ...s, kind: e.target.value as typeof source.kind }
                      : s,
                  ),
                })
              }
            >
              {["file", "message", "session", "run", "artifact", "memory"].map(
                (kind) => (
                  <option key={kind}>{kind}</option>
                ),
              )}
            </select>
            <input
              required
              aria-label={t("memory.sourceLocator")}
              placeholder={t("memory.sourceLocator")}
              className={control + " min-w-0 flex-1 basis-full sm:basis-auto"}
              value={source.locator}
              onChange={(e) =>
                setValue({
                  ...value,
                  sources: value.sources.map((s, i) =>
                    i === index
                      ? { ...s, locator: e.target.value, digest: undefined }
                      : s,
                  ),
                })
              }
            />
            <input
              aria-label={t("memory.sourceVersion")}
              placeholder={t("memory.sourceVersion")}
              className={control + " w-32"}
              value={source.version ?? ""}
              onChange={(e) =>
                setValue({
                  ...value,
                  sources: value.sources.map((s, i) =>
                    i === index
                      ? {
                          ...s,
                          version: e.target.value || undefined,
                          digest: undefined,
                        }
                      : s,
                  ),
                })
              }
            />
            <button
              type="button"
              className={control}
              onClick={() =>
                setValue({
                  ...value,
                  sources: value.sources.filter((_, i) => i !== index),
                })
              }
            >
              {t("memory.removeSource")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className={control}
          onClick={() =>
            setValue({
              ...value,
              sources: [...value.sources, { kind: "file", locator: "" }],
            })
          }
        >
          {t("memory.addSource")}
        </button>
      </fieldset>
      <button disabled={busy} className={control}>
        {t("memory.save")}
      </button>
      <button type="button" className={control + " ml-2"} onClick={close}>
        {t("common.cancel")}
      </button>
    </form>
  );
}

function MemoryOrganization({
  cwd,
  busy,
  mutate,
}: {
  cwd: string;
  busy: boolean;
  mutate: (path: string, method?: string, body?: unknown) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const categories = useQuery({
    queryKey: ["memory", cwd, "categories"],
    queryFn: () =>
      memoryRequest<{
        categories: Array<{ id: string; name: string; autoRecall: number }>;
      }>(cwd, "/categories"),
  });
  const project = useQuery({
    queryKey: ["memory", cwd, "project-settings"],
    queryFn: () =>
      memoryRequest<{ autoRecall: boolean }>(cwd, "/project-settings"),
  });
  return (
    <section className="space-y-3 border border-border p-4 rounded-panel">
      <h2>{t("memory.organization")}</h2>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={project.data?.autoRecall ?? true}
          disabled={busy || !project.data}
          onChange={(e) =>
            void mutate("/project-settings", "PATCH", {
              autoRecall: e.target.checked,
            })
          }
        />
        {t("memory.projectRecall")}
      </label>
      {categories.data?.categories.map((c) => (
        <label className="flex gap-2" key={c.id}>
          <input
            type="checkbox"
            checked={!!c.autoRecall}
            disabled={busy}
            onChange={(e) =>
              void mutate("/categories", "POST", {
                id: c.id,
                name: c.name,
                autoRecall: e.target.checked,
              })
            }
          />
          {c.name}
          <span className="text-xs text-muted">{c.id}</span>
        </label>
      ))}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void mutate("/categories", "POST", { name, autoRecall: true }).then(
            (ok) => {
              if (ok) setName("");
            },
          );
        }}
      >
        <input
          required
          className={control}
          aria-label={t("memory.categoryName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className={control} disabled={busy}>
          {t("memory.addCategory")}
        </button>
      </form>
    </section>
  );
}
