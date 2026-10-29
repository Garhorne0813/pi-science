/** REST calls against the pi-science control plane. Each function takes the
 *  client's base URL (empty string = relative URLs through the Vite proxy). */

import { request, responseError, RUNTIME_START_TIMEOUT_MS } from "./http";
import { cacheMessages } from "./message-cache";
import type { HistoryMessage, InteractionResponse, PromptRequestStatus, SessionInfo, SessionListPage, SessionMessagePage, SessionState, SessionStats, SessionUserMessageIndex, TurnArtifactTurn } from "./types";
import type { CreateSessionRequest } from "@pi-science/contracts";
import { parseWirePayload } from "./wire-schema";

export async function createSession(baseUrl: string, cwd: string, model?: string, thinking?: string, initialApproval?: CreateSessionRequest["initialApproval"]): Promise<{ id: string; cwd?: string; project_id?: string }> {
  const config = model ? { model, ...(thinking ? { thinking } : {}) } : {};
  const res = await request(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeoutMs: RUNTIME_START_TIMEOUT_MS,
    body: JSON.stringify({
      cwd,
      config,
      ...(initialApproval ? { initialApproval } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Create session failed: ${res.statusText}`));
  }
  const { createSessionResponseSchema } = await import("@pi-science/contracts");
  return parseWirePayload(data, createSessionResponseSchema, "Create session failed");
}

export async function listSessions(baseUrl: string, cwd: string): Promise<SessionInfo[]> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions?${params}`);
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(responseError(data, `List sessions failed: ${res.statusText}`));
  const { sessionInfoSchema } = await import("@pi-science/contracts");
  return parseWirePayload(data, sessionInfoSchema.array(), "List sessions failed").map((session) => ({
    ...session,
    name: session.name ?? undefined,
    created_at: session.created_at ?? undefined,
    updated_at: session.updated_at ?? undefined,
  }));
}

export async function listSessionsPage(
  baseUrl: string,
  cwd: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<SessionListPage> {
  const params = new URLSearchParams({ cwd, limit: String(options.limit ?? 30) });
  if (options.cursor) params.set("cursor", options.cursor);
  const res = await request(`${baseUrl}/api/sessions?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(responseError(data, `List sessions failed: ${res.statusText}`));
  // Accept the pre-pagination shape during rolling upgrades and in older
  // test fixtures; new servers always return the page envelope.
  const normalized = Array.isArray(data)
    ? { sessions: data, next_cursor: null, has_more: false }
    : data;
  const { sessionListPageSchema } = await import("@pi-science/contracts");
  const page = parseWirePayload(normalized, sessionListPageSchema, "List sessions failed");
  return {
    sessions: page.sessions.map((session) => ({
      ...session,
      name: session.name ?? undefined,
      created_at: session.created_at ?? undefined,
      updated_at: session.updated_at ?? undefined,
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  };
}

export async function getMessagesPage(
  baseUrl: string,
  sessionId: string,
  cwd?: string,
  options: { before?: string | null; limit?: number } = {},
): Promise<SessionMessagePage> {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (options.before) params.set("before", options.before);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/messages${query ? `?${query}` : ""}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Load messages failed: ${res.statusText}`));
  }
  const { sessionMessagePageSchema } = await import("@pi-science/contracts");
  const page = parseWirePayload(data, sessionMessagePageSchema, "Load messages failed");
  const messages = page.messages as HistoryMessage[];
  // Persist to the local cache so the next switch to this session can
  // render instantly before the network response arrives.
  if (cwd && !options.before) cacheMessages(cwd, sessionId, messages);
  return { ...page, messages };
}

export async function getMessages(baseUrl: string, sessionId: string, cwd?: string): Promise<HistoryMessage[]> {
  return (await getMessagesPage(baseUrl, sessionId, cwd)).messages;
}

export async function getConversationResumeCursor(baseUrl: string, sessionId: string, cwd: string): Promise<string | null> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/events/cursor?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Load conversation cursor failed: ${res.statusText}`));
  }
  return typeof data.resumeCursor === "string" && data.resumeCursor.length > 0 ? data.resumeCursor : null;
}

export async function getUserMessageIndex(baseUrl: string, sessionId: string, cwd?: string): Promise<SessionUserMessageIndex> {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  const query = params.toString();
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/messages/index${query ? `?${query}` : ""}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Load message index failed: ${res.statusText}`));
  }
  const { sessionUserMessageIndexSchema } = await import("@pi-science/contracts");
  return parseWirePayload(data, sessionUserMessageIndexSchema, "Load message index failed");
}

