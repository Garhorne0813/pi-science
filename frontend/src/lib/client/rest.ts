/** REST calls against the pi-science control plane. Each function takes the
 *  client's base URL (empty string = relative URLs through the Vite proxy). */

import { request, responseError, RUNTIME_START_TIMEOUT_MS } from "./http";
import { cacheMessages } from "./message-cache";
import type { HistoryMessage, InteractionResponse, SessionInfo, SessionMessagePage, SessionState, SessionStats, SessionUserMessageIndex, TurnArtifactTurn } from "./types";
import { parseWirePayload } from "./wire-schema";

export async function createSession(baseUrl: string, cwd: string, model?: string): Promise<{ id: string; cwd?: string; project_id?: string }> {
  const config = model ? { model } : {};
  const res = await request(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeoutMs: RUNTIME_START_TIMEOUT_MS,
    body: JSON.stringify({
      cwd,
      config,
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

export async function sendPrompt(baseUrl: string, sessionId: string, message: string, cwd?: string): Promise<void> {
  const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/prompt${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const error = new Error(responseError(data, `Send prompt failed: ${res.statusText}`)) as Error & {
      code?: string;
      status?: number;
    };
    error.code = typeof data.code === "string" ? data.code : undefined;
    error.status = res.status;
    throw error;
  }
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
    throw new Error(responseError(data, `Abort failed: ${res.statusText}`));
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

export async function setSessionTitle(baseUrl: string, sessionId: string, title: string, cwd?: string, options?: { derived?: boolean }): Promise<void> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/title${params}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    // A derived fallback must be marked as such on the server, otherwise the
    // AI-title POST would treat it as final and never replace it.
    body: JSON.stringify(options?.derived === true ? { title, derived: true } : { title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Set session title failed: ${res.statusText}`));
  }
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
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Interaction response failed: ${res.statusText}`));
  }
}

/** Ask the control plane to generate an AI title for a session (Pi runtime). */
export async function generateSessionTitle(baseUrl: string, sessionId: string, cwd: string): Promise<string | null> {
  const res = await request(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/title?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    return null;
  }
  return typeof data.title === "string" && data.title ? data.title : null;
}
