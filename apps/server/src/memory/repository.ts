// Runs only inside the existing SQLite worker. No asynchronous work may enter this transaction.
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  contentSchema,
  settingsSchema,
  memoryBrowseQuerySchema,
  MemoryError,
  scientific,
  tokens,
  type MemoryContent,
  type MemoryContext,
  type MemoryRecord,
  type MemorySettings,
} from "./schema.js";
export type MemoryCommand = {
  action: string;
  context: MemoryContext;
  input: Record<string, unknown>;
};
type Proposal = {
  id: string;
  recordId: string;
  expectedRevision: number;
  expectedHash: string;
  contentHash: string;
  candidate: MemoryRecord;
  status: string;
  reason: string;
  mode: string;
};
export const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function executeMemory(
  db: DatabaseSync,
  command: MemoryCommand,
): unknown {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = new Transaction(db, command.context).execute(
      command.action,
      command.input,
    );
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
class Transaction {
  constructor(
    private db: DatabaseSync,
    private ctx: MemoryContext,
  ) {}
  private run(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).run(...params);
  }
  private all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  private one<T>(
    sql: string,
    ...params: (string | number | null)[]
  ): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  private user() {
    if (this.ctx.actor !== "user")
      throw new MemoryError(403, "Human operation required");
  }
  private settings(): MemorySettings {
    const row = this.one<{ data: string; revision: number }>(
      "SELECT data,revision FROM memory_settings WHERE owner_id=?",
      this.ctx.ownerId,
    );
    return {
      ...settingsSchema.parse(row ? JSON.parse(row.data) : {}),
      revision: row?.revision ?? 0,
    };
  }
  private visible(r: MemoryRecord): boolean {
    return (
      r.ownerId === this.ctx.ownerId &&
      (r.scope === "profile" || r.projectId === this.ctx.projectId) &&
      (!r.agentKey || r.agentKey === this.ctx.agentKey) &&
      (r.scope !== "frame" ||
        this.ctx.actor === "user" ||
        r.subjectFrameId === this.ctx.sessionId)
    );
  }
  private read(id: unknown): MemoryRecord {
    const row = this.one<{ data: string }>(
      "SELECT data FROM memory_records WHERE id=?",
      String(id),
    );
    const r: MemoryRecord | undefined = row ? JSON.parse(row.data) : undefined;
    if (!r || !this.visible(r)) throw new MemoryError(404, "Memory not found");
    return this.reconcileReview(r);
  }
  private reconcileReview(r: MemoryRecord): MemoryRecord {
    if (
      r.status === "active" &&
      scientific(r) &&
      !(r.reviewStatus === "approved" && r.approvedContentHash === r.contentHash)
    ) {
      r = {
        ...r,
        status: "needs_review",
        reviewRequired: true,
        reviewStatus: "stale",
        updatedAt: Date.now(),
      };
      this.save(r, false);
    }
    return r;
  }
  private rows(): MemoryRecord[] {
    return this.all<{ data: string }>(
      "SELECT data FROM memory_records WHERE owner_id=? AND (scope='profile' OR project_id=?)",
      this.ctx.ownerId,
      this.ctx.projectId,
    )
      .map((r) => JSON.parse(r.data) as MemoryRecord)
      .filter((r) => this.visible(r))
      .map((r) => this.reconcileReview(r));
  }
  private cas(r: MemoryRecord, i: Record<string, unknown>) {
    if (r.revision !== i.expectedRevision || r.contentHash !== i.contentHash)
      throw new MemoryError(409, "Memory revision or content hash changed");
  }
  private assertMemorySources(
    c: MemoryContent,
    chain = new Set<string>(),
    remaining = { value: 64 },
  ) {
    for (const source of c.sources.filter((s) => s.kind === "memory")) {
      const context = this.ctx;
      let r: MemoryRecord;
      try {
        this.ctx = {
          ...context,
          projectId: source.projectId ?? context.projectId,
        };
        r = this.read(source.locator);
      } finally {
        this.ctx = context;
      }
      if (
        r.status !== "active" ||
        (r.reviewRequired &&
          (r.reviewStatus !== "approved" ||
            r.approvedContentHash !== r.contentHash)) ||
        source.version !== String(r.revision) ||
        source.digest !== r.contentHash
      )
        throw new MemoryError(409, "Memory evidence is stale or not accepted");
      if (chain.has(r.id) || chain.size >= 8 || --remaining.value < 0)
        throw new MemoryError(400, "Cyclic or excessive memory evidence chain");
      const next = new Set(chain);
      next.add(r.id);
      this.assertMemorySources(r, next, remaining);
    }
  }
  private invalidateDependents(id: string) {
    const queue = [id];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const rows = this.all<{ data: string }>(
        "SELECT DISTINCT r.data FROM memory_records r JOIN memory_sources s ON s.record_id=r.id AND s.revision=r.revision WHERE r.owner_id=? AND r.status='active' AND json_extract(s.data,'$.kind')='memory' AND json_extract(s.data,'$.locator')=?",
        this.ctx.ownerId,
        current,
      );
      for (const row of rows) {
        const r = JSON.parse(row.data) as MemoryRecord;
        r.status = "needs_review";
        r.reviewStatus = "stale";
        r.updatedAt = Date.now();
        this.run(
          "UPDATE memory_records SET status=?,data=? WHERE id=?",
          r.status,
          JSON.stringify(r),
          r.id,
        );
        this.run("DELETE FROM memory_fts WHERE record_id=?", r.id);
        queue.push(r.id);
      }
    }
  }
  private save(r: MemoryRecord, snapshot = true) {
    const previous = this.one<{ content_hash: string }>(
      "SELECT content_hash FROM memory_records WHERE id=?",
      r.id,
    );
    this.run(
      "INSERT INTO memory_records(id,owner_id,project_id,scope,frame_id,agent_key,status,revision,content_hash,data) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,content_hash=excluded.content_hash,data=excluded.data",
      r.id,
      r.ownerId,
      r.projectId ?? null,
      r.scope,
      r.subjectFrameId ?? null,
      r.agentKey ?? null,
      r.status,
      r.revision,
      r.contentHash,
      JSON.stringify(r),
    );
    if (snapshot)
      this.run(
        "INSERT INTO memory_revisions VALUES(?,?,?,?)",
        r.id,
        r.revision,
        r.contentHash,
        JSON.stringify(r),
      );
    if (snapshot)
      for (const source of r.sources)
        this.run(
          "INSERT INTO memory_sources VALUES(?,?,?)",
          r.id,
          r.revision,
          JSON.stringify(source),
        );
    this.run(
      "UPDATE memory_change_proposals SET status='stale_proposal',data=json_set(data,'$.status','stale_proposal') WHERE record_id=? AND status='pending' AND expected_revision<?",
      r.id,
      r.revision,
    );
    this.run("DELETE FROM memory_fts WHERE record_id=?", r.id);
    if (r.status === "active")
      this.run(
        "INSERT INTO memory_fts(record_id,terms) VALUES(?,?)",
        r.id,
        tokens(r.title + " " + r.body).join(" "),
      );
    if (
      previous &&
      (previous.content_hash !== r.contentHash || r.status !== "active")
    )
      this.invalidateDependents(r.id);
  }
  private audit(r: MemoryRecord, action: string) {
    this.run(
      "INSERT INTO memory_review_events VALUES(?,?,?,?,?,?,?,?)",
      randomUUID(),
      r.id,
      r.revision,
      r.contentHash,
      this.ctx.ownerId,
      action,
      this.settings().review.mode,
      Date.now(),
    );
  }
  private write(i: Record<string, unknown>, autoDream = false): unknown {
    const settings = this.settings();
    if (!settings.enabled) throw new MemoryError(409, "Memory is disabled");
    let op = String(i.operation ?? "append");
    if (!["append", "replace", "remove"].includes(op))
      throw new MemoryError(400, "Invalid operation");
    const key = typeof i.operationKey === "string" ? i.operationKey : undefined;
    const fingerprint = hash({
      actor: this.ctx.actor,
      project: this.ctx.projectId,
      session: this.ctx.sessionId,
      input: i,
    });
    if (key) {
      const prior = this.one<{ request_hash: string; result: string }>(
        "SELECT request_hash,result FROM memory_operations WHERE owner_id=? AND operation_key=?",
        this.ctx.ownerId,
        key,
      );
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new MemoryError(
            409,
            "Operation key reused for different content",
          );
        return JSON.parse(prior.result);
      }
    }
    let old = op === "append" ? undefined : this.read(i.id);
    let conflict = false;
    if (old) this.cas(old, i);
    const c =
      op === "remove"
        ? contentSchema.parse(pickContent(old!))
        : contentSchema.parse(i.content);
    if (
      old &&
      (old.scope !== c.scope ||
        old.artifactId !== c.artifactId ||
        old.subjectFrameId !== c.subjectFrameId)
    )
      throw new MemoryError(
        400,
        "Create a new record to change scope or subject",
      );
    if (c.scope === "artifact" && !c.artifactId)
      throw new MemoryError(400, "Artifact scope requires artifactId");
    if (
      c.scope === "frame" &&
      (!c.subjectFrameId ||
        (this.ctx.actor !== "user" && c.subjectFrameId !== this.ctx.sessionId))
    )
      throw new MemoryError(403, "Frame must be bound to the trusted session");
    if (
      c.categoryId &&
      !this.one(
        "SELECT id FROM memory_categories WHERE id=? AND owner_id=?",
        c.categoryId,
        this.ctx.ownerId,
      )
    )
      throw new MemoryError(400, "Unknown category");
    if (
      /(?:ignore (?:all |previous )?instructions|system prompt|忽略.{0,10}指令|sk-[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password|密码|密钥)\s*[:=]\s*\S+)/i.test(
        c.body,
      )
    )
      throw new MemoryError(
        400,
        "Sensitive credentials cannot be stored in memory",
      );
    if (op === "append" && this.ctx.actor !== "user") {
      const related = this.rows().filter(
        (r) =>
          ["active", "pending_review"].includes(r.status) &&
          r.scope === c.scope &&
          r.kind === c.kind &&
          r.artifactId === c.artifactId &&
          r.artifactVersionId === c.artifactVersionId &&
          r.subjectFrameId === c.subjectFrameId &&
          r.categoryId === c.categoryId &&
          r.title.trim().toLowerCase() === c.title.trim().toLowerCase(),
      );
      const duplicate = related.find(
        (r) =>
          r.contentHash === hash(c) ||
          (!scientific(c) &&
            r.body.trim().toLowerCase() === c.body.trim().toLowerCase()),
      );
      if (duplicate) {
        const result = { record: duplicate, duplicate: true };
        if (key)
          this.run(
            "INSERT INTO memory_operations VALUES(?,?,?,?)",
            this.ctx.ownerId,
            key,
            fingerprint,
            JSON.stringify(result),
          );
        return result;
      }
      if (this.ctx.actor === "extractor" && related[0]) {
        old = related[0];
        op = "replace";
        conflict = true;
      }
    }
    this.assertMemorySources(c, new Set(old ? [old.id] : []));
    const science = scientific(c),
      protectedOld =
        !!old &&
        (scientific(old) ||
          old.origin === "user_manual" ||
          old.reviewStatus === "approved");
    const needsReview =
      science ||
      (this.ctx.actor !== "user" &&
        (settings.review.mode === "all_manual" ||
          protectedOld ||
          conflict ||
          !c.sources.length ||
          c.evidenceLevel === "inferred" ||
          (this.ctx.actor === "dream" && !autoDream)));
    const now = Date.now();
    const r: MemoryRecord = {
      ...c,
      id: old?.id ?? randomUUID(),
      ownerId: this.ctx.ownerId,
      ...(c.scope !== "profile" ? { projectId: this.ctx.projectId } : {}),
      ...(this.ctx.agentKey ? { agentKey: this.ctx.agentKey } : {}),
      origin: (
        {
          user: "user_manual",
          agent: "agent_tool",
          extractor: "background_extractor",
          dream: "dream",
        } as const
      )[this.ctx.actor],
      status:
        op === "remove"
          ? "archived"
          : needsReview
            ? "pending_review"
            : "active",
      revision: (old?.revision ?? 0) + 1,
      contentHash: hash(c),
      reviewRequired: needsReview,
      reviewStatus: needsReview ? "pending" : "not_required",
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    let result: unknown;
    if (old && needsReview) {
      const p: Proposal = {
        id: randomUUID(),
        recordId: old.id,
        expectedRevision: old.revision,
        expectedHash: old.contentHash,
        contentHash: r.contentHash,
        candidate: r,
        status: "pending",
        reason: String(i.reason ?? op).slice(0, 2000),
        mode: settings.review.mode,
      };
      this.run(
        "INSERT INTO memory_change_proposals VALUES(?,?,?,?,?,?,?,?,?)",
        p.id,
        old.id,
        this.ctx.ownerId,
        old.projectId ?? null,
        old.revision,
        old.contentHash,
        p.contentHash,
        p.status,
        JSON.stringify(p),
      );
      result = { proposal: p, record: old };
    } else {
      this.save(r);
      result = { record: r };
    }
    if (key)
      this.run(
        "INSERT INTO memory_operations VALUES(?,?,?,?)",
        this.ctx.ownerId,
        key,
        fingerprint,
        JSON.stringify(result),
      );
    return result;
  }
  private review(i: Record<string, unknown>, approve: boolean): unknown {
    this.user();
    if (i.proposalId) {
      const row = this.one<{ data: string }>(
        "SELECT data FROM memory_change_proposals WHERE id=? AND owner_id=?",
        String(i.proposalId),
        this.ctx.ownerId,
      );
      if (!row) throw new MemoryError(404, "Proposal not found");
      const p = JSON.parse(row.data) as Proposal;
      const old = this.read(p.recordId);
      if (
        !["pending", "stale_proposal"].includes(p.status) ||
        i.expectedRevision !== p.expectedRevision ||
        i.contentHash !== p.contentHash ||
        (approve &&
          (old.revision !== p.expectedRevision ||
            old.contentHash !== p.expectedHash ||
            p.status === "stale_proposal"))
      )
        throw new MemoryError(409, "Stale proposal; re-evaluation required");
      if (approve) {
        const r = {
          ...p.candidate,
          status: p.candidate.status === "archived" ? "archived" : "active",
          reviewStatus: "approved",
          approvedContentHash: p.contentHash,
          updatedAt: Date.now(),
        } as MemoryRecord;
        this.requireEvidence(r);
        this.assertMemorySources(r, new Set([r.id]));
        this.save(r);
        this.audit(r, "approve_proposal:" + p.id);
      } else this.audit(p.candidate, "reject_proposal:" + p.id);
      p.status = approve ? "approved" : "rejected";
      this.run(
        "UPDATE memory_change_proposals SET status=?,data=? WHERE id=?",
        p.status,
        JSON.stringify(p),
        p.id,
      );
      this.run(
        "UPDATE memory_dream_proposals SET data=? WHERE id=?",
        JSON.stringify(p),
        p.id,
      );
      return { proposal: p };
    }
    const r = this.read(i.id);
    this.cas(r, i);
    if (r.status !== "pending_review" && r.status !== "needs_review")
      throw new MemoryError(409, "Record is not pending review");
    if (approve) {
      this.requireEvidence(r);
      this.assertMemorySources(r, new Set([r.id]));
    }
    const next = {
      ...r,
      status: approve ? "active" : "rejected",
      reviewStatus: approve ? "approved" : "rejected",
      ...(approve ? { approvedContentHash: r.contentHash } : {}),
      revision: r.revision,
      updatedAt: Date.now(),
    } as MemoryRecord;
    this.save(next, false);
    this.audit(next, approve ? "approve" : "reject");
    return { record: next };
  }
  private requireEvidence(r: MemoryRecord) {
    if (scientific(r) && !r.sources.length)
      throw new MemoryError(
        400,
        "Scientific claims require traceable sources before approval",
      );
  }
  private search(
    i: Record<string, unknown>,
    automatic = false,
    unbounded = false,
  ): MemoryRecord[] {
    const settings = this.settings();
    if (
      automatic &&
      (!settings.enabled ||
        !settings.recall.enabled ||
        !(this.execute("project.settings", {}) as { autoRecall: boolean })
          .autoRecall)
    )
      return [];
    const disabled = new Set(
      this.all<{ id: string }>(
        "SELECT id FROM memory_categories WHERE owner_id=? AND auto_recall=0",
        this.ctx.ownerId,
      ).map((r) => r.id),
    );
    let rows = this.rows().filter(
      (r) =>
        (!i.scope || r.scope === i.scope) &&
        (!i.kind || r.kind === i.kind) &&
        (!i.status ||
          (i.status === "approved"
            ? r.status === "active" && r.reviewStatus === "approved"
            : r.status === i.status)) &&
        (!i.categoryId || r.categoryId === i.categoryId),
    );
    if (automatic)
      rows = rows.filter(
        (r) =>
          r.status === "active" &&
          (!r.reviewRequired ||
            (r.reviewStatus === "approved" &&
              r.approvedContentHash === r.contentHash)) &&
          (!r.categoryId || !disabled.has(r.categoryId)) &&
          (r.scope !== "artifact" ||
            (r.artifactId === i.artifactId &&
              r.artifactVersionId === i.artifactVersionId)),
      );
    const query = tokens(String(i.q ?? "")).slice(0, 64);
    if (!query.length)
      return rows
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        .slice(
          0,
          automatic
            ? i.scope === "profile"
              ? settings.recall.maxProfileItems
              : settings.recall.maxItemsPerTurn
            : unbounded
              ? undefined
              : 200,
        );
    // Restrict BM25's candidate set by ACL BEFORE ranking. Hidden documents cannot consume top-k slots.
    const allowed = new Set(rows.map((r) => r.id));
    const fts = this.all<{ record_id: string; score: number }>(
      "SELECT record_id,bm25(memory_fts) score FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score",
      query.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" OR "),
    ).filter((r) => allowed.has(r.record_id));
    const jac = rows
      .map((r) => {
        const set = new Set(tokens(r.title + " " + r.body));
        const shared = query.filter((t) => set.has(t)).length;
        return { r, score: shared / (set.size + query.length - shared) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    const score = new Map<string, number>();
    fts.forEach((r, n) => score.set(r.record_id, 1 / (60 + n + 1)));
    jac.forEach((r, n) =>
      score.set(r.r.id, (score.get(r.r.id) ?? 0) + 1 / (60 + n + 1)),
    );
    return rows
      .filter((r) => score.has(r.id))
      .sort(
        (a, b) =>
          (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(
        0,
        automatic
          ? settings.recall.maxItemsPerTurn
          : unbounded
            ? undefined
            : 100,
      );
  }
  execute(action: string, i: Record<string, unknown>): unknown {
    switch (action) {
      case "settings":
        return this.settings();
      case "project.settings":
        return {
          autoRecall:
            this.one<{ auto_recall: number }>(
              "SELECT auto_recall FROM memory_project_settings WHERE owner_id=? AND project_id=?",
              this.ctx.ownerId,
              this.ctx.projectId,
            )?.auto_recall !== 0,
        };
      case "project.settings.update": {
        this.user();
        if (typeof i.autoRecall !== "boolean")
          throw new MemoryError(400, "autoRecall must be boolean");
        this.run(
          "INSERT INTO memory_project_settings VALUES(?,?,?) ON CONFLICT(owner_id,project_id) DO UPDATE SET auto_recall=excluded.auto_recall",
          this.ctx.ownerId,
          this.ctx.projectId,
          i.autoRecall ? 1 : 0,
        );
        return { autoRecall: i.autoRecall };
      }

      case "settings.update": {
        this.user();
        const prev = this.settings();
        if (i.expectedRevision !== prev.revision)
          throw new MemoryError(409, "Settings revision changed");
        const parsed = settingsSchema.parse(i.settings);
        if (parsed.review.mode === "all_manual")
          parsed.dream.updatePolicy = "suggest_only";
        const next = { ...parsed, revision: prev.revision + 1 };
        this.run(
          "INSERT INTO memory_settings VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
          this.ctx.ownerId,
          next.revision,
          JSON.stringify(parsed),
        );
        if (!next.enabled || !next.dream.enabled || !next.extraction.enabled) {
          for (const row of this.all<{ id: string; data: string }>(
            "SELECT id,data FROM memory_dream_runs WHERE owner_id=? AND status IN ('queued','running')",
            this.ctx.ownerId,
          )) {
            const r = JSON.parse(row.data);
            if (
              !next.enabled ||
              !(r.kind === "dream"
                ? next.dream.enabled
                : next.extraction.enabled)
            ) {
              r.status = "cancelled";
              r.endedAt = Date.now();
              this.run(
                "UPDATE memory_dream_runs SET status=?,data=? WHERE id=?",
                "cancelled",
                JSON.stringify(r),
                row.id,
              );
            }
          }
        }
        return next;
      }
      case "agent.search": {
        const rows = this.search(i);
        const records = [];
        let remaining = 6000;
        for (const r of rows.slice(0, 20)) {
          const { body, sources, ...metadata } = r;
          const summary = {
            ...metadata,
            preview: body.slice(0, 240),
            sourceCount: sources.length,
          };
          const size = JSON.stringify(summary).length;
          if (size > remaining) continue;
          remaining -= size;
          records.push(summary);
        }
        return { records, truncated: records.length < rows.length };
      }
      case "browse": {
        this.user();
        const query = memoryBrowseQuerySchema.parse(i);
        const sort =
          query.sort ?? (query.q.trim() ? "relevance" : "updated_desc");
        const rows = this.search(query, false, true);
        if (sort !== "relevance" || !query.q.trim()) {
          const field = sort === "created_desc" ? "createdAt" : "updatedAt";
          rows.sort((a, b) => b[field] - a[field] || a.id.localeCompare(b.id));
        }
        const total = rows.length;
        const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
        const page = Math.min(query.page, totalPages);
        return {
          records: rows.slice(
            (page - 1) * query.pageSize,
            page * query.pageSize,
          ),
          total,
          page,
          pageSize: query.pageSize,
          totalPages,
          sort,
        };
      }
      case "list":
        return { records: this.search(i) };
      case "mark.stale": {
        const r = this.read(i.id);
        this.cas(r, i);
        if (r.status === "active")
          this.save(
            {
              ...r,
              status: "needs_review",
              reviewStatus: "stale",
              updatedAt: Date.now(),
            },
            false,
          );
        return { ok: true };
      }
      case "read":
        return { record: this.read(i.id) };
      case "write":
        return this.write(i);
      case "approve":
        return this.review(i, true);
      case "reject":
        return this.review(i, false);
      case "reviews":
        return {
          records: this.rows().filter(
            (r) => r.status === "pending_review" || r.status === "needs_review",
          ),
          proposals: this.all<{ data: string }>(
            "SELECT data FROM memory_change_proposals WHERE owner_id=? AND status IN ('pending','stale_proposal')",
            this.ctx.ownerId,
          )
            .map((r) => JSON.parse(r.data) as Proposal)
            .flatMap((p) => {
              try {
                return [{ ...p, current: this.read(p.recordId) }];
              } catch {
                return [];
              }
            }),
        };
      case "history": {
        const r = this.read(i.id);
        return {
          revisions: this.all<{ data: string }>(
            "SELECT data FROM memory_revisions WHERE record_id=? ORDER BY revision DESC",
            r.id,
          ).map((r) => JSON.parse(r.data)),
          reviews: this.all(
            "SELECT * FROM memory_review_events WHERE record_id=?",
            r.id,
          ),
        };
      }
      case "delete": {
        this.user();
        const r = this.read(i.id);
        this.cas(r, i);
        this.erase(r);
        return { ok: true };
      }
      case "frames":
        this.user();
        return [
          ...new Set(
            this.rows()
              .filter((r) => r.scope === "frame")
              .map((r) => r.subjectFrameId),
          ),
        ];
      case "frame.delete": {
        this.user();
        for (const r of this.rows().filter(
          (r) => r.scope === "frame" && r.subjectFrameId === i.sessionId,
        ))
          this.erase(r);
        this.run(
          "DELETE FROM memory_extraction_cursors WHERE owner_id=? AND project_id=? AND session_id=?",
          this.ctx.ownerId,
          this.ctx.projectId,
          String(i.sessionId),
        );
        for (const row of this.all<{ data: string }>(
          "SELECT data FROM memory_dream_runs WHERE owner_id=? AND project_id=?",
          this.ctx.ownerId,
          this.ctx.projectId,
        )) {
          const run = JSON.parse(row.data);
          if (run.sessionId === i.sessionId) {
            run.messages = [];
            run.messageIds = [];
            run.results = [];
            if (["queued", "running"].includes(run.status))
              run.status = "cancelled";
            this.updateRun(run);
          }
        }
        return { ok: true };
      }
      case "categories":
        return {
          categories: this.all(
            "SELECT id,name,auto_recall autoRecall FROM memory_categories WHERE owner_id=?",
            this.ctx.ownerId,
          ),
        };
      case "category.write": {
        this.user();
        if (
          typeof i.name !== "string" ||
          !i.name.trim() ||
          typeof i.autoRecall !== "boolean"
        )
          throw new MemoryError(400, "Invalid category");
        const id = String(i.id ?? randomUUID());
        const old = this.one<{ owner_id: string }>(
          "SELECT owner_id FROM memory_categories WHERE id=?",
          id,
        );
        if (old && old.owner_id !== this.ctx.ownerId)
          throw new MemoryError(403, "Category is not owned");
        this.run(
          "INSERT INTO memory_categories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,auto_recall=excluded.auto_recall",
          id,
          this.ctx.ownerId,
          i.name.slice(0, 100),
          i.autoRecall ? 1 : 0,
        );
        return { id };
      }
      case "recall": {
        const settings = this.settings();
        if (!settings.enabled || !settings.recall.enabled)
          return { records: [] };
        const profile = this.search({ scope: "profile" }, true).slice(
          0,
          settings.recall.maxProfileItems,
        );
        const ranked = (
          String(i.q ?? "").trim() ? this.search(i, true) : []
        ).filter((r) => r.scope !== "profile");
        let budget = settings.recall.maxTokensPerTurn * 3;
        let profileBudget = 4800;
        const records: MemoryRecord[] = [];
        for (const r of [...profile, ...ranked]) {
          if (records.some((x) => x.id === r.id)) continue;
          const size = JSON.stringify(r).length;
          if (size > budget || (r.scope === "profile" && size > profileBudget))
            continue;
          budget -= size;
          if (r.scope === "profile") profileBudget -= size;
          records.push(r);
        }
        return { records };
      }
      case "touch":
        this.run(
          "INSERT INTO memory_dream_schedules VALUES(?,?,?,?) ON CONFLICT(owner_id,project_id) DO UPDATE SET cwd=excluded.cwd,last_interaction=excluded.last_interaction",
          this.ctx.ownerId,
          this.ctx.projectId,
          String(i.cwd),
          Date.now(),
        );
        return { ok: true };
      case "schedules":
        return this.all(
          "SELECT * FROM memory_dream_schedules WHERE owner_id=?",
          this.ctx.ownerId,
        );
      case "cursor":
        return (
          this.one<{ watermark: number }>(
            "SELECT watermark FROM memory_extraction_cursors WHERE owner_id=? AND project_id=? AND session_id=?",
            this.ctx.ownerId,
            this.ctx.projectId,
            String(i.sessionId),
          )?.watermark ?? 0
        );
      case "run.skip": {
        const now = Date.now();
        const id =
          "skip:" +
          hash({
            owner: this.ctx.ownerId,
            project: this.ctx.projectId,
            kind: i.kind,
            reason: i.reason,
            minute: Math.floor(now / 60000),
          });
        const result = {
          id,
          kind: i.kind,
          status: "skipped",
          reason: i.reason,
          createdAt: now,
          reviewMode: this.settings().review.mode,
        };
        this.run(
          "INSERT OR IGNORE INTO memory_background_events VALUES(?,?,?,?,?)",
          id,
          this.ctx.ownerId,
          this.ctx.projectId,
          now,
          JSON.stringify(result),
        );
        this.run(
          "DELETE FROM memory_background_events WHERE owner_id=? AND id NOT IN (SELECT id FROM memory_background_events WHERE owner_id=? ORDER BY created_at DESC LIMIT 100)",
          this.ctx.ownerId,
          this.ctx.ownerId,
        );
        return result;
      }
      case "run.latest": {
        const row = this.one<{ data: string }>(
          "SELECT data FROM memory_dream_runs WHERE owner_id=? AND project_id=? AND kind=? AND json_extract(data,'$.startedAt') IS NOT NULL ORDER BY COALESCE(json_extract(data,'$.lastStartedAt'),json_extract(data,'$.startedAt')) DESC, rowid DESC LIMIT 1",
          this.ctx.ownerId,
          this.ctx.projectId,
          String(i.kind),
        );
        if (!row) return null;
        const r = JSON.parse(row.data);
        return { ...r, startedAt: r.lastStartedAt ?? r.startedAt };
      }
      case "run.pending":
        return {
          runs: this.all<{ data: string }>(
            "SELECT data FROM memory_dream_runs WHERE owner_id=? AND project_id=? AND (status='queued' OR (status='running' AND lease_until<?)) ORDER BY rowid",
            this.ctx.ownerId,
            this.ctx.projectId,
            Date.now(),
          ).map((r) => JSON.parse(r.data)),
        };
      case "runs":
        return {
          runs: [
            ...this.all<{ data: string }>(
              "SELECT data FROM memory_dream_runs WHERE owner_id=? AND project_id=? ORDER BY rowid DESC LIMIT 100",
              this.ctx.ownerId,
              this.ctx.projectId,
            ),
            ...this.all<{ data: string }>(
              "SELECT data FROM memory_background_events WHERE owner_id=? AND project_id=? ORDER BY created_at DESC LIMIT 100",
              this.ctx.ownerId,
              this.ctx.projectId,
            ),
          ]
            .map((r) => JSON.parse(r.data))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 100),
        };
      case "run.enqueue":
        return this.enqueue(i);
      case "run.claim":
        return this.claim(i);
      case "run.cancel": {
        this.user();
        const r = this.runRecord(i.id);
        if (r.status === "cancelled") return r;
        if (!["queued", "running"].includes(r.status))
          throw new MemoryError(
            409,
            "Only queued or running runs can be cancelled",
          );
        r.status = "cancelled";
        r.endedAt = Date.now();
        this.updateRun(r);
        return r;
      }
      case "run.get":
        return this.runRecord(i.id);
      case "run.retry": {
        this.user();
        const r = this.runRecord(i.id),
          s = this.settings();
        if (
          !s.enabled ||
          !(r.kind === "dream" ? s.dream.enabled : s.extraction.enabled) ||
          r.status !== "failed" ||
          (r.attempts ?? 1) >= 3
        )
          throw new MemoryError(409, "Run cannot be retried");
        r.attempts = (r.attempts ?? 1) + 1;
        r.priorReservedTokens =
          (r.priorReservedTokens ?? 0) +
          Math.max(r.reservedTokens ?? 0, r.tokens ?? 0);
        r.priorReservedCostUsd =
          (r.priorReservedCostUsd ?? 0) +
          Math.max(r.reservedCostUsd ?? 0, r.costUsd ?? 0);
        r.tokens = 0;
        r.costUsd = 0;
        r.reservedTokens = 0;
        r.reservedCostUsd = 0;
        r.status = "queued";
        r.deadline = Number(i.deadline);
        r.error = undefined;
        this.updateRun(r);
        return r;
      }

      case "run.heartbeat": {
        const r = this.runRecord(i.id),
          s = this.settings();
        if (
          r.status !== "running" ||
          r.leaseToken !== i.leaseToken ||
          r.deadline <= Date.now() ||
          !s.enabled ||
          !(r.kind === "dream" ? s.dream.enabled : s.extraction.enabled)
        )
          throw new MemoryError(409, "Run cancelled");
        r.leaseUntil = Math.min(r.deadline, Date.now() + 120000);
        this.updateRun(r);
        return { ok: true };
      }
      case "run.finish":
        return this.finish(i);
      case "run.fail": {
        const r = this.runRecord(i.id);
        if (r.leaseToken !== i.leaseToken || r.status !== "running")
          throw new MemoryError(409, "Run lease changed");
        r.status = "failed";
        r.error = String(i.error).slice(0, 2000);
        if (
          typeof i.tokens === "number" &&
          Number.isFinite(i.tokens) &&
          i.tokens >= 0 &&
          typeof i.costUsd === "number" &&
          Number.isFinite(i.costUsd) &&
          i.costUsd >= 0
        ) {
          r.tokens = i.tokens;
          r.costUsd = i.costUsd;
          r.actualModel = i.model;
          r.reservedTokens = 0;
          r.reservedCostUsd = 0;
          this.settleUsage(r);
        }
        r.endedAt = Date.now();
        this.updateRun(r);
        return r;
      }
      case "export":
        this.user();
        return {
          version: 1,
          records: this.rows(),
          history: this.rows().map((r) =>
            this.execute("history", { id: r.id }),
          ),
          categories: this.execute("categories", {}),
        };
      default:
        throw new MemoryError(400, "Unknown memory command");
    }
  }
  private erase(r: MemoryRecord) {
    this.invalidateDependents(r.id);
    this.run("DELETE FROM memory_fts WHERE record_id=?", r.id);
    this.run("DELETE FROM memory_records WHERE id=?", r.id);
    this.run(
      `UPDATE memory_operations SET result='{"deleted":true}' WHERE owner_id=? AND (json_extract(result,'$.record.id')=? OR json_extract(result,'$.proposal.recordId')=?)`,
      this.ctx.ownerId,
      r.id,
      r.id,
    );
    for (const row of this.all<{ data: string }>(
      "SELECT data FROM memory_dream_runs WHERE owner_id=?",
      this.ctx.ownerId,
    )) {
      const run = JSON.parse(row.data);
      if (JSON.stringify(run).includes(r.id)) {
        run.records = (run.records ?? []).filter(
          (item: MemoryRecord) => item.id !== r.id,
        );
        run.recordIds = (run.recordIds ?? []).filter(
          (id: string) => id !== r.id,
        );
        run.results = (run.results ?? []).filter(
          (item: { record?: MemoryRecord; proposal?: Proposal }) =>
            item.record?.id !== r.id && item.proposal?.recordId !== r.id,
        );
        if (["queued", "running"].includes(run.status))
          run.status = "cancelled";
        this.updateRun(run);
      }
    }
  }
  private runRecord(id: unknown): Record<string, any> {
    const row = this.one<{ data: string }>(
      "SELECT data FROM memory_dream_runs WHERE id=? AND owner_id=? AND project_id=?",
      String(id),
      this.ctx.ownerId,
      this.ctx.projectId,
    );
    if (!row) throw new MemoryError(404, "Run not found");
    return JSON.parse(row.data);
  }
  private updateRun(r: Record<string, any>) {
    this.run(
      "UPDATE memory_dream_runs SET status=?,lease_until=?,data=? WHERE id=?",
      r.status,
      r.leaseUntil ?? 0,
      JSON.stringify(r),
      r.id,
    );
  }
  private enqueue(i: Record<string, unknown>): unknown {
    const s = this.settings();
    const kind = i.kind === "extraction" ? "extraction" : "dream";
    if (
      !s.enabled ||
      !(kind === "dream" ? s.dream.enabled : s.extraction.enabled)
    )
      throw new MemoryError(409, "Background feature disabled");
    const key = String(i.logicalKey);
    const prior = this.one<{ data: string }>(
      "SELECT data FROM memory_dream_runs WHERE owner_id=? AND logical_key=?",
      this.ctx.ownerId,
      key,
    );
    if (prior) return JSON.parse(prior.data);
    const r = {
      ...i,
      id: randomUUID(),
      kind,
      ownerId: this.ctx.ownerId,
      projectId: this.ctx.projectId,
      logicalKey: key,
      status: "queued",
      createdAt: Date.now(),
      reviewMode: s.review.mode,
    };
    this.run(
      "INSERT INTO memory_dream_runs VALUES(?,?,?,?,?,?,?,?)",
      r.id,
      r.ownerId,
      r.projectId,
      kind,
      key,
      "queued",
      0,
      JSON.stringify(r),
    );
    return r;
  }
  private claim(i: Record<string, unknown>): unknown {
    const r = this.runRecord(i.id),
      now = Date.now(),
      s = this.settings();
    if (
      !s.enabled ||
      !(r.kind === "dream" ? s.dream.enabled : s.extraction.enabled) ||
      r.deadline <= now
    ) {
      if (r.status === "queued" || r.status === "running") {
        r.status = "interrupted";
        r.endedAt = now;
        this.updateRun(r);
      }
      return null;
    }
    if (r.status === "running" && r.leaseUntil > now) return null;
    if (!["queued", "running"].includes(r.status)) return null;
    if (
      this.one(
        "SELECT id FROM memory_dream_runs WHERE owner_id=? AND id!=? AND status='running' AND lease_until>?",
        this.ctx.ownerId,
        r.id,
        now,
      )
    )
      return null;
    const today = now - (now % 86400000);
    const usage = this.one<{ tokens: number; cost: number }>(
      "SELECT COALESCE(SUM(MAX(tokens,reserved_tokens)),0) tokens, COALESCE(SUM(MAX(cost_usd,reserved_cost_usd)),0) cost FROM memory_run_usage WHERE owner_id=? AND day=?",
      this.ctx.ownerId,
      today,
    )!;
    if (
      usage.tokens + s.budget.perRunTokens > s.budget.dailyTokens ||
      usage.cost + (r.maxCostUsd ?? 0) > s.budget.dailyCostUsd
    )
      return null;
    r.status = "running";
    r.startedAt ??= now;
    r.lastStartedAt = now;
    r.leaseUntil = Math.min(r.deadline, now + 120000);
    r.leaseToken = randomUUID();
    r.reservedTokens = s.budget.perRunTokens;
    r.reservedCostUsd = r.maxCostUsd ?? 0;
    this.run(
      "INSERT INTO memory_run_usage(lease_token,owner_id,run_id,day,reserved_tokens,reserved_cost_usd) VALUES(?,?,?,?,?,?)",
      r.leaseToken,
      this.ctx.ownerId,
      r.id,
      today,
      r.reservedTokens,
      r.reservedCostUsd,
    );
    r.reviewMode = s.review.mode;
    this.updateRun(r);
    return r;
  }
  private settleUsage(r: Record<string, any>) {
    this.run(
      "UPDATE memory_run_usage SET tokens=?,cost_usd=?,reserved_tokens=0,reserved_cost_usd=0 WHERE run_id=? AND lease_token=?",
      r.tokens ?? 0,
      r.costUsd ?? 0,
      r.id,
      r.leaseToken,
    );
  }
  private finish(i: Record<string, unknown>): unknown {
    const r = this.runRecord(i.id),
      s = this.settings(),
      now = Date.now();
    if (
      r.status !== "running" ||
      r.leaseToken !== i.leaseToken ||
      r.leaseUntil < now ||
      r.deadline <= now ||
      !s.enabled ||
      !(r.kind === "dream" ? s.dream.enabled : s.extraction.enabled)
    )
      throw new MemoryError(
        409,
        "Cancelled, expired or disabled background run",
      );
    if (
      typeof i.tokens !== "number" ||
      i.tokens > r.reservedTokens ||
      typeof i.costUsd !== "number"
    )
      throw new MemoryError(409, "Invalid usage or token budget exceeded");
    const outputs = Array.isArray(i.outputs) ? i.outputs.slice(0, 5) : [];
    const results: unknown[] = [];
    const ctx = this.ctx;
    this.ctx = {
      ...ctx,
      actor: r.kind === "dream" ? "dream" : "extractor",
      sessionId: r.sessionId,
    };
    try {
      for (const raw of outputs) {
        const output = raw as Record<string, unknown>;
        const c = contentSchema.parse(output.content);
        if (
          r.kind === "extraction" &&
          c.sources.some(
            (source) =>
              source.kind !== "message" ||
              !(r.messageIds as string[]).includes(
                source.locator.startsWith(r.sessionId + "@")
                  ? source.locator.slice(r.sessionId.length + 1)
                  : source.locator,
              ),
          )
        )
          throw new MemoryError(400, "Extractor fabricated a source");
        if (r.kind === "dream") {
          if (!output.id) continue;
          const old = this.read(output.id);
          const collectedSources = (
            (r.records ?? []) as MemoryRecord[]
          ).flatMap((record) => record.sources);
          if (
            c.sources.some((source) =>
              source.kind === "memory"
                ? !(r.recordIds as string[]).includes(source.locator)
                : !collectedSources.some(
                    (existing) =>
                      existing.kind === source.kind &&
                      existing.locator === source.locator &&
                      existing.projectId === source.projectId &&
                      existing.version === source.version &&
                      existing.digest === source.digest,
                  ),
            )
          )
            throw new MemoryError(
              403,
              "Dream evidence outside collected range",
            );
          if (!Array.isArray(r.recordIds) || !r.recordIds.includes(old.id))
            throw new MemoryError(403, "Dream source outside collected range");
          if (
            old.revision !== output.expectedRevision ||
            old.contentHash !== output.contentHash
          )
            throw new MemoryError(409, "stale_proposal");
          // Automatic changes are limited to exact, unprotected presentation duplicates.
          const duplicate = this.rows().some(
            (other) =>
              other.id !== old.id &&
              other.scope === old.scope &&
              other.title === old.title &&
              other.body === old.body &&
              other.status === "active",
          );
          const canAuto =
            s.review.mode === "smart" &&
            s.dream.updatePolicy === "auto_low_risk" &&
            output.operation === "remove" &&
            duplicate &&
            !scientific(old) &&
            old.origin !== "user_manual" &&
            old.reviewStatus !== "approved";
          const result = this.write(
            {
              ...output,
              content: c,
              operation: output.operation === "remove" ? "remove" : "replace",
            },
            canAuto,
          ) as { proposal?: Proposal };
          results.push(result);
          if (result.proposal)
            this.run(
              "INSERT INTO memory_dream_proposals VALUES(?,?,?,?)",
              result.proposal.id,
              r.id,
              old.id,
              JSON.stringify(result.proposal),
            );
        } else
          results.push(
            this.write({
              ...output,
              content: c,
              operation: output.operation ?? "append",
            }),
          );
      }
    } finally {
      this.ctx = ctx;
    }
    if (r.kind === "extraction")
      this.run(
        "INSERT INTO memory_extraction_cursors VALUES(?,?,?,?) ON CONFLICT(owner_id,project_id,session_id) DO UPDATE SET watermark=MAX(watermark,excluded.watermark)",
        ctx.ownerId,
        ctx.projectId,
        r.sessionId,
        r.watermark,
      );
    r.actualModel = i.model;
    r.status = "completed";
    r.endedAt = now;
    r.tokens = i.tokens;
    r.costUsd = i.costUsd;
    r.reservedTokens = 0;
    r.reservedCostUsd = 0;
    r.results = results;
    r.effectiveReviewMode = s.review.mode;
    this.settleUsage(r);
    this.updateRun(r);
    return r;
  }
}
export function pickContent(r: MemoryRecord): MemoryContent {
  return {
    scope: r.scope,
    kind: r.kind,
    title: r.title,
    body: r.body,
    artifactId: r.artifactId,
    artifactVersionId: r.artifactVersionId,
    subjectFrameId: r.subjectFrameId,
    categoryId: r.categoryId,
    evidenceLevel: r.evidenceLevel,
    sources: r.sources,
  };
}
