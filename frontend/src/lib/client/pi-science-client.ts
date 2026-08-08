/** PiScienceClient — HTTP+SSE client for the pi-science backend.
 *  Replaces open-science's OpenCodeClient.
 *
 *  The implementation lives in this folder: REST calls (rest.ts), the SSE
 *  transport (sse-transport.ts), the session-name registry (session-names.ts)
 *  and the message cache (message-cache.ts). This module composes them into
 *  the client class and re-exports the public surface unchanged. */

import { clearCachedMessages, readCachedMessages } from "./message-cache";
import * as rest from "./rest";
import { clearAiTitle, clearAiTitleAttempted, clearSessionName } from "./session-names";
import { SseTransport } from "./sse-transport";
import type { HistoryMessage, InteractionResponse, PiScienceEvent, SessionInfo, SessionMessagePage, SessionState, SessionUserMessageIndex, TurnArtifactTurn } from "./types";

export type {
  AvailableModel,
  HistoryMessage,
  InteractionResponse,
  PiScienceEvent,
  SessionInfo,
  SessionMessagePage,
  SessionState,
  SessionUserMessageIndex,
  TurnArtifactTurn,
} from "./types";
export { clampThinkingLevel, conversationModelOptions } from "./models";
export { aiTitleAttemptedAt, clearAiTitle, clearAiTitleAttempted, clearSessionName, deriveSessionName, getSessionName, hasAiTitle, markAiTitle, markAiTitleAttempted, moveSessionName, setSessionName } from "./session-names";
export { clearCachedMessages } from "./message-cache";

// ── Client ──

export class PiScienceClient {
  private baseUrl: string;
  private transport: SseTransport;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;  // Empty = use relative URLs (goes through Vite proxy in dev)
    this.transport = new SseTransport(baseUrl);
  }

  get isConnected(): boolean {
    return this.transport.isConnected;
  }

  get connectedSessionId(): string | null {
    return this.transport.connectedSessionId;
  }

  isConnectedTo(sessionId: string, cwd?: string): boolean {
    return this.transport.isConnectedTo(sessionId, cwd);
  }

  isOpenTo(sessionId: string, cwd?: string): boolean {
    return this.transport.isOpenTo(sessionId, cwd);
  }

  // ── REST ──

  async createSession(cwd: string, model?: string): Promise<{ id: string; cwd?: string; project_id?: string }> {
    return rest.createSession(this.baseUrl, cwd, model);
  }

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    return rest.listSessions(this.baseUrl, cwd);
  }

  async getMessages(sessionId: string, cwd?: string): Promise<HistoryMessage[]> {
    return rest.getMessages(this.baseUrl, sessionId, cwd);
  }

  async getMessagesPage(
    sessionId: string,
    cwd?: string,
    options: { before?: string | null; limit?: number } = {},
  ): Promise<SessionMessagePage> {
    return rest.getMessagesPage(this.baseUrl, sessionId, cwd, options);
  }

  async getUserMessageIndex(sessionId: string, cwd?: string): Promise<SessionUserMessageIndex> {
    return rest.getUserMessageIndex(this.baseUrl, sessionId, cwd);
  }

  async getTurnArtifacts(sessionId: string, cwd?: string): Promise<{ turns: TurnArtifactTurn[] }> {
    return rest.getTurnArtifacts(this.baseUrl, sessionId, cwd);
  }

  /** Return the most recently cached message snapshot for a session, or null.
   *  Used to render the conversation instantly on switch before the network
   *  response arrives. */
  getCachedMessages(sessionId: string, cwd?: string): HistoryMessage[] | null {
    if (!cwd) return null;
    return readCachedMessages(cwd, sessionId);
  }

  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    return rest.resumeSession(this.baseUrl, sessionId, cwd);
  }

  async getSessionState(sessionId: string, cwd: string): Promise<SessionState> {
    return rest.getSessionState(this.baseUrl, sessionId, cwd);
  }

  async forkSession(sessionId: string, cwd: string, entryId?: string): Promise<{ id: string }> {
    return rest.forkSession(this.baseUrl, sessionId, cwd, entryId);
  }

  async sendPrompt(sessionId: string, message: string, cwd?: string): Promise<void> {
    return rest.sendPrompt(this.baseUrl, sessionId, message, cwd);
  }

  async setModel(
    sessionId: string,
    model: string,
    cwd?: string,
    thinking?: string,
  ): Promise<{ id?: string; restarted: boolean; replacedBlank?: boolean; model?: string; thinking?: string }> {
    return rest.setModel(this.baseUrl, sessionId, model, cwd, thinking);
  }

  async abort(sessionId: string, cwd?: string): Promise<void> {
    return rest.abort(this.baseUrl, sessionId, cwd);
  }

  /** Persist a session display title on the server (best-effort; the
   *  localStorage registry remains the immediate/fallback source). */
  async setSessionTitle(sessionId: string, title: string, cwd?: string): Promise<void> {
    await rest.setSessionTitle(this.baseUrl, sessionId, title, cwd);
  }

  async deleteSession(sessionId: string, cwd?: string): Promise<void> {
    await rest.deleteSession(this.baseUrl, sessionId, cwd);
    if (cwd) {
      this.transport.clearCursor(cwd, sessionId);
      clearCachedMessages(cwd, sessionId);
      clearSessionName(cwd, sessionId);
      clearAiTitle(cwd, sessionId);
      clearAiTitleAttempted(cwd, sessionId);
    }
  }

  /** Remove the SSE resume cursor for a session (e.g. after it is replaced or
   *  detected missing) so a later connect() does a full replay rather than
   *  resuming from a cursor that no longer belongs to this session. */
  clearCursor(cwd: string, sessionId: string): void {
    this.transport.clearCursor(cwd, sessionId);
  }

  async respondToInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
    cwd?: string,
  ): Promise<void> {
    return rest.respondToInteraction(this.baseUrl, sessionId, requestId, response, cwd);
  }

  /** Ask the control plane to generate an AI title via an isolated Pi runtime. */
  async generateSessionTitle(sessionId: string, cwd: string): Promise<string | null> {
    return rest.generateSessionTitle(this.baseUrl, sessionId, cwd);
  }

  // ── SSE ──

  connect(sessionId: string, cwd?: string): void {
    this.transport.connect(sessionId, cwd);
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  onEvent(fn: (event: PiScienceEvent) => void): () => void {
    return this.transport.onEvent(fn);
  }
}

// ── Singleton ──

let clientInstance: PiScienceClient | null = null;

export function getClient(): PiScienceClient {
  if (!clientInstance) {
    clientInstance = new PiScienceClient();
  }
  return clientInstance;
}

export function createClient(baseUrl: string): PiScienceClient {
  clientInstance = new PiScienceClient(baseUrl);
  return clientInstance;
}
