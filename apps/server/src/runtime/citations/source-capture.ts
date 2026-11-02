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
}

const MAX_EXCERPT_CHARS = 2_000;
// Prose is not base64. A minimum length and a whitespace check keep ordinary
// short or punctuation-free text from being misread as an encoded payload.
const BASE64_MIN_CHARS = 512;
const BASE64_MIN_RATIO = 0.95;
const BASE64_MAX_WHITESPACE_RATIO = 0.02;
const BASE64_ALPHABET = "+/=";

function isBase64Char(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || BASE64_ALPHABET.includes(String.fromCharCode(code));
}

/** Binary tool output (PDF, image, archive) must never become a rendered excerpt. */
export function isReadableText(text: string): boolean {
  if (text.includes("\u0000") || text.includes("\uFFFD")) return false;
  const whitespace = (text.match(/\s/g) ?? []).length;
  if (text.length > 0 && whitespace / text.length >= BASE64_MAX_WHITESPACE_RATIO) return true;
  const stripped = text.replace(/\s+/g, "");
  if (stripped.length < BASE64_MIN_CHARS) return true;
  let alphabet = 0;
  for (let index = 0; index < stripped.length; index += 1) if (isBase64Char(stripped.charCodeAt(index))) alphabet += 1;
  return alphabet / stripped.length <= BASE64_MIN_RATIO;
}

function parseEvent(record: SseEventRecord): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(record.data);
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
  if (!binary && offset !== null && offset >= 1 && limit !== null && limit >= 1) return { kind: "lines", startLine: offset, endLine: offset + limit - 1 };
  const lines = binary ? 0 : countLines(output);
  return lines > 0 ? { kind: "lines", startLine: 1, endLine: lines } : { kind: "whole-source" };
}

function excerptOf(output: string): { excerpt: string | null; binary: boolean; text: string } {
  const text = output.trim();
  if (!text) return { excerpt: null, binary: false, text };
  if (!isReadableText(text)) return { excerpt: null, binary: true, text };
  return { excerpt: text.slice(0, MAX_EXCERPT_CHARS), binary: false, text };
}

function timestamp(started: Record<string, unknown>, completed: Record<string, unknown>): string | null {
  return stringValue(completed.endedAt) ?? stringValue(started.startedAt);
}

function captureRead(started: Record<string, unknown>, completed: Record<string, unknown>): CapturedSource | null {
  const input = objectValue(started.input);
  const path = stringValue(input?.path);
  if (!input || !path) return null;
  const identity = normalizeWorkspacePath(path);
  if (!identity) return null;
  const { excerpt, binary, text } = excerptOf(typeof completed.output === "string" ? completed.output : "");
  const tool = stringValue(started.tool) ?? "read";
  const callId = stringValue(started.callId) ?? "";
  if (!callId) return null;
  return {
    id: `file:${identity}`,
    kind: "file",
    identity,
    title: identity.split("/").pop() ?? identity,
    locator: lineLocator(input, text, binary),
    excerpt,
    capturedAt: timestamp(started, completed),
    evidence: { tool, callId, turnId: stringValue(completed.turnId) ?? stringValue(started.turnId) },
    ...(binary ? { binary } : {}),
  };
}

function captureWebFetch(started: Record<string, unknown>, completed: Record<string, unknown>): CapturedSource | null {
  const input = objectValue(started.input);
  const url = stringValue(input?.url);
  if (!input || !url) return null;
  const identity = normalizeWebUrl(url);
  if (!identity) return null;
  const { excerpt, binary } = excerptOf(typeof completed.output === "string" ? completed.output : "");
  const tool = stringValue(started.tool) ?? "web_fetch";
  const callId = stringValue(started.callId) ?? "";
  if (!callId) return null;
  return {
    id: `web:${identity}`,
    kind: "web",
    identity,
    title: new URL(identity).host,
    locator: binary ? { kind: "whole-source" } : charLocator(input),
    excerpt,
    capturedAt: timestamp(started, completed),
    evidence: { tool, callId, turnId: stringValue(completed.turnId) ?? stringValue(started.turnId) },
    ...(binary ? { binary } : {}),
  };
}

/** Pair completed read/web_fetch tool calls into first-seen captured sources.
 *  A capture order follows the tool start, so the answer's original version wins. */
export function captureCitationSources(events: SseEventRecord[]): CapturedSource[] {
  const starts = new Map<string, { data: Record<string, unknown>; index: number }>();
  const candidates: Array<{ source: CapturedSource; index: number }> = [];
  events.forEach((event, index) => {
    const data = parseEvent(event);
    if (!data) return;
    const callId = stringValue(data.callId);
    if (!callId) return;
    if (data.type === "tool.started") {
      if (!starts.has(callId)) starts.set(callId, { data, index });
      return;
    }
    if (data.type !== "tool.completed" || data.status === "error") return;
    const start = starts.get(callId);
    if (!start) return;
    const tool = stringValue(start.data.tool);
    const source = tool === "read" ? captureRead(start.data, data) : tool === "web_fetch" ? captureWebFetch(start.data, data) : null;
    if (source) candidates.push({ source, index: start.index });
  });
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => left.index - right.index)
    .flatMap(({ source }) => {
      if (seen.has(source.id)) return [];
      seen.add(source.id);
      return [source];
    });
}