export async function getTurnArtifacts(baseUrl: string, sessionId: string, cwd?: string): Promise<{ turns: TurnArtifactTurn[] }> {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  const query = params.toString();
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/artifacts${query ? `?${query}` : ""}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Load turn artifacts failed: ${res.statusText}`));
  }
  return { turns: Array.isArray(data.turns) ? data.turns : [] };
}

export async function resumeSession(baseUrl: string, sessionId: string, cwd: string): Promise<void> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/resume?${params}`, {
    method: "POST",
    timeoutMs: RUNTIME_START_TIMEOUT_MS,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Resume session failed: ${res.statusText}`));
  }
}

export async function getSessionState(baseUrl: string, sessionId: string, cwd: string): Promise<SessionState> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/state?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Read session state failed: ${res.statusText}`));
  }
  const { sessionStateSchema } = await import("@pi-science/contracts");
  const state = parseWirePayload(data, sessionStateSchema, "Read session state failed");
  return {
    ...state,
    model: state.model ?? undefined,
    thinking: state.thinking ?? undefined,
  };
}

export async function getSessionStats(baseUrl: string, sessionId: string, cwd: string): Promise<SessionStats> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/stats?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Read session stats failed: ${res.statusText}`));
  }
  const { sessionStatsSchema } = await import("@pi-science/contracts");
  return parseWirePayload(data.stats, sessionStatsSchema, "Read session stats failed");
}

export async function forkSession(baseUrl: string, sessionId: string, cwd: string, entryId?: string): Promise<{ id: string }> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/fork?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeoutMs: RUNTIME_START_TIMEOUT_MS,
    body: JSON.stringify(entryId ? { entry_id: entryId } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Fork session failed: ${res.statusText}`));
  }
  return { id: data.id };
}

export async function sendPrompt(baseUrl: string, sessionId: string, message: string, clientMessageId: string, cwd?: string): Promise<PromptRequestStatus> {
  const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/prompt${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, client_message_id: clientMessageId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const error = new Error(responseError(data, `Send prompt failed: ${res.statusText}`)) as Error & {
      code?: string;
      status?: number;
      deliveryState?: PromptRequestStatus["status"];
    };
    error.code = typeof data.code === "string" ? data.code : undefined;
    error.status = res.status;
    if (["pending", "accepted", "persisted", "rejected", "indeterminate"].includes(data.status)) {
      error.deliveryState = data.status as PromptRequestStatus["status"];
    }
    throw error;
  }
  const states = new Set(["pending", "accepted", "persisted", "rejected", "indeterminate"]);
  return {
    status: states.has(data.status) ? data.status as PromptRequestStatus["status"] : "accepted",
    client_message_id: typeof data.client_message_id === "string" ? data.client_message_id : clientMessageId,
    ...(typeof data.durable_message_id === "string" ? { durable_message_id: data.durable_message_id } : {}),
    ...(typeof data.error_code === "string" ? { error_code: data.error_code } : {}),
  };
}

