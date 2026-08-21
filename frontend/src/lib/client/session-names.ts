/** Session display-name registry (localStorage). */

import { sessionKey } from "./session-key";

const NAME_KEY = "pi-science.session-names";
const DERIVED_NAME_KEY = "pi-science.session-names-derived";

function loadNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NAME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function saveNames(names: Record<string, string>) {
  try {
    localStorage.setItem(NAME_KEY, JSON.stringify(names));
  } catch {
    // Session naming is optional metadata; storage failures must never prevent
    // the actual prompt from being sent.
  }
}

function loadDerivedNames(): Record<string, true> {
  try {
    const raw = localStorage.getItem(DERIVED_NAME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, true>;
    return {};
  } catch {
    return {};
  }
}

function saveDerivedNames(names: Record<string, true>): void {
  try {
    localStorage.setItem(DERIVED_NAME_KEY, JSON.stringify(names));
  } catch {
    // Derived-name metadata is optional and must never block the session.
  }
}

/** True when the display name is a temporary derivation from the first user
 *  message and may still be replaced by the AI title generator. */
export function hasDerivedSessionName(cwd: string, sessionId: string): boolean {
  return loadDerivedNames()[sessionKey(cwd, sessionId)] === true;
}

export function markDerivedSessionName(cwd: string, sessionId: string): void {
  const names = loadDerivedNames();
  names[sessionKey(cwd, sessionId)] = true;
  saveDerivedNames(names);
}

export function clearDerivedSessionName(cwd: string, sessionId: string): void {
  const names = loadDerivedNames();
  const key = sessionKey(cwd, sessionId);
  if (names[key] === undefined) return;
  delete names[key];
  saveDerivedNames(names);
}

/** Read the display name for a session. On first read it migrates the v2
 *  single-key format (`names[sessionId]`) to the composite `(cwd, sessionId)`
 *  key, so upgrading does not silently drop every existing custom name.
 *  Corrupt values (objects, numbers, ...) are discarded and treated as "no
 *  name" so they can never be rendered as a React child. Always returns a
 *  string. */
function readName(cwd: string, sessionId: string): string {
  const names = loadNames();
  const compositeKey = sessionKey(cwd, sessionId);
  const composite = names[compositeKey];
  let changed = false;
  if (typeof composite === "string") return composite;
  if (composite !== undefined) {
    delete names[compositeKey];
    changed = true;
  }
  const legacy = names[sessionId];
  if (typeof legacy === "string") {
    names[compositeKey] = legacy;
    delete names[sessionId];
    saveNames(names);
    return legacy;
  }
  if (legacy !== undefined) {
    delete names[sessionId];
    changed = true;
  }
  if (changed) saveNames(names);
  return "";
}

/** Session names are scoped by (cwd, sessionId) so that two workspaces that
 *  happen to share a session id do not collide on a single global name. */
export function getSessionName(cwd: string, sessionId: string): string {
  const value = readName(cwd, sessionId);
  return typeof value === "string" ? value : "";
}

export function setLocalSessionName(cwd: string, sessionId: string, name: string): void {
  const names = loadNames();
  names[sessionKey(cwd, sessionId)] = name.slice(0, 50);  // Cap length
  saveNames(names);
}

export function setSessionName(cwd: string, sessionId: string, name: string): void {
  clearDerivedSessionName(cwd, sessionId);
  setLocalSessionName(cwd, sessionId, name);
  // Best-effort server persistence (fire-and-forget): the localStorage
  // registry stays the immediate source and the fallback when the control
  // plane is unreachable, so naming never blocks the prompt path.
  void import("./pi-science-client").then(({ getClient }) => {
    void getClient().setSessionTitle(sessionId, name.slice(0, 100), cwd).catch(() => undefined);
  });
}

/** Remove the display name for a session (e.g. after deletion or when a
 *  missing session is recovered) so it cannot resurface on a reused id or
 *  linger in local storage as accumulated project metadata. */
export function clearSessionName(cwd: string, sessionId: string): void {
  const names = loadNames();
  const compositeKey = sessionKey(cwd, sessionId);
  let changed = false;
  if (names[compositeKey] !== undefined) {
    delete names[compositeKey];
    changed = true;
  }
  // Also clear any v2-era bare sessionId key that may still be present.
  if (names[sessionId] !== undefined) {
    delete names[sessionId];
    changed = true;
  }
  if (changed) saveNames(names);
  clearDerivedSessionName(cwd, sessionId);
}

export function moveSessionName(cwd: string, previousSessionId: string, nextSessionId: string): string {
  if (!cwd || !previousSessionId || !nextSessionId || previousSessionId === nextSessionId) {
    return getSessionName(cwd, nextSessionId || previousSessionId);
  }
  const previousKey = sessionKey(cwd, previousSessionId);
  const nextKey = sessionKey(cwd, nextSessionId);
  // readName may migrate a legacy key and persists a separately loaded map;
  // reload after it so that migration cannot be overwritten by this save.
  const previousName = getSessionName(cwd, previousSessionId);
  const names = loadNames();
  const existingNext = typeof names[nextKey] === "string" ? names[nextKey] : "";
  if (!existingNext && previousName) names[nextKey] = previousName;
  delete names[previousKey];
  delete names[previousSessionId];
  saveNames(names);
  // Keep the AI-title mark in sync with the moved name so the replacement
  // session stops regenerating exactly like the original one did.
  const marks = loadAiMarks();
  if (marks[previousKey] === true) {
    marks[nextKey] = true;
    delete marks[previousKey];
    saveAiMarks(marks);
  }
  const derived = loadDerivedNames();
  if (derived[previousKey] === true) {
    derived[nextKey] = true;
    delete derived[previousKey];
    saveDerivedNames(derived);
  }
  return typeof names[nextKey] === "string" ? names[nextKey] : "";
}

const AI_NAME_KEY = "pi-science.session-names-ai";

function loadAiMarks(): Record<string, true> {
  try {
    const raw = localStorage.getItem(AI_NAME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, true>;
    return {};
  } catch {
    return {};
  }
}

function saveAiMarks(marks: Record<string, true>) {
  try {
    localStorage.setItem(AI_NAME_KEY, JSON.stringify(marks));
  } catch {
    // Marking is optional metadata; storage failures must never throw.
  }
}

/** True when the session's current name was produced by the AI title feature. */
export function hasAiTitle(cwd: string, sessionId: string): boolean {
  return loadAiMarks()[sessionKey(cwd, sessionId)] === true;
}

/** Record that the session's name came from the AI title feature. */
export function markAiTitle(cwd: string, sessionId: string): void {
  const marks = loadAiMarks();
  marks[sessionKey(cwd, sessionId)] = true;
  saveAiMarks(marks);
}

/** Clear the AI mark (e.g. after the user renames manually, so a later AI
 *  title no longer overrides the manual choice). */
export function clearAiTitle(cwd: string, sessionId: string): void {
  const marks = loadAiMarks();
  delete marks[sessionKey(cwd, sessionId)];
  saveAiMarks(marks);
}

const AI_ATTEMPT_KEY = "pi-science.session-names-ai-attempted";

function loadAiAttempts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(AI_ATTEMPT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
      ) as Record<string, number>;
    }
    return {};
  } catch {
    return {};
  }
}

