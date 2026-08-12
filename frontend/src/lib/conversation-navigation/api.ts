/** REST calls for durable conversation navigation (bookmarks, read state,
 *  attention). All endpoints are owned by the Node control plane. */

import { request, responseError } from "../client/http";
import type {
  ConversationAttentionResponse,
  ConversationBookmark,
  ConversationBookmarkListResponse,
  ConversationBookmarkProposeResponse,
  ConversationReadState,
  ConversationReadStateUpdate,
} from "./types";

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function error(data: unknown, fallback: string): Error {
  return new Error(responseError(data, fallback));
}

export async function getBookmarks(baseUrl: string, cwd: string, sessionId?: string): Promise<ConversationBookmarkListResponse> {
  const res = await request(`${baseUrl}/api/bookmarks${query({ cwd, session_id: sessionId })}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Load bookmarks failed: ${res.statusText}`);
  return {
    bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
    legacy_skipped: typeof data.legacy_skipped === "number" ? data.legacy_skipped : 0,
  };
}

export async function createBookmark(baseUrl: string, cwd: string, sessionId: string, messageId: string, label?: string): Promise<ConversationBookmark> {
  const res = await request(`${baseUrl}/api/bookmarks${query({ cwd, session_id: sessionId })}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message_id: messageId, ...(label ? { label } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Create bookmark failed: ${res.statusText}`);
  return data.bookmark as ConversationBookmark;
}

export async function proposeBookmarks(baseUrl: string, cwd: string, sessionId: string): Promise<ConversationBookmarkProposeResponse> {
  const res = await request(`${baseUrl}/api/bookmarks/propose${query({ cwd, session_id: sessionId })}`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Suggest bookmarks failed: ${res.statusText}`);
  return {
    session_id: sessionId,
    bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
    skipped: typeof data.skipped === "number" ? data.skipped : 0,
  };
}

export async function updateBookmarkStatus(baseUrl: string, cwd: string, bookmarkId: string, status: "accepted" | "rejected"): Promise<ConversationBookmark> {
  const res = await request(`${baseUrl}/api/bookmarks/${encodeURIComponent(bookmarkId)}${query({ cwd })}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Update bookmark failed: ${res.statusText}`);
  return data.bookmark as ConversationBookmark;
}

export async function deleteBookmark(baseUrl: string, cwd: string, bookmarkId: string): Promise<void> {
  const res = await request(`${baseUrl}/api/bookmarks/${encodeURIComponent(bookmarkId)}${query({ cwd })}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Delete bookmark failed: ${res.statusText}`);
}

export async function getReadState(baseUrl: string, cwd: string, sessionId: string): Promise<ConversationReadState> {
  const res = await request(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/read-state${query({ cwd })}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Load read state failed: ${res.statusText}`);
  return data as ConversationReadState;
}

export async function updateReadState(baseUrl: string, cwd: string, sessionId: string, update: ConversationReadStateUpdate): Promise<ConversationReadState> {
  const res = await request(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/read-state${query({ cwd })}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Save read state failed: ${res.statusText}`);
  return data as ConversationReadState;
}

export async function getAttention(baseUrl: string, cwd: string, limit?: number): Promise<ConversationAttentionResponse> {
  const res = await request(`${baseUrl}/api/attention${query({ cwd, limit: limit === undefined ? undefined : String(limit) })}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw error(data, `Load attention failed: ${res.statusText}`);
  return {
    items: Array.isArray(data.items) ? data.items : [],
    counts: {
      needs_you: Number(data.counts?.needs_you ?? 0),
      running: Number(data.counts?.running ?? 0),
      unread: Number(data.counts?.unread ?? 0),
    },
    truncated: data.truncated === true,
  };
}
