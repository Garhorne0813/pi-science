import { useFeedback } from "../../components/feedback/feedback-context";
import { WorkspacePage, WorkspacePageHeader } from "../../components/layout/WorkspacePage";
import { ErrorState, EmptyState } from "../../components/ui/controls";
import { MemoryDialog } from "../../components/memory/MemoryDialog";
import { MemoryReviewRecord } from "../../components/memory/MemoryReviewRecord";
import { MemoryEditor } from "../../components/memory/MemoryEditor";
import {
  MemoryHistory,
  type MemoryHistoryData,
} from "../../components/memory/MemoryHistory";
import {
  MemoryRunCard,
  type MemoryRun as Run,
} from "../../components/memory/MemoryRunCard";
import { memoryButton, memoryPrimary, memoryInput } from "../../components/memory/memory-ui";
import {
  changedMemoryFields,
  MemoryProposalDiff,
} from "../../components/memory/MemoryProposalDiff";
import { Plus, Download, Settings2 } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MemoryRecord, MemoryBrowseResult } from "@pi-science/contracts";
import { memoryRequest, useMemorySettings } from "../../lib/memory";
import {
  MemoryBrowseControls,
  type MemoryFilters,
} from "../../components/memory/MemoryBrowseControls";
import { MemoryRecordCard } from "../../components/memory/MemoryRecordCard";
import { cn, useUiStore } from "../../lib/ui";
type Proposal = {
  status?: string;
  id: string;
  recordId: string;
  expectedRevision: number;
  expectedHash?: string;
  contentHash: string;
  candidate: MemoryRecord;
  reason: string;
  current?: MemoryRecord;
};
function staleProposal(p: Proposal) {
  return (
    p.status === "stale_proposal" ||
    (!!p.current &&
      (p.current.revision !== p.expectedRevision ||
        (!!p.expectedHash && p.current.contentHash !== p.expectedHash)))
  );
}
const control = memoryButton;
export function MemoryPage() {
  const { cwd = "" } = useParams();
  const { t } = useTranslation();
  const { confirm } = useFeedback();
  const client = useQueryClient();
  const [organizationOpen, setOrganizationOpen] = useState(false);
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
  const [noticeReview, setNoticeReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<{
    record: MemoryRecord;
    data: MemoryHistoryData;
  }>();
  const [proposalId, setProposalId] = useState<string>();
  const [reviewRecordId, setReviewRecordId] = useState<string>();
  const historyRequest = useRef(0);
  const projectGeneration = useRef(0);
  const reviewTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    projectGeneration.current++;
    setBusy(false);
    setOrganizationOpen(false);
    setError("");
    setNotice("");
    setNoticeReview(false);
    setEditing(null);
    setCreating(false);
    setHistory(undefined);
    setProposalId(undefined);
    setReviewRecordId(undefined);
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
    const generation = projectGeneration.current;
    const isCurrentProject = () => generation === projectGeneration.current;
    setBusy(true);
    setError("");
    setNotice("");
    setNoticeReview(false);
    try {
      const result = await memoryRequest<Record<string, unknown>>(
        cwd,
        path,
        method,
        body,
      );
      // Refresh the originating project even if its UI is no longer visible.
      await client.invalidateQueries({ queryKey: key });
      if (!isCurrentProject()) return false;
      setNotice(
        result.proposal
          ? t("memory.submittedForReview")
          : result.status === "skipped"
            ? t("memory.skipped") + ": " + String(result.reason)
            : t("memory.saved"),
      );
      setNoticeReview(!!result.proposal);
      return true;
    } catch (e) {
      if (isCurrentProject()) setError(String(e));
      return false;
    } finally {
      if (isCurrentProject()) setBusy(false);
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
      cwd={cwd}
      categories={categories.data?.categories}
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
      onDelete={async () => {
        if (await confirm({ title: t("memory.delete"), message: `${r.title} — ${t("memory.deleteConfirm")}`, confirmLabel: t("memory.delete"), destructive: true }))
          void mutate(`/records/${r.id}`, "DELETE", {
            expectedRevision: r.revision,
            contentHash: r.contentHash,
          });
      }}
      onHistory={() => {
        const request = ++historyRequest.current;
        const generation = projectGeneration.current;
        const isCurrentRequest = () =>
          generation === projectGeneration.current && request === historyRequest.current;
        void memoryRequest<MemoryHistoryData>(cwd, `/records/${r.id}/history`)
          .then((data) => {
            if (isCurrentRequest())
              setHistory({ record: r, data });
          })
          .catch((e) => {
            if (isCurrentRequest()) setError(String(e));
          });
      }}
      onApprove={() => void decide(r, "approve")}
      onReject={() => void decide(r, "reject")}
    />
  );
  const proposal = reviews.data?.proposals.find((p) => p.id === proposalId);
  const reviewRecord = reviews.data?.records.find(
    (r) => r.id === reviewRecordId,
  );
  const sectionQuery = tab === "reviews" ? reviews : tab === "runs" ? runs : records;
  return (
    <WorkspacePage>
      <div className="space-y-3">
        <WorkspacePageHeader className="max-sm:flex-row max-sm:justify-between max-sm:gap-3 max-sm:pb-3" title={t("memory.title")} description={<span className="hidden sm:inline">{t("memory.description")}</span>} actions={<button className={control} aria-label={t("memory.openSettings")} onClick={() => openSettings(cwd, "memory")}><Settings2 size={16} className="sm:hidden" /><span className="hidden sm:inline">{t("memory.openSettings")}</span></button>} />
        <nav
          className="grid grid-cols-3 gap-1 sm:flex sm:flex-wrap sm:gap-2"
          aria-label={t("memory.title")}
        >
          {["records", "reviews", "runs"].map((v) => (
            <button
              key={v}
              ref={v === "reviews" ? reviewTabRef : undefined}
              aria-pressed={tab === v}
              className={cn(control, "min-h-11 rounded-none border-0 border-b-2 bg-transparent px-3 text-sm", tab === v ? "border-accent text-accent" : "border-transparent")}
              onClick={() => setTab(v)}
            >
              {t(`memory.${v}`)}
              {v === "reviews" &&
                ` (${reviews.isError ? t("common.unknownCount") : reviews.data ? reviews.data.records.length + reviews.data.proposals.length : "…"})`}
            </button>
          ))}
        </nav>
        {error && <p role="alert" className="text-error-text">{error}</p>}
        {sectionQuery.isError && <ErrorState retry={() => void sectionQuery.refetch()} retryLabel={t("common.retry")} busy={sectionQuery.isFetching}>{t("common.loadFailed", { section: t(`memory.${tab}`) })}{sectionQuery.data && <p>{t("common.refreshFailed")}</p>}</ErrorState>}
        {settings.isError && <ErrorState retry={() => void settings.refetch()} retryLabel={t("common.retry")}>{t("common.loadFailed", { section: t("memory.settings") })}</ErrorState>}
        {sectionQuery.isPending && <p role="status" className="text-ui-body text-muted">{t("common.loading")}</p>}
        {tab === "reviews" && reviews.isSuccess && !reviews.data.records.length && !reviews.data.proposals.length && <EmptyState>{t("memory.noReviews")}</EmptyState>}
        {tab === "runs" && runs.isSuccess && !runs.data.runs.length && <EmptyState>{t("memory.noRuns")}</EmptyState>}
        {notice && (
          <div role="status" className="flex items-center gap-3">
            <p>{notice}</p>
            {noticeReview && (
              <button className={control} onClick={() => setTab("reviews")}>
                {t("memory.viewPendingReview")}
              </button>
            )}
          </div>
        )}
        {settings.data && !settings.data.enabled && (
          <p className="text-muted">{t("memory.disabled")}</p>
        )}
        {tab === "records" && (
          <>
            <div className="flex min-w-0 gap-2">
              <input
                className={memoryInput + " flex-1"}
                aria-label={t("memory.search")}
                maxLength={500}
                placeholder={t("memory.search")}
                value={q}
                onChange={(e) => updateBrowse({ q: e.target.value })}
              />
              <button
                className={
                  memoryPrimary +
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
                onClick={() => {
                  const generation = projectGeneration.current;
                  void memoryRequest(cwd, "/export")
                    .then((value) => {
                      if (generation !== projectGeneration.current) return;
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
                    .catch((e) => {
                      if (generation === projectGeneration.current) setError(String(e));
                    });
                }}
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
                : records.data ? t("memory.matchCount", { count: total }) : t("common.unknownCount")}
            </div>
            <button type="button" className="text-ui-caption text-link" onClick={() => setOrganizationOpen(true)}>{t("memory.organization")}</button>
            <div className="space-y-2">
              {records.data?.records.map((r) => card(r))}
            </div>
            {!records.isError && records.data?.records.length === 0 && (
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
              {reviews.data?.records.map((r) => (
                <article
                  key={r.id}
                  data-memory-id={r.id}
                  className="flex items-start justify-between gap-5 rounded-card border border-faint bg-surface p-4"
                >
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="break-words text-ui-label font-semibold">
                        {r.title}
                      </h2>
                      <span className="rounded bg-accent-soft px-2 py-0.5 text-ui-caption text-accent">
                        {t(
                          r.status === "needs_review"
                            ? "memory.changeRecheck"
                            : "memory.changeNew",
                        )}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-ui-caption leading-5 text-muted">
                      {r.body}
                    </p>
                    <p className="text-ui-caption text-muted">
                      {t("memory.version", { version: r.revision })} ·{" "}
                      {t(`memory.kindLabel.${r.kind}`)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={control + " shrink-0"}
                    onClick={() => setReviewRecordId(r.id)}
                  >
                    {t("memory.reviewCandidate")}
                  </button>
                </article>
              ))}
            </div>
            <div className="space-y-2">
              {reviews.data?.proposals.map((p) => (
                <article
                  key={p.id}
                  className="flex items-start justify-between gap-5 rounded-card border border-faint bg-surface p-4"
                >
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="break-words text-ui-label font-semibold">
                        {p.candidate.title}
                      </h2>
                      <span className="rounded bg-accent-soft px-2 py-0.5 text-ui-caption text-accent">
                        {t(
                          p.candidate.status === "archived"
                            ? "memory.changeArchive"
                            : "memory.changeModify",
                        )}
                      </span>
                      {staleProposal(p) && (
                        <span className="text-ui-caption text-error-text">
                          {t("memory.stale")}
                        </span>
                      )}
                    </div>
                    {p.reason &&
                      !["append", "replace", "remove"].includes(p.reason) && (
                        <p className="text-ui-caption text-muted">{p.reason}</p>
                      )}
                    <p className="text-ui-caption text-muted">
                      {t("memory.version", { version: p.candidate.revision })} ·{" "}
                      {t("memory.changedFieldCount", {
                        count: p.current
                          ? changedMemoryFields(p.current, p.candidate).length
                          : 0,
                      })}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={control + " shrink-0"}
                    onClick={() => setProposalId(p.id)}
                  >
                    {t("memory.reviewChange")}
                  </button>
                </article>
              ))}
            </div>
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
              onClick={async () => {
                if (await confirm({ title: t("memory.forceScan"), message: t("memory.forceConfirm"), confirmLabel: t("common.ok") }))
                  void mutate("/dream/run", "POST", {
                    forceScan: true,
                    confirmedForceScan: true,
                  });
              }}
            >
              {t("memory.forceScan")}
            </button>
            <div className="space-y-2">
              {runs.data?.runs.map((r) => (
                <MemoryRunCard
                  key={r.id}
                  run={r}
                  busy={busy}
                  stop={() => void mutate(`/dream/runs/${r.id}/cancel`)}
                  retry={() => void mutate(`/background-runs/${r.id}/retry`)}
                />
              ))}
            </div>
          </>
        )}
        {organizationOpen && <MemoryDialog title={t("memory.organization")} close={() => setOrganizationOpen(false)}><MemoryOrganization cwd={cwd} busy={busy} mutate={mutate} /></MemoryDialog>}
        {(creating || editing) && (
          <MemoryEditor
            key={editing ? `${editing.id}:${editing.revision}` : "create"}
            record={editing}
            categories={categories.data?.categories ?? []}
            busy={busy}
            error={error}
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
        )}
        {reviewRecordId && (
          <MemoryDialog
            title={reviewRecord?.title ?? t("memory.reviewCandidate")}
            fallbackFocus={() => reviewTabRef.current}
            size="wide"
            busy={busy}
            close={() => setReviewRecordId(undefined)}
            footer={
              <div className="flex items-center justify-between gap-4">
                <p className="max-w-xl text-ui-caption text-muted">
                  {t("memory.approvalMeaning")}
                </p>
                <div className="flex shrink-0 gap-2">
                  {["reject", "approve"].map((action) => (
                    <button
                      type="button"
                      key={action}
                      className={action === "approve" ? memoryPrimary : control}
                      disabled={busy || !reviewRecord}
                      onClick={async () => {
                        if (
                          reviewRecord &&
                          (await decide(reviewRecord, action))
                        )
                          setReviewRecordId(undefined);
                      }}
                    >
                      {t(
                        action === "approve"
                          ? "memory.approve"
                          : "memory.reject",
                      )}
                    </button>
                  ))}
                </div>
              </div>
            }
          >
            {error && (
              <p role="alert" className="mb-4 text-ui-label text-error-text">
                {error}
              </p>
            )}
            {reviewRecord ? (
              <MemoryReviewRecord
                record={reviewRecord}
                cwd={cwd}
                categories={categories.data?.categories ?? []}
                onOpenSource={() => setReviewRecordId(undefined)}
              />
            ) : (
              <p role="alert">{t("memory.candidateUnavailable")}</p>
            )}
          </MemoryDialog>
        )}
        {proposalId && (
          <MemoryDialog
            title={proposal?.candidate.title ?? t("memory.reviewChange")}
            fallbackFocus={() => reviewTabRef.current}
            size="wide"
            close={() => setProposalId(undefined)}
            busy={busy}
            footer={
              <div className="flex items-center justify-between gap-4">
                <p className="max-w-xl text-ui-caption text-muted">
                  {t("memory.approvalMeaning")}
                </p>
                <div className="flex shrink-0 gap-2">
                  {["reject", "accept"].map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={action === "accept" ? memoryPrimary : control}
                      disabled={
                        busy ||
                        !proposal ||
                        (action === "accept" &&
                          (staleProposal(proposal) || !proposal.current))
                      }
                      onClick={async () => {
                        if (
                          proposal &&
                          (await mutate(
                            `/dream/proposals/${proposal.id}/${action}`,
                            "POST",
                            {
                              expectedRevision: proposal.expectedRevision,
                              contentHash: proposal.contentHash,
                            },
                          ))
                        )
                          setProposalId(undefined);
                      }}
                    >
                      {t(
                        action === "accept"
                          ? "memory.approve"
                          : "memory.reject",
                      )}
                    </button>
                  ))}
                </div>
              </div>
            }
          >
            {error && (
              <p role="alert" className="mb-4 text-ui-label text-error-text">
                {error}
              </p>
            )}
            {proposal ? (
              <>
                <div className="mb-3 space-y-2">
                  <div className="flex gap-2 text-ui-caption text-muted">
                    <span>
                      {t(
                        proposal.candidate.status === "archived"
                          ? "memory.changeArchive"
                          : "memory.changeModify",
                      )}
                    </span>
                    <span>
                      {t("memory.version", {
                        version: proposal.candidate.revision,
                      })}
                    </span>
                  </div>
                  {proposal.reason &&
                    !["append", "replace", "remove"].includes(
                      proposal.reason,
                    ) && (
                      <p className="text-ui-label text-muted">
                        {proposal.reason}
                      </p>
                    )}
                  {staleProposal(proposal) && (
                    <p role="alert" className="text-ui-label text-error-text">
                      {t("memory.stale")}
                    </p>
                  )}
                </div>
                <MemoryProposalDiff
                  current={proposal.current}
                  candidate={proposal.candidate}
                  categories={categories.data?.categories}
                  cwd={cwd}
                  onOpenSource={() => setProposalId(undefined)}
                />
              </>
            ) : (
              <p role="alert">{t("memory.proposalUnavailable")}</p>
            )}
          </MemoryDialog>
        )}
        {history && (
          <MemoryDialog
            title={t("memory.history") + " · " + history.record.title}
            size="wide"
            scrollBody={false}
            close={() => {
              historyRequest.current++;
              setHistory(undefined);
            }}
          >
            <MemoryHistory
              data={history.data}
              current={history.record}
              onOpenSource={() => {
                historyRequest.current++;
                setHistory(undefined);
              }}
              categories={categories.data?.categories ?? []}
              cwd={cwd}
            />
          </MemoryDialog>
        )}
      </div>
    </WorkspacePage>
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
    <section className="space-y-3 border border-border p-4 rounded-card">
      {categories.isError && <ErrorState retry={() => void categories.refetch()} retryLabel={t("common.retry")}>{t("common.loadFailed", { section: t("memory.filter.categoryId") })}</ErrorState>}
      {project.isError && <ErrorState retry={() => void project.refetch()} retryLabel={t("common.retry")}>{t("common.loadFailed", { section: t("memory.projectRecall") })}</ErrorState>}
      <h2>{t("memory.organization")}</h2>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={project.data?.autoRecall ?? false}
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