export async function getPromptRequestStatus(baseUrl: string, sessionId: string, clientMessageId: string, cwd?: string): Promise<PromptRequestStatus> {
  const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/prompt-requests/${clientMessageId}${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const error = new Error(responseError(data, `Read prompt status failed: ${res.statusText}`)) as Error & { code?: string; status?: number };
    error.code = typeof data.code === "string" ? data.code : undefined;
    error.status = res.status;
    throw error;
  }
  const states = new Set(["pending", "accepted", "persisted", "rejected", "indeterminate"]);
  if (!states.has(data.status) || data.client_message_id !== clientMessageId) {
    throw new Error("Read prompt status failed: invalid response payload");
  }
  return {
    status: data.status as PromptRequestStatus["status"],
    client_message_id: clientMessageId,
    ...(typeof data.durable_message_id === "string" ? { durable_message_id: data.durable_message_id } : {}),
    ...(typeof data.error_code === "string" ? { error_code: data.error_code } : {}),
  };
}

export async function setModel(
  baseUrl: string,
  sessionId: string,
  model: string,
  cwd?: string,
  thinking?: string,
): Promise<{ id?: string; restarted: boolean; replacedBlank?: boolean; model?: string; thinking?: string }> {
  const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/model${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, thinking }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Set model failed: ${res.statusText}`));
  }
  return {
    id: data.id,
    restarted: data.restarted === true,
    replacedBlank: data.replaced_blank === true,
    model: data.model,
    thinking: data.thinking,
  };
}

export async function abort(baseUrl: string, sessionId: string, cwd?: string): Promise<void> {
  const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/abort${params}`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const error = new Error(responseError(data, `Abort failed: ${res.statusText}`)) as Error & {
      code?: string;
      status?: number;
    };
    error.code = typeof data.code === "string" ? data.code : undefined;
    error.status = res.status;
    throw error;
  }
}

export async function deleteSession(baseUrl: string, sessionId: string, cwd?: string): Promise<void> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}${params}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Delete session failed: ${res.statusText}`));
  }
}

/** How a title write treats a title that is already stored. `initialize` is the
 *  client's first name for a session, derived from its first message, and fills
 *  an empty slot only. `override` is the user typing a name and always wins. */
export type SessionTitleWriteMode = "initialize" | "override";

/** The title stored after the write, which is the caller's own unless
 *  `initialize` found the session already named. */
export interface SessionTitleWrite {
  applied: boolean;
  title: string;
}

export async function setSessionTitle(
  baseUrl: string,
  sessionId: string,
  title: string,
  cwd?: string,
  mode: SessionTitleWriteMode = "override",
): Promise<SessionTitleWrite> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/title${params}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Set session title failed: ${res.statusText}`));
  }
  return {
    applied: data.applied !== false,
    title: typeof data.title === "string" && data.title ? data.title : title,
  };
}

export async function respondToInteraction(
  baseUrl: string,
  sessionId: string,
  requestId: string,
  response: InteractionResponse,
  cwd?: string,
): Promise<void> {
  const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const res = await request(
    `${baseUrl}/api/sessions/${sessionId}/interactions/${encodeURIComponent(requestId)}${params}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
      timeoutMs: 15_000,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Interaction response failed: ${res.statusText}`));
  }
}

/** What the control plane did with a title request. A request the server
 *  cancelled (`superseded` by a newer request, `deleted` with its session) is
 *  not a model failure and must not surface as one. */
export type TitleGenerationResult =
  | { status: "applied"; title: string }
  | { status: "superseded" }
  | { status: "deleted" }
  | { status: "failed" };

/** Ask the control plane to generate an AI title for a session (Pi runtime).
 *  `manual` records who asked: the server only guards a running session for a
 *  user-requested regenerate, because the settled-turn trigger fires while the
 *  live table may still report busy. */
export async function generateSessionTitle(baseUrl: string, sessionId: string, cwd: string, manual: boolean): Promise<TitleGenerationResult> {
  const res = await request(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/title?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manual }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) return { status: "failed" };
  if (typeof data.title === "string" && data.title) return { status: "applied", title: data.title };
  if (data.deleted === true) return { status: "deleted" };
  if (data.superseded === true) return { status: "superseded" };
  return { status: "failed" };
}
