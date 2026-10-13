import type { WorkspaceReference } from "../files/file-references";
import type { SubagentMention } from "./subagent-mentions";

/** Text is readable; entities bind ranges to workspace objects or agents.
 * All offsets are UTF-16 positions, matching textarea selectionStart/End. */
export type ComposerEntity =
  | (SubagentMention & { kind: "mention" })
  | { id: string; kind: "reference"; start: number; end: number; reference: WorkspaceReference };

export interface ComposerDocument {
  value: string;
  entities: ComposerEntity[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Token text for a well-shaped binding. Malformed runtime shapes yield null so the caller drops the binding instead
 * of reading a missing field. */
export function entityToken(entity: unknown): string | null {
  if (!isRecord(entity)) return null;
  if (entity.kind === "mention") return typeof entity.name === "string" ? `@${entity.name}` : null;
  if (entity.kind !== "reference") return null;
  const reference = entity.reference;
  return isRecord(reference) && typeof reference.cwd === "string" && typeof reference.path === "string" && typeof reference.isDir === "boolean"
    ? `@${reference.path}` : null;
}

/** Shape check before any field read: an unusable binding is discarded, never thrown on. */
function shapedEntity(entity: unknown): { entity: ComposerEntity; token: string; start: number; stop: number } | null {
  if (!isRecord(entity)) return null;
  const token = entityToken(entity);
  if (token === null || typeof entity.id !== "string" || entity.id === ""
    || !Number.isInteger(entity.start) || !Number.isInteger(entity.end)) return null;
  return { entity: entity as unknown as ComposerEntity, token, start: entity.start as number, stop: entity.end as number };
}

/** Fail open for malformed metadata: never block typing or rebind plain text. */
export function validComposerEntities(value: string, entities: readonly ComposerEntity[]): ComposerEntity[] {
  const shaped = entities.flatMap((entity) => shapedEntity(entity) ?? []);
  const result: ComposerEntity[] = [];
  const ids = new Set<string>();
  let end = 0;
  for (const { entity, token, start, stop } of shaped.sort((a, b) => a.start - b.start)) {
    if (ids.has(entity.id) || start < end || start < 0 || start >= stop || stop > value.length
      || value.slice(start, stop) !== token) continue;
    ids.add(entity.id);
    result.push(entity);
    end = stop;
  }
  return result;
}

export interface ComposerEditIntent {
  value: string;
  entities: readonly ComposerEntity[];
  selectionStart: number;
  selectionEnd: number;
  inputType: string;
}

function editRange(intent: ComposerEditIntent, nextValue: string) {
  let { selectionStart: start, selectionEnd: end } = intent;
  const removed = intent.value.length - nextValue.length;
  if (start === end && removed > 0 && intent.inputType.startsWith("delete")) {
    if (intent.inputType.endsWith("Backward")) start = Math.max(0, start - removed);
    else if (intent.inputType.endsWith("Forward")) end = Math.min(intent.value.length, end + removed);
    else return null;
  }
  if (start < 0 || end < start || end > intent.value.length) return null;
  const prefix = intent.value.slice(0, start);
  const suffix = intent.value.slice(end);
  if (!nextValue.startsWith(prefix) || !nextValue.endsWith(suffix)
    || nextValue.length < prefix.length + suffix.length) return null;
  return { start, end, inserted: nextValue.slice(prefix.length, nextValue.length - suffix.length) };
}

export function entityIntersectsEdit(entity: ComposerEntity, start: number, oldEnd: number): boolean {
  return start === oldEnd
    ? entity.start < start && start < entity.end
    : start < entity.end && oldEnd > entity.start;
}

export function applyComposerEdit(document: ComposerDocument, intent: ComposerEditIntent, nextValue: string): ComposerDocument & { caret: number } {
  if (intent.value !== document.value) return { value: nextValue, entities: [], caret: nextValue.length };
  const entities = validComposerEntities(intent.value, intent.entities);
  const range = editRange(intent, nextValue);
  if (!range) return { value: nextValue, entities: [], caret: nextValue.length };
  const { start, end, inserted } = range;
  const affected = entities.filter((entity) => entityIntersectsEdit(entity, start, end));
  if (affected.length > 0) {
    const expandedStart = Math.min(start, ...affected.map((entity) => entity.start));
    const expandedEnd = Math.max(end, ...affected.map((entity) => entity.end));
    const value = document.value.slice(0, expandedStart) + inserted + document.value.slice(expandedEnd);
    const delta = inserted.length - (expandedEnd - expandedStart);
    const remaining = entities.filter((entity) => !affected.includes(entity))
      .map((entity) => entity.start >= expandedEnd
        ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity);
    return { value, entities: validComposerEntities(value, remaining), caret: expandedStart + inserted.length };
  }
  const delta = inserted.length - (end - start);
  const shifted = entities.map((entity) => entity.start >= end
    ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity);
  return { value: nextValue, entities: validComposerEntities(nextValue, shifted), caret: start + inserted.length };
}

/** The common prefix and suffix bracket the smallest changed range an untransacted edit can localize. */
function minimalChangeRange(previous: string, nextValue: string) {
  const limit = Math.min(previous.length, nextValue.length);
  let start = 0;
  while (start < limit && previous[start] === nextValue[start]) start += 1;
  const before = previous.slice(start);
  const after = nextValue.slice(start);
  let suffix = 0;
  while (suffix < before.length && suffix < after.length && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { start, end: start + before.length - suffix };
}

/** Without the transaction the minimal changed range decides: bindings that intersect it are dropped, the rest shift. */
export function updateComposerDocument(document: ComposerDocument, nextValue: string): ComposerDocument & { caret: number } {
  if (nextValue === document.value) return { ...document, entities: validComposerEntities(document.value, document.entities), caret: nextValue.length };
  const { start, end } = minimalChangeRange(document.value, nextValue);
  return applyComposerEdit(document, { value: document.value, entities: document.entities, selectionStart: start, selectionEnd: end, inputType: "insertReplacementText" }, nextValue);
}

export function inlineWorkspaceReferences(entities: readonly ComposerEntity[]): WorkspaceReference[] {
  const references = entities.flatMap((entity) => entity.kind === "reference" ? [entity.reference] : []);
  return references.filter((reference, index) =>
    references.findIndex((other) => other.cwd === reference.cwd && other.path === reference.path) === index);
}

