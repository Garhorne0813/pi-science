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

export function entityToken(entity: ComposerEntity): string {
  return entity.kind === "mention" ? `@${entity.name}` : `@${entity.reference.path}`;
}

/** Fail open for malformed metadata: never block typing or rebind plain text. */
export function validComposerEntities(value: string, entities: readonly ComposerEntity[]): ComposerEntity[] {
  const result: ComposerEntity[] = [];
  let end = 0;
  for (const entity of [...entities].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(entity.start) || !Number.isInteger(entity.end)
      || entity.start < end || entity.start < 0 || entity.start >= entity.end || entity.end > value.length
      || value.slice(entity.start, entity.end) !== entityToken(entity)) continue;
    result.push(entity);
    end = entity.end;
  }
  return result;
}

export function composerChangeRange(previous: string, next: string) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let oldEnd = previous.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && previous[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd--;
    nextEnd--;
  }
  return { start, oldEnd, inserted: next.slice(start, nextEnd) };
}

export function entityIntersectsEdit(entity: ComposerEntity, start: number, oldEnd: number): boolean {
  return start === oldEnd
    ? entity.start < start && start < entity.end
    : start < entity.end && oldEnd > entity.start;
}

export function updateComposerDocument(document: ComposerDocument, nextValue: string): ComposerDocument & { caret: number } {
  const entities = validComposerEntities(document.value, document.entities);
  const { start, oldEnd, inserted } = composerChangeRange(document.value, nextValue);
  const affected = entities.filter((entity) => entityIntersectsEdit(entity, start, oldEnd));
  if (affected.length > 0) {
    const expandedStart = Math.min(start, ...affected.map((entity) => entity.start));
    const expandedEnd = Math.max(oldEnd, ...affected.map((entity) => entity.end));
    const value = document.value.slice(0, expandedStart) + inserted + document.value.slice(expandedEnd);
    const delta = inserted.length - (expandedEnd - expandedStart);
    const remaining = entities.filter((entity) => !affected.includes(entity))
      .map((entity) => entity.start >= expandedEnd
        ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity);
    return { value, entities: validComposerEntities(value, remaining), caret: expandedStart + inserted.length };
  }
  const delta = nextValue.length - document.value.length;
  const shifted = entities.map((entity) => entity.start >= oldEnd
    ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity);
  return { value: nextValue, entities: validComposerEntities(nextValue, shifted), caret: start + inserted.length };
}

export function inlineWorkspaceReferences(entities: readonly ComposerEntity[]): WorkspaceReference[] {
  const references = entities.flatMap((entity) => entity.kind === "reference" ? [entity.reference] : []);
  return references.filter((reference, index) =>
    references.findIndex((other) => other.cwd === reference.cwd && other.path === reference.path) === index);
}
