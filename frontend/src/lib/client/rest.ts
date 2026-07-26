/** REST calls against the pi-science control plane. Each function takes the
 *  client's base URL (empty string = relative URLs through the Vite proxy). */

import { request, responseError } from "./http";
import { cacheMessages } from "./message-cache";
import type { HistoryMessage, InteractionResponse, SessionInfo, SessionState } from "./types";

export async function createSession(baseUrl: string, cwd: string, model?: string): Promise<{ id: string }> {
  const config = model ? { model } : {};
  const res = await request(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      config,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Create session failed: ${res.statusText}`));
  }
  return data;
}

export async function listSessions(baseUrl: string, cwd: string): Promise<SessionInfo[]> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions?${params}`);
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(responseError(data, `List sessions failed: ${res.statusText}`));
  return Array.isArray(data) ? data : [];
}

export async function getMessages(baseUrl: string, sessionId: string, cwd?: string): Promise<HistoryMessage[]> {
  const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/messages${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(responseError(data, `Load messages failed: ${res.statusText}`));
  }
  const messages = data.messages ?? [];
  // Persist to the local cache so the next switch to this session can
  // render instantly before the network response arrives.
  if (cwd) cacheMessages(cwd, sessionId, messages);
  return messages;
}

export async function resumeSession(baseUrl: string, sessionId: string, cwd: string): Promise<void> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/resume?${params}`, {
    method: "POST",
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
  return data as SessionState;
}

export async function forkSession(baseUrl: string, sessionId: string, cwd: string, entryId?: string): Promise<{ id: string }> {
  const params = new URLSearchParams({ cwd });
  const res = await request(`${baseUrl}/api/sessions/${sessionId}/fork?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
