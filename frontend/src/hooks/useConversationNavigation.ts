import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "../lib/client/query-client";
import { navigationApi } from "../lib/conversation-navigation";
import type { ConversationReadStateUpdate } from "../lib/conversation-navigation";

const BASE_URL = "";

export function conversationNavigationKey(scope: string, cwd: string, sessionId?: string | null): Array<string | null> {
  return ["conversation-navigation", scope, cwd, sessionId ?? null];
}

export function conversationAttentionKey(cwd: string): Array<string | null> {
  return ["conversation-navigation", "attention", cwd];
}

function invalidateNavigation(cwd: string, sessionId: string | undefined): void {
  void queryClient.invalidateQueries({ queryKey: conversationNavigationKey("bookmarks", cwd, sessionId) });
  void queryClient.invalidateQueries({ queryKey: conversationNavigationKey("read-state", cwd, sessionId) });
  void queryClient.invalidateQueries({ queryKey: conversationAttentionKey(cwd) });
}

/** Bookmarks + read state + debounced read-position writes for one session.
 *  All queries degrade to empty data on failure so navigation features never
 *  block the conversation itself. */
export function useConversationNavigation(cwd: string, sessionId: string | undefined) {
  const enabled = Boolean(sessionId);

  const bookmarksQuery = useQuery({
    queryKey: conversationNavigationKey("bookmarks", cwd, sessionId),
    queryFn: async () => {
      try { return await navigationApi.getBookmarks(BASE_URL, cwd, sessionId); }
      catch { return { bookmarks: [], legacy_skipped: 0 }; }
    },
    enabled,
    staleTime: 30_000,
  }, queryClient);

  const readStateQuery = useQuery({
    queryKey: conversationNavigationKey("read-state", cwd, sessionId),
    queryFn: async () => {
      try { return await navigationApi.getReadState(BASE_URL, cwd, sessionId!); }
      catch { return null; }
    },
    enabled,
    staleTime: 30_000,
  }, queryClient);

  const invalidate = useCallback(() => invalidateNavigation(cwd, sessionId), [cwd, sessionId]);
  const createBookmarkMutation = useMutation({
    mutationFn: (input: { sessionId: string; messageId: string; label?: string }) => navigationApi.createBookmark(BASE_URL, cwd, input.sessionId, input.messageId, input.label),
    onSuccess: invalidate,
  }, queryClient);

  const acceptBookmarkMutation = useMutation({
    mutationFn: (bookmarkId: string) => navigationApi.updateBookmarkStatus(BASE_URL, cwd, bookmarkId, "accepted"),
    onSuccess: invalidate,
  }, queryClient);

  const rejectBookmarkMutation = useMutation({
    mutationFn: (bookmarkId: string) => navigationApi.updateBookmarkStatus(BASE_URL, cwd, bookmarkId, "rejected"),
    onSuccess: invalidate,
  }, queryClient);

  const deleteBookmarkMutation = useMutation({
    mutationFn: (bookmarkId: string) => navigationApi.deleteBookmark(BASE_URL, cwd, bookmarkId),
    onSuccess: invalidate,
  }, queryClient);

  const proposeMutation = useMutation({
    mutationFn: (targetSessionId: string) => navigationApi.proposeBookmarks(BASE_URL, cwd, targetSessionId),
    onSuccess: invalidate,
  }, queryClient);

  // ── Read-position writes (debounced, deduplicated, session-scoped) ──
  // Anchor and seen writes use SEPARATE timers. Scheduling one kind cancels
  // the other (the newest user action wins) and resets the other kind's dedup
  // ref, so a cancelled write cannot poison later dedup for the same value.

  const anchorTimerRef = useRef<number | null>(null);
  const seenTimerRef = useRef<number | null>(null);
  const lastAnchorRef = useRef<string | null>(null);
  const lastSeenRef = useRef<string | null>(null);

  const cancelPendingWrites = useCallback(() => {
    if (anchorTimerRef.current !== null) {
      window.clearTimeout(anchorTimerRef.current);
      anchorTimerRef.current = null;
    }
    if (seenTimerRef.current !== null) {
      window.clearTimeout(seenTimerRef.current);
      seenTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // A session switch must never write a stale position for the previous
    // session; cancel any in-flight debounced write and reset dedup state.
    lastAnchorRef.current = null;
    lastSeenRef.current = null;
    cancelPendingWrites();
  }, [sessionId, cwd, cancelPendingWrites]);

  // Unmount cleanup: never fire a debounced write after the hook is gone.
  useEffect(() => cancelPendingWrites, [cancelPendingWrites]);

  const writeReadState = useCallback(async (update: ConversationReadStateUpdate) => {
    if (!sessionId) return;
    try {
      await navigationApi.updateReadState(BASE_URL, cwd, sessionId, update);
      void queryClient.invalidateQueries({ queryKey: conversationNavigationKey("read-state", cwd, sessionId) });
      void queryClient.invalidateQueries({ queryKey: conversationAttentionKey(cwd) });
    } catch {
      // Read-position persistence is best-effort: a failed write must never
      // interrupt reading or scrolling.
    }
  }, [cwd, sessionId]);

  /** Move the reading anchor to a user message (debounced; only fires when
   *  the anchor actually changes). Cancels any pending seen write and resets
   *  its dedup ref so a later mark-seen for the same snapshot still fires. */
  const scheduleAnchorWrite = useCallback((anchorMessageId: string) => {
    if (!sessionId || anchorMessageId === lastAnchorRef.current) return;
    lastAnchorRef.current = anchorMessageId;
    if (seenTimerRef.current !== null) {
      window.clearTimeout(seenTimerRef.current);
      seenTimerRef.current = null;
      lastSeenRef.current = null;
    }
    if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = window.setTimeout(() => {
      anchorTimerRef.current = null;
      void writeReadState({ anchor_message_id: anchorMessageId, at_bottom: false, mark_seen: false });
    }, 400);
  }, [sessionId, writeReadState]);

  /** Mark the current snapshot as seen (only when the snapshot actually
   *  changed since the last seen write). Cancels any pending anchor write and
   *  resets its dedup ref so a later anchor write for the same message fires. */
  const scheduleMarkSeen = useCallback((snapshotVersion: string) => {
    if (!sessionId || snapshotVersion === lastSeenRef.current) return;
    lastSeenRef.current = snapshotVersion;
    if (anchorTimerRef.current !== null) {
      window.clearTimeout(anchorTimerRef.current);
      anchorTimerRef.current = null;
      lastAnchorRef.current = null;
    }
    if (seenTimerRef.current !== null) window.clearTimeout(seenTimerRef.current);
    seenTimerRef.current = window.setTimeout(() => {
      seenTimerRef.current = null;
      void writeReadState({ at_bottom: true, mark_seen: true });
    }, 300);
  }, [sessionId, writeReadState]);

  // Pending-create guard: a double-click on a message toggle must not fire
  // two POSTs (the server is idempotent, but the guard avoids the redundant
  // network call and the flicker between optimistic states).
  const creatingMessagesRef = useRef<Set<string>>(new Set());

  const createBookmark = useCallback((messageId: string, label?: string) => {
    if (!sessionId) return;
    if (creatingMessagesRef.current.has(messageId)) return;
    creatingMessagesRef.current.add(messageId);
    void createBookmarkMutation.mutateAsync({ sessionId, messageId, label })
      .catch(() => undefined)
      .finally(() => { creatingMessagesRef.current.delete(messageId); });
  }, [sessionId, createBookmarkMutation.mutateAsync]);

  const acceptBookmark = useCallback((bookmarkId: string) => {
    void acceptBookmarkMutation.mutateAsync(bookmarkId).catch(() => undefined);
  }, [acceptBookmarkMutation.mutateAsync]);

  const rejectBookmark = useCallback((bookmarkId: string) => {
    void rejectBookmarkMutation.mutateAsync(bookmarkId).catch(() => undefined);
  }, [rejectBookmarkMutation.mutateAsync]);

  const deleteBookmark = useCallback((bookmarkId: string) => {
    void deleteBookmarkMutation.mutateAsync(bookmarkId).catch(() => undefined);
  }, [deleteBookmarkMutation.mutateAsync]);

  const proposeBookmarks = useCallback(() => {
    if (!sessionId) return;
    void proposeMutation.mutateAsync(sessionId).catch(() => undefined);
  }, [sessionId, proposeMutation.mutateAsync]);

  return useMemo(() => ({
    bookmarks: bookmarksQuery.data?.bookmarks ?? [],
    bookmarksLoading: bookmarksQuery.isLoading,
    readState: readStateQuery.data ?? null,
    readStateLoading: readStateQuery.isLoading,
    createBookmark,
    acceptBookmark,
    rejectBookmark,
    deleteBookmark,
    proposeBookmarks,
    scheduleAnchorWrite,
    scheduleMarkSeen,
    cancelPendingWrites,
  }), [bookmarksQuery.data, bookmarksQuery.isLoading, readStateQuery.data, readStateQuery.isLoading, createBookmark, acceptBookmark, rejectBookmark, deleteBookmark, proposeBookmarks, scheduleAnchorWrite, scheduleMarkSeen, cancelPendingWrites]);
}

/** Attention queue for the workspace sidebar. Fails soft: the session list
 *  must render even when the attention endpoint is unavailable. */
export function useConversationAttention(cwd: string | null) {
  const query = useQuery({
    queryKey: conversationAttentionKey(cwd ?? ""),
    queryFn: async () => {
      if (!cwd) return { items: [], counts: { needs_you: 0, running: 0, unread: 0 }, truncated: false };
      try { return await navigationApi.getAttention(BASE_URL, cwd, 100); }
      catch { return { items: [], counts: { needs_you: 0, running: 0, unread: 0 }, truncated: false }; }
    },
    enabled: Boolean(cwd),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  }, queryClient);

  return useMemo(() => ({
    items: query.data?.items ?? [],
    counts: query.data?.counts ?? { needs_you: 0, running: 0, unread: 0 },
    truncated: query.data?.truncated ?? false,
  }), [query.data]);
}
