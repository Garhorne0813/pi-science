import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readJsonLines, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../storage/persistence.js";
import type { SessionRepository } from "../runtime/node/session-repository.js";

/** Workspace-local durable conversation navigation state.
 *
 *  Canonical file: `.pi-science/conversation-navigation.json` (schema v1).
 *  Legacy `.pi-science/bookmarks.jsonl` rows are folded in read-only on first
 *  use and materialized into the JSON on the first write; the legacy file is
 *  never deleted or rewritten so a code rollback can restore the old path.
 *
 *  The state deliberately stores no absolute paths, no opaque cursors (every
 *  read re-resolves `before` from the session file) and no transcript text
 *  beyond the capped bookmark quote. All writes go through the shared
 *  `withFileWriteLock` + `writeJsonAtomic` primitives. */

export interface ConversationBookmark {
  bookmark_id: string;
  session_id: string;
  message_id: string;
  role: "user" | "assistant";
  quote: string;
  label: string | null;
  origin: "user" | "agent_proposal" | "legacy_auto";
  status: "accepted" | "proposed" | "rejected";
  created_at: string;
  updated_at: string;
}

export interface ConversationReadState {
  session_id: string;
  anchor_message_id: string | null;
  at_bottom: boolean;
  seen_snapshot_version: string | null;
  updated_at: string;
}

interface ConversationNavigationStateV1 {
  schema_version: 1;
  bookmarks: ConversationBookmark[];
  read_states: Record<string, ConversationReadState>;
  /** Deterministic ids of legacy bookmarks the user deleted. The legacy
   *  `bookmarks.jsonl` file is never rewritten (rollback safety), so these
   *  ids suppress re-import on every fold — the deletion stays durable. */
  legacy_deleted_ids: string[];
}

interface LegacyBookmarkRow {
  session_id?: unknown;
  created_at?: unknown;
  bookmarks?: unknown;
}

interface LegacyBookmarkEntry {
  session_id?: unknown;
  message_id?: unknown;
  quote?: unknown;
}

export class NavigationError extends Error {
  constructor(readonly code: "not_found" | "invalid_anchor" | "corrupt" | "unsupported" | "limit", message: string) {
    super(message);
    this.name = "NavigationError";
  }
}

const NAVIGATION_FILE = "conversation-navigation.json";
const LEGACY_BOOKMARKS_FILE = "bookmarks.jsonl";
const MAX_BOOKMARKS_PER_SESSION = 500;
const MAX_QUOTE = 500;

function emptyState(): ConversationNavigationStateV1 {
  return { schema_version: 1, bookmarks: [], read_states: {}, legacy_deleted_ids: [] };
}

/** Normalize a legacy row timestamp (epoch seconds, epoch milliseconds or an
 *  ISO string) to an ISO timestamp; returns null for absent/invalid values. */
function parseLegacyTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // The legacy writer stored `Date.now() / 1000` (epoch seconds); accept
    // epoch milliseconds as well. 1e12 ms ≈ 2001-09-09, so seconds and
    // milliseconds are unambiguously separable.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime()) && date.getTime() > 0) return date.toISOString();
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return null;
  }
  return null;
}

/** Preserve the legacy row's creation time when present; fall back to a
 *  deterministic value (derived from the stable legacy bookmark id) only when
 *  absent, so repeated folds never produce per-read timestamp jitter. */
function legacyCreatedAt(rowCreatedAt: unknown, bookmarkId: string): string {
  const parsed = parseLegacyTimestamp(rowCreatedAt);
  if (parsed) return parsed;
  const seed = Number.parseInt(bookmarkId.replace(/^legacy-/, "").slice(0, 8), 16);
  return new Date(Number.isFinite(seed) ? seed : 0).toISOString();
}

function isBookmark(value: unknown): value is ConversationBookmark {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.bookmark_id === "string"
    && typeof record.session_id === "string"
    && typeof record.message_id === "string"
    && (record.role === "user" || record.role === "assistant")
    && typeof record.quote === "string"
    && (record.label === null || typeof record.label === "string")
    && (record.origin === "user" || record.origin === "agent_proposal" || record.origin === "legacy_auto")
    && (record.status === "accepted" || record.status === "proposed" || record.status === "rejected")
    && typeof record.created_at === "string"
    && typeof record.updated_at === "string";
}

function isReadState(value: unknown): value is ConversationReadState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.session_id === "string"
    && (record.anchor_message_id === null || typeof record.anchor_message_id === "string")
    && typeof record.at_bottom === "boolean"
    && (record.seen_snapshot_version === null || typeof record.seen_snapshot_version === "string")
    && typeof record.updated_at === "string";
}

