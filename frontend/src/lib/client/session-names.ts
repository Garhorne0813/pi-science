/** Session display-name registry (localStorage). */

import { sessionKey } from "./session-key";

const NAME_KEY = "pi-science.session-names";

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

export function setSessionName(cwd: string, sessionId: string, name: string): void {
  const names = loadNames();
  names[sessionKey(cwd, sessionId)] = name.slice(0, 50);  // Cap length
  saveNames(names);
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
  return typeof names[nextKey] === "string" ? names[nextKey] : "";
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
