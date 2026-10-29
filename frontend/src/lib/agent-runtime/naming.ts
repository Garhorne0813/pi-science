/** Session display naming: derive a name from the conversation and keep the
 *  sidebar entry in sync with the stored one. */

import type { ThreadBlock } from "../../types/thread";
import { cacheSessionName, deriveSessionName, getClient, getSessionName, normalizeSessionTitle, noteManualTitleWrite, setSessionName, titleWriteEpoch } from "../client/pi-science-client";
import { setSessionTitle, type TitleGenerationResult } from "../client/rest";
import { clearAiTitleAttempted, hasAiTitle, markAiTitle } from "../client/session-names";
import { visibleUserMessage } from "../files";
import type { Thread } from "./folding/types";
import { runtimeStore } from "./store-access";

/** The list shows this placeholder until a session has a real name. */
const UNNAMED_SESSION = "New Session";

/** A name already present locally, or loaded from the control plane, wins over
 *  a derived one. Empty localStorage does not mean the session is unnamed: the
 *  user may have named it in another browser, and the list already carries that
 *  title. */
function alreadyNamed(cwd: string, sessionId: string): boolean {
  if (getSessionName(cwd, sessionId)) return true;
  const loaded = runtimeStore.getState().sessions.find((session) => session.id === sessionId && session.cwd === cwd)?.name;
  return Boolean(loaded) && loaded !== UNNAMED_SESSION;
}

/** Backfill a display name from the first user block of freshly loaded
 *  history. Sessions created before client-side naming existed (or whose
 *  localStorage entry is missing) would otherwise show raw ids in the sidebar
 *  forever. Never overwrites a stored name and no-ops on empty threads. */
export function backfillSessionName(cwd: string, sessionId: string, thread: Thread): void {
  if (alreadyNamed(cwd, sessionId)) return;
  const firstUser = thread.blocks.find(
    (block): block is Extract<ThreadBlock, { kind: "user" }> => block.kind === "user",
  );
  const name = firstUser ? deriveSessionName(visibleUserMessage(firstUser.text)) : "";
  if (!name) return;
  setSessionName(cwd, sessionId, name, (stored) => applyNameToStore(cwd, sessionId, stored));
  runtimeStore.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name } : session),
  }));
}

/** Use the first user message as the session name. A message that is only
 *  file references still gets a stable fallback label. */
export function applyPromptSessionName(cwd: string, sessionId: string, message: string): void {
  if (alreadyNamed(cwd, sessionId)) return;
  const sessionName = deriveSessionName(visibleUserMessage(message)) || "Referenced files";
  setSessionName(cwd, sessionId, sessionName, (stored) => applyNameToStore(cwd, sessionId, stored));
  runtimeStore.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name: sessionName } : session),
  }));
}

/** Where a title came from. The source decides whether an existing title may be
 *  replaced, so call sites read as "automatic" or "the user asked". */
export type AiTitleSource = "automatic" | "manual";

export type AiTitleResult = "applied" | "superseded" | "failed" | "gone";

/** Update the sidebar row only while it belongs to the workspace the title was
 *  written for; a workspace switch must not relabel another project's list. */
function applyNameToStore(cwd: string, sessionId: string, name: string): void {
  const state = runtimeStore.getState();
  if (state.cwd !== cwd) return;
  runtimeStore.setState({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name } : session),
  });
}

/** Apply an AI-generated title and mark the session so later settle events do
 *  not regenerate it. An automatic result is dropped when a title already
 *  exists; a manual request deliberately replaces it. Re-checking the marker
 *  keeps a concurrent automatic generation from overwriting the in-flight
 *  window. The title is already persisted server-side, so this only caches. */
export function applyAiSessionName(cwd: string, sessionId: string, title: string, source: AiTitleSource = "automatic"): void {
  if (source === "automatic" && hasAiTitle(cwd, sessionId)) return;
  cacheSessionName(cwd, sessionId, title);
  markAiTitle(cwd, sessionId);
  clearAiTitleAttempted(cwd, sessionId);
  applyNameToStore(cwd, sessionId, title);
}

/** Generate a title and apply it unless a manual save landed after the request started. */
export async function regenerateSessionTitle(cwd: string, sessionId: string, source: AiTitleSource): Promise<AiTitleResult> {
  const epoch = titleWriteEpoch(cwd, sessionId);
  let generated: TitleGenerationResult;
  try {
    generated = await getClient().generateSessionTitle(sessionId, cwd, source === "manual");
  } catch {
    return "failed";
  }
  // A request the server cancelled is a normal ending, not a model failure: the
  // session was deleted, or a newer title request or rename won. Only a real
  // failure may reach the user as an error.
  if (generated.status === "deleted") return "gone";
  if (generated.status !== "applied") return generated.status;
  const title = generated.title;
  // Only a manual request proves the session was in the list when it started.
  // The automatic path runs off a turn event, where the list may simply not
  // have loaded it yet, and dropping there would change when auto titles land.
  if (source === "manual" && !runtimeStore.getState().sessions.some((session) => session.id === sessionId && session.cwd === cwd)) return "gone";
  // Server-side compare-and-set already refused the stale write; this drops the
  // stale response so the list never shows a title the store no longer holds.
  if (titleWriteEpoch(cwd, sessionId) !== epoch) return "superseded";
  applyAiSessionName(cwd, sessionId, title, source);
  return "applied";
}

/** Persist a user-typed title. Local state changes only after the server confirms. */
export async function renameSession(cwd: string, sessionId: string, title: string): Promise<void> {
  const normalized = normalizeSessionTitle(title);
  if (!normalized) throw new Error("Session title is empty");
  await setSessionTitle("", sessionId, normalized, cwd, "override");
  cacheSessionName(cwd, sessionId, normalized);
  markAiTitle(cwd, sessionId);
  noteManualTitleWrite(cwd, sessionId);
  applyNameToStore(cwd, sessionId, normalized);
}
