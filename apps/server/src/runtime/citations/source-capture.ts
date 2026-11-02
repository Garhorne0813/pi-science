import { isAbsolute } from "node:path";
import type { CitationLocator, CitationSourceKind } from "@pi-science/contracts";
import type { SseEventRecord } from "../events/event-store.js";

export interface CapturedSource {
  id: string;
  kind: CitationSourceKind;
  identity: string;
  title: string;
  locator: CitationLocator;
  excerpt: string | null;
  capturedAt: string | null;
  evidence: { tool: string; callId: string; turnId: string | null };
  /** The tool output was not readable text, so no excerpt may be rendered. */
  binary?: boolean;
  /** The read never produced a usable result: failed, interrupted or missing
   *  output. The source is registered but is not evidence that content was read. */
  attempt?: boolean;
}

export interface CaptureScope {
  /** Turn ids the answer belongs to. A version only binds to an answer whose
   *  turn actually read it; without a scope the registry spans the session. */
  turnIds?: string[];
}

const MAX_EXCERPT_CHARS = 2_000;
// Prose is not base64. A payload long enough to matter, unbroken by any
// whitespace and containing a base64 marker character is an encoded blob.
const BASE64_MIN_CHARS = 512;
const BASE64_MARKER = /[+/=]/;

/** The `read` tool appends its own continuation note to the text it returns.
 *  That note is not in the file, so it must never reach the excerpt or locator. */