function saveAiAttempts(attempts: Record<string, number>) {
  try {
    localStorage.setItem(AI_ATTEMPT_KEY, JSON.stringify(attempts));
  } catch {
    // Attempt tracking is optional metadata; storage failures must never throw.
  }
}

/** Timestamp (ms) of the last AI-title attempt for a session, or 0 when none.
 *  Callers compare against a TTL; expired entries are simply retried. */
export function aiTitleAttemptedAt(cwd: string, sessionId: string): number {
  const value = loadAiAttempts()[sessionKey(cwd, sessionId)];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Record a (failed) AI-title attempt so the next settle does not immediately
 *  spawn another Pi runtime; expires via TTL check at the call site. */
export function markAiTitleAttempted(cwd: string, sessionId: string, at: number = Date.now()): void {
  const attempts = loadAiAttempts();
  attempts[sessionKey(cwd, sessionId)] = at;
  saveAiAttempts(attempts);
}

/** Clear the attempt marker (e.g. after a successful title). */
export function clearAiTitleAttempted(cwd: string, sessionId: string): void {
  const attempts = loadAiAttempts();
  delete attempts[sessionKey(cwd, sessionId)];
  saveAiAttempts(attempts);
}

/** Derive a display name from message text: first non-empty line, trimmed,
 *  internal whitespace collapsed, capped at 48 chars with "…" appended when
 *  truncated (CJK counts as chars). Returns "" for text with no visible
 *  content. */
export function deriveSessionName(text: string): string {
  const line = text.split("\n").map((candidate) => candidate.trim()).find(Boolean) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > 48 ? `${collapsed.slice(0, 48)}…` : collapsed;
}
