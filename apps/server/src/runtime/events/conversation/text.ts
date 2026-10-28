
import { MAX_EVENT_TEXT, MAX_TEXT_CHUNK_BYTES, MAX_METADATA_TEXT_BYTES, MAX_TOOL_EVENT_OUTPUT_BYTES } from "./limits.js";

export function cap(value: unknown, limit = MAX_EVENT_TEXT): string {
  return capUtf8(value, limit).text;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(bytes.length, Math.max(0, maxBytes));
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end === 0 && bytes.length > 0 && maxBytes > 0) {
    end = 1;
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  let start = Math.max(0, bytes.length - Math.max(0, maxBytes));
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export function capUtf8(value: unknown, limitBytes: number, mode: "head" | "tail" = "head"): { text: string; truncated: boolean; originalBytes: number } {
  const text = typeof value === "string" ? value : stringify(value);
  const originalBytes = utf8Bytes(text);
  if (originalBytes <= limitBytes) return { text, truncated: false, originalBytes };
  const marker = mode === "tail" ? "[truncated]\n" : "\n[truncated]";
  const available = Math.max(0, limitBytes - utf8Bytes(marker));
  const slice = mode === "tail" ? utf8Suffix(text, available) : utf8Prefix(text, available);
  return { text: mode === "tail" ? `${marker}${slice}` : `${slice}${marker}`, truncated: true, originalBytes };
}

export function splitUtf8(text: string, chunkBytes: number): string[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= chunkBytes) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(bytes.length, offset + chunkBytes);
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    // A chunk boundary may land inside a multi-byte code point. If the first
    // code point itself is wider than the budget, include it whole rather than
    // emitting replacement characters that would corrupt the answer.
    if (end === offset) {
      end = Math.min(bytes.length, offset + 1);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
    }
    chunks.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  // Nullish means "no value", so it must cap to the empty string. Stringifying
  // an empty string instead yields the two-character text `""`, which is truthy
  // and therefore survives every downstream `value || fallback` check.
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** A tool partial result arrives as the result shape itself
 *  ({content:[{type:"text",text:…}]}) — as an object, or as its JSON string.
 *  Return the joined text parts, or null when it is not that shape. */
export function snapshotText(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const content = (parsed as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  return content.map((part) => {
    const record = part && typeof part === "object" ? (part as Record<string, unknown>) : {};
    return typeof record.text === "string" ? record.text : "";
  }).join("");
}

export function safeValue(value: unknown, depth = 0, key?: string): unknown {
  if (depth > 5) return "[depth limit]";
  if (typeof value === "string") {
    const limit = key === "text" || key === "thinking"
      ? MAX_TEXT_CHUNK_BYTES
      : key === "output" || key === "partialOutput"
        ? MAX_TOOL_EVENT_OUTPUT_BYTES
        : MAX_METADATA_TEXT_BYTES;
    return capUtf8(value, limit).text;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeValue(item, depth + 1, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([childKey, item]) => [childKey, safeValue(item, depth + 1, childKey)]));
  }
  return value;
}