const READ_CONTINUATION_NOTE = /\n\n\[(?:Showing lines \d+-\d+ of \d+|Line \d+ is |\d+ more lines in file\.)[\s\S]*$/;

function isBase64Char(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 61;
}

/** One unbroken run of base64 alphabet carrying a `+`, `/` or `=` marker is an
 *  encoded payload. Wrapped text keeps its whitespace, so a column-folded DNA or
 *  protein sequence stays readable. */
function isBase64Payload(payload: string): boolean {
  if (!BASE64_MARKER.test(payload)) return false;
  for (let index = 0; index < payload.length; index += 1) if (!isBase64Char(payload.charCodeAt(index))) return false;
  return true;
}

/** Binary tool output (PDF, image, archive) must never become a rendered excerpt. */
export function isReadableText(text: string): boolean {
  if (text.includes("\u0000") || text.includes("\uFFFD")) return false;
  const payload = text.trim();
  if (payload.length < BASE64_MIN_CHARS || /\s/.test(payload)) return true;
  return !isBase64Payload(payload);
}

function parseEvent(record: SseEventRecord): Record<string, unknown> | null {
  return parseJsonObject(record.data);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Workspace-relative identity, or null when the path leaves the workspace. */
export function normalizeWorkspacePath(path: string): string | null {
  if (!path || path.includes("\u0000")) return null;
  const slashed = path.replace(/\\/g, "/");
  if (isAbsolute(path) || slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed)) return null;
  let relative = slashed;
  while (relative.startsWith("./")) relative = relative.slice(2);
  if (!relative || relative === ".") return null;
  if (relative.split("/").some((segment) => segment === "..")) return null;
  return relative;
}

/** A hash fragment never changes which document was read. */
export function normalizeWebUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function charLocator(input: Record<string, unknown>): CitationLocator {
  const offset = nonNegativeInteger(input.offset);
  const limit = nonNegativeInteger(input.limit);
  if (offset !== null && limit !== null && limit > 0) return { kind: "chars", start: offset, end: offset + limit };
  return { kind: "whole-source" };
}

/** `read` counts lines, not characters: offset is the 1-indexed start line. */
function lineLocator(input: Record<string, unknown>, output: string, binary: boolean): CitationLocator {
  const offset = nonNegativeInteger(input.offset);
  const limit = nonNegativeInteger(input.limit);
  if (!binary && offset !== null && offset >= 1) {
    const read = Math.max(1, countLines(output));
    const endLine = limit !== null && limit >= 1 ? offset + limit - 1 : offset + read - 1;
    return { kind: "lines", startLine: offset, endLine };
  }
  const lines = binary ? 0 : countLines(output);
  return lines > 0 ? { kind: "lines", startLine: 1, endLine: lines } : { kind: "whole-source" };
}

/** `read` and `web_fetch` return `{ content: [{ type: "text", text }] }` and the
 *  event projection stores that whole result as JSON. The excerpt has to be the
 *  text the tool returned, or verification compares JSON against the file. */
function toolResultText(output: unknown): { text: string; binary: boolean } {
  if (typeof output !== "string") return { text: "", binary: false };
  const parsed = parseJsonObject(output);
  const content = parsed && Array.isArray(parsed.content) ? parsed.content : null;
  if (!content) return { text: output, binary: false };
  const parts: string[] = [];
  for (const part of content) {
    const record = objectValue(part);
    // An image or attachment part means the result carried no file text.
    if (!record || record.type !== "text" || typeof record.text !== "string") return { text: "", binary: true };
    parts.push(record.text);
  }
  return { text: parts.join(""), binary: false };
}

function stripContinuationNote(text: string): string {
  return text.replace(READ_CONTINUATION_NOTE, "");
}

function excerptOf(text: string, unreadable: boolean): { excerpt: string | null; binary: boolean; text: string } {
  const trimmed = text.trim();
  if (unreadable) return { excerpt: null, binary: true, text: "" };
  if (!trimmed) return { excerpt: null, binary: false, text: "" };
  if (!isReadableText(trimmed)) return { excerpt: null, binary: true, text: trimmed };
  return { excerpt: trimmed.slice(0, MAX_EXCERPT_CHARS), binary: false, text: trimmed };
}

function timestamp(started: Record<string, unknown>, completed: Record<string, unknown> | null): string | null {
  return stringValue(completed?.endedAt) ?? stringValue(started.startedAt);
}

function turnOf(started: Record<string, unknown>, completed: Record<string, unknown> | null): string | null {
  return stringValue(completed?.turnId) ?? stringValue(started.turnId);
}

function captureRead(started: Record<string, unknown>, completed: Record<string, unknown> | null): CapturedSource | null {
  const input = objectValue(started.input);
  const path = stringValue(input?.path);
  if (!input || !path) return null;
  const identity = normalizeWorkspacePath(path);
  if (!identity) return null;
  const callId = stringValue(started.callId);
  if (!callId) return null;
  const raw = completed ? toolResultText(completed.output) : { text: "", binary: false };
  const { excerpt, binary, text } = excerptOf(stripContinuationNote(raw.text), raw.binary);
  return {
    id: `file:${identity}`,
    kind: "file",
    identity,
    title: identity.split("/").pop() ?? identity,
    locator: lineLocator(input, text, binary),
    excerpt,
    capturedAt: timestamp(started, completed),
    evidence: { tool: stringValue(started.tool) ?? "read", callId, turnId: turnOf(started, completed) },
    ...(completed ? {} : { attempt: true }),
    ...(binary ? { binary } : {}),
  };
}

function captureWebFetch(started: Record<string, unknown>, completed: Record<string, unknown> | null): CapturedSource | null {
  const input = objectValue(started.input);
  const url = stringValue(input?.url);
  if (!input || !url) return null;
  const identity = normalizeWebUrl(url);
  if (!identity) return null;
  const callId = stringValue(started.callId);
  if (!callId) return null;
  const raw = completed ? toolResultText(completed.output) : { text: "", binary: false };
  const { excerpt, binary } = excerptOf(raw.text, raw.binary);
  return {
    id: `web:${identity}`,
    kind: "web",
    identity,
    title: new URL(identity).host,
    locator: binary ? { kind: "whole-source" } : charLocator(input),
    excerpt,
    capturedAt: timestamp(started, completed),
    evidence: { tool: stringValue(started.tool) ?? "web_fetch", callId, turnId: turnOf(started, completed) },
    ...(completed ? {} : { attempt: true }),
    ...(binary ? { binary } : {}),
  };
}

function captureOf(tool: string, started: Record<string, unknown>, completed: Record<string, unknown> | null): CapturedSource | null {
  if (tool === "read") return captureRead(started, completed);
  return tool === "web_fetch" ? captureWebFetch(started, completed) : null;
}

/** Pair read and web_fetch calls into captured sources, keeping the first read
 *  of an identity inside the scope: that is the version the answer used.
 *  A failed, interrupted or output-less read is still registered as an attempt,
 *  but a real read of the same identity always wins over it. */
export function captureCitationSources(events: SseEventRecord[], scope: CaptureScope = {}): CapturedSource[] {
  const turnIds = scope.turnIds && scope.turnIds.length > 0 ? new Set(scope.turnIds) : null;
  const inScope = (data: Record<string, unknown>): boolean => !turnIds || (typeof data.turnId === "string" && turnIds.has(data.turnId));
  const starts = new Map<string, { data: Record<string, unknown>; index: number }>();
  const reads: Array<{ source: CapturedSource; index: number }> = [];
  const attempts: Array<{ source: CapturedSource; index: number }> = [];
  events.forEach((event, index) => {
    const data = parseEvent(event);
    if (!data || !inScope(data)) return;
    const callId = stringValue(data.callId);
    if (!callId) return;
    if (data.type === "tool.started") {
      if (!starts.has(callId)) starts.set(callId, { data, index });
      return;
    }
    if (data.type !== "tool.completed") return;
    const start = starts.get(callId);
    if (!start) return;
    starts.delete(callId);
    const tool = stringValue(start.data.tool) ?? "";
    const completed = data.status === "error" ? null : data;
    const source = captureOf(tool, start.data, completed);
    if (source) reads.push({ source, index: start.index });
  });
  for (const { data, index } of starts.values()) {
    const source = captureOf(stringValue(data.tool) ?? "", data, null);
    if (source) attempts.push({ source, index });
  }
  const byStart = (left: { index: number }, right: { index: number }): number => left.index - right.index;
  const seen = new Set<string>();
  const kept: Array<{ source: CapturedSource; index: number }> = [];
  for (const entry of [...reads.sort(byStart), ...attempts.sort(byStart)]) {
    if (seen.has(entry.source.id)) continue;
    seen.add(entry.source.id);
    kept.push(entry);
  }
  return kept.sort(byStart).map((entry) => entry.source);
}