function legacyBookmarkId(sessionId: string, messageId: string, quote: string): string {
  return `legacy-${createHash("sha256").update(`${sessionId}\0${messageId}\0${quote}`).digest("hex").slice(0, 24)}`;
}

export class ConversationNavigationRepository {
  constructor(private readonly sessionRepository: Pick<SessionRepository, "messageLocator" | "messageIndex" | "sessionSnapshotVersion">) {}

  // ── State IO (fail closed on corrupt / future schemas) ──

  private statePath(cwd: string): string {
    return workspaceFile(cwd, NAVIGATION_FILE);
  }

  private async loadState(cwd: string): Promise<ConversationNavigationStateV1> {
    let text: string;
    try {
      text = await readFile(this.statePath(cwd), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new NavigationError("corrupt", `unable to read conversation navigation state: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new NavigationError("corrupt", "conversation navigation state is corrupt");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NavigationError("corrupt", "conversation navigation state is corrupt");
    }
    const record = parsed as Record<string, unknown>;
    if (record.schema_version !== 1) {
      throw new NavigationError("unsupported", `unsupported conversation navigation schema_version: ${String(record.schema_version)}`);
    }
    const bookmarks = record.bookmarks;
    if (!Array.isArray(bookmarks) || !bookmarks.every(isBookmark)) {
      throw new NavigationError("corrupt", "conversation navigation bookmarks are corrupt");
    }
    const readStates = record.read_states;
    if (!readStates || typeof readStates !== "object" || Array.isArray(readStates)) {
      throw new NavigationError("corrupt", "conversation navigation read states are corrupt");
    }
    const states = readStates as Record<string, unknown>;
    if (!Object.values(states).every(isReadState)) {
      throw new NavigationError("corrupt", "conversation navigation read states are corrupt");
    }
    // `legacy_deleted_ids` is additive: v1 files written before tombstones
    // existed simply omit the field and read as an empty list.
    const legacyDeleted = record.legacy_deleted_ids;
    if (legacyDeleted !== undefined && (!Array.isArray(legacyDeleted) || !legacyDeleted.every((id) => typeof id === "string"))) {
      throw new NavigationError("corrupt", "conversation navigation tombstones are corrupt");
    }
    return {
      schema_version: 1,
      bookmarks,
      read_states: states as Record<string, ConversationReadState>,
      legacy_deleted_ids: (legacyDeleted as string[] | undefined) ?? [],
    };
  }

  /** Fold legacy `bookmarks.jsonl` rows into the returned view. Entries whose
   *  message no longer exists in the session JSONL are skipped (they would be
   *  dangling clickable anchors); the count is reported for diagnostics. Once
   *  an entry has been materialized into the JSON state, the fold skips it by
   *  deterministic id, so repeated reads do not re-scan session files.
   *  Tombstoned ids (user-deleted legacy bookmarks) are skipped silently —
   *  they are intentional deletions, not anomalies, and must never re-enter
   *  the view while the legacy file stays untouched for rollback. */
  private async foldLegacy(cwd: string, state: ConversationNavigationStateV1): Promise<{ bookmarks: ConversationBookmark[]; skipped: number }> {
    const rows = await readJsonLines<LegacyBookmarkRow>(workspaceFile(cwd, LEGACY_BOOKMARKS_FILE));
    if (rows.length === 0) return { bookmarks: [], skipped: 0 };
    const existing = new Set(state.bookmarks.map((bookmark) => bookmark.bookmark_id));
    const tombstoned = new Set(state.legacy_deleted_ids);
    const merged: ConversationBookmark[] = [];
    const bySession = new Map<string, Promise<Set<string>>>();
    let skipped = 0;
    for (const row of rows) {
      const entries = Array.isArray(row.bookmarks) ? row.bookmarks as LegacyBookmarkEntry[] : [];
      for (const entry of entries) {
        const sessionId = typeof entry.session_id === "string" ? entry.session_id : "";
        const messageId = typeof entry.message_id === "string" ? entry.message_id : "";
        const quote = typeof entry.quote === "string" ? entry.quote : "";
        if (!sessionId || !messageId) {
          skipped += 1;
          continue;
        }
        const id = legacyBookmarkId(sessionId, messageId, quote);
        if (existing.has(id) || merged.some((bookmark) => bookmark.bookmark_id === id)) continue;
        if (tombstoned.has(id)) continue;
        if (!bySession.has(sessionId)) {
          bySession.set(sessionId, this.sessionRepository.messageIndex(cwd, sessionId, "all").then((index) => new Set(index.messages.map((message) => message.id))).catch(() => new Set()));
        }
        const messageIds = await bySession.get(sessionId)!;
        if (!messageIds.has(messageId)) {
          skipped += 1;
          continue;
        }
        const locator = await this.sessionRepository.messageLocator(cwd, sessionId, messageId);
        if (!locator) {
          skipped += 1;
          continue;
        }
        merged.push({
          bookmark_id: id,
          session_id: sessionId,
          message_id: messageId,
          role: locator.role,
          quote: quote.slice(0, MAX_QUOTE),
          label: null,
          origin: "legacy_auto",
          status: "proposed",
          created_at: legacyCreatedAt(row.created_at, id),
          updated_at: legacyCreatedAt(row.created_at, id),
        });
      }
    }
    return { bookmarks: merged, skipped };
  }

  private async withState(cwd: string, operation: (state: ConversationNavigationStateV1) => ConversationNavigationStateV1 | void | Promise<ConversationNavigationStateV1 | void>): Promise<ConversationNavigationStateV1> {
    const path = this.statePath(cwd);
    return withFileWriteLock(path, async () => {
      const state = await this.loadState(cwd);
      const legacy = await this.foldLegacy(cwd, state);
      const merged: ConversationNavigationStateV1 = {
        schema_version: 1,
        bookmarks: [...state.bookmarks, ...legacy.bookmarks],
        read_states: state.read_states,
        legacy_deleted_ids: state.legacy_deleted_ids,
      };
      const result = await operation(merged);
      const next = result ?? merged;
      // Materialize the folded legacy entries (if any) so the next read no
      // longer needs to scan session files for them.
      await writeJsonAtomic(path, next);
      return next;
    });
  }

  // ── Bookmarks ──

  async bookmarks(cwd: string, sessionId?: string): Promise<{ bookmarks: ConversationBookmark[]; legacy_skipped: number }> {
    const state = await this.loadState(cwd);
    const legacy = await this.foldLegacy(cwd, state);
    const merged = [...state.bookmarks, ...legacy.bookmarks];
    const bookmarks = sessionId
      ? merged.filter((bookmark) => bookmark.session_id === sessionId)
      : merged;
    return {
      bookmarks: [...bookmarks].sort((left, right) => right.created_at.localeCompare(left.created_at)),
      legacy_skipped: legacy.skipped,
    };
  }

  /** Create a user bookmark. The quote/role are resolved by Node from the
   *  session JSONL — client-supplied text is never trusted.
   *
   *  Idempotent per (session, message): an existing non-rejected bookmark is
   *  returned unchanged, and a previously rejected bookmark is revived to
   *  accepted — the atomic lock guarantees a double-click can never stack
   *  duplicates. */
  async createBookmark(cwd: string, input: { session_id: string; message_id: string; label?: string | null }): Promise<ConversationBookmark> {
    let created!: ConversationBookmark;
    await this.withState(cwd, async (state) => {
      const existing = state.bookmarks.find((candidate) => candidate.session_id === input.session_id && candidate.message_id === input.message_id);
      if (existing && existing.status !== "rejected") {
        created = existing;
        return;
      }
      const locator = await this.sessionRepository.messageLocator(cwd, input.session_id, input.message_id);
      if (!locator) throw new NavigationError("invalid_anchor", "message does not exist in this session");
      this.enforcePerSessionLimit(state, input.session_id);
      const now = new Date().toISOString();
      // The route contract already rejects labels longer than 160 characters;
      // here we only normalize whitespace/empty values.
      const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : null;
      if (existing) {
        // Revive a rejected bookmark for the same message instead of stacking
        // a duplicate record for the pair.
        existing.status = "accepted";
        existing.origin = "user";
        if (label !== null) existing.label = label;
        existing.updated_at = now;
        created = existing;
        return;
      }
      const bookmark: ConversationBookmark = {
        bookmark_id: randomUUID(),
        session_id: input.session_id,
        message_id: input.message_id,
        role: locator.role,
        quote: locator.text.slice(0, MAX_QUOTE),
        label,
        origin: "user",
        status: "accepted",
        created_at: now,
        updated_at: now,
      };
      state.bookmarks.push(bookmark);
      created = bookmark;
    });
    return created;
  }

  /** Agent/heuristic bookmarks only ever produce proposals; nothing is
   *  auto-accepted. Duplicate session+message entries and dangling message ids
   *  are skipped. */
  async proposeBookmarks(cwd: string, sessionId: string, messageIds: string[]): Promise<{ bookmarks: ConversationBookmark[]; skipped: number }> {
    const proposed: ConversationBookmark[] = [];
    let skipped = 0;
    await this.withState(cwd, async (state) => {
      for (const messageId of messageIds) {
        if (state.bookmarks.some((bookmark) => bookmark.session_id === sessionId && bookmark.message_id === messageId)) {
          skipped += 1;
          continue;
        }
        this.enforcePerSessionLimit(state, sessionId);
        const locator = await this.sessionRepository.messageLocator(cwd, sessionId, messageId);
        if (!locator) {
          skipped += 1;
          continue;
        }
        const now = new Date().toISOString();
        const bookmark: ConversationBookmark = {
          bookmark_id: randomUUID(),
          session_id: sessionId,
          message_id: messageId,
          role: locator.role,
          quote: locator.text.slice(0, MAX_QUOTE),
          label: null,
          origin: "agent_proposal",
          status: "proposed",
          created_at: now,
          updated_at: now,
        };
        state.bookmarks.push(bookmark);
        proposed.push(bookmark);
      }
    });
    return { bookmarks: proposed, skipped };
  }

  async updateBookmarkStatus(cwd: string, bookmarkId: string, status: "accepted" | "rejected"): Promise<ConversationBookmark> {
    return this.withState(cwd, (state) => {
      const bookmark = state.bookmarks.find((candidate) => candidate.bookmark_id === bookmarkId);
      if (!bookmark) throw new NavigationError("not_found", "bookmark not found");
      bookmark.status = status;
      bookmark.updated_at = new Date().toISOString();
    }).then((state) => {
      const bookmark = state.bookmarks.find((candidate) => candidate.bookmark_id === bookmarkId);
      if (!bookmark) throw new NavigationError("not_found", "bookmark not found");
      return bookmark;
    });
  }

  async deleteBookmark(cwd: string, bookmarkId: string): Promise<void> {
    await this.withState(cwd, (state) => {
      const index = state.bookmarks.findIndex((candidate) => candidate.bookmark_id === bookmarkId);
      if (index < 0) throw new NavigationError("not_found", "bookmark not found");
      const [removed] = state.bookmarks.splice(index, 1);
      // Legacy bookmarks live in `bookmarks.jsonl` which is never rewritten
      // (rollback safety). Record a durable tombstone so the fold cannot
      // re-import the deleted row on the next read/write.
      if (removed?.origin === "legacy_auto" && !state.legacy_deleted_ids.includes(removed.bookmark_id)) {
        state.legacy_deleted_ids.push(removed.bookmark_id);
      }
    });
  }

  // ── Read state ──

  async readState(cwd: string, sessionId: string): Promise<ConversationReadState | null> {
    const state = await this.loadState(cwd);
    return state.read_states[sessionId] ?? null;
  }

  /** Update the reading position. `at_bottom=true` with `mark_seen=true`
   *  stores the CURRENT session snapshot version (never client-supplied);
   *  `at_bottom=false` only moves the anchor and never touches the seen
   *  snapshot, so scrolling through history cannot clear the New state. */
  async updateReadState(
    cwd: string,
    sessionId: string,
    update: { anchor_message_id?: string | null; at_bottom?: boolean; mark_seen?: boolean },
  ): Promise<ConversationReadState> {
    return this.withState(cwd, async (state) => {
      const current = state.read_states[sessionId] ?? { session_id: sessionId, anchor_message_id: null, at_bottom: false, seen_snapshot_version: null, updated_at: "" };
      const next: ConversationReadState = { ...current, updated_at: new Date().toISOString() };
      if (update.anchor_message_id !== undefined) {
        if (update.anchor_message_id === null) next.anchor_message_id = null;
        else {
          const locator = await this.sessionRepository.messageLocator(cwd, sessionId, update.anchor_message_id);
          if (!locator) throw new NavigationError("invalid_anchor", "anchor message does not belong to this session");
          next.anchor_message_id = update.anchor_message_id;
        }
      }
      if (update.at_bottom === true) {
        next.at_bottom = true;
        if (update.mark_seen === true) {
          next.seen_snapshot_version = await this.sessionRepository.sessionSnapshotVersion(cwd, sessionId);
        }
      } else if (update.at_bottom === false) {
        next.at_bottom = false;
      }
      state.read_states[sessionId] = next;
    }).then((state) => state.read_states[sessionId]!);
  }

  /** Remove all navigation state belonging to a session (called after a
   *  successful session delete). Legacy tombstones are tolerated: they are
   *  tiny deterministic ids, and once the session file is gone the fold's
   *  message-existence check already prevents any re-import, so a stale
   *  tombstone is inert. */
  async cleanupSession(cwd: string, sessionId: string): Promise<void> {
    await this.withState(cwd, (state) => {
      state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.session_id !== sessionId);
      delete state.read_states[sessionId];
    });
  }

  // ── Helpers ──

  private enforcePerSessionLimit(state: ConversationNavigationStateV1, sessionId: string): void {
    const count = state.bookmarks.filter((bookmark) => bookmark.session_id === sessionId && bookmark.status !== "rejected").length;
    if (count >= MAX_BOOKMARKS_PER_SESSION) {
      throw new NavigationError("limit", `session already has ${MAX_BOOKMARKS_PER_SESSION} bookmarks`);
    }
  }
}
