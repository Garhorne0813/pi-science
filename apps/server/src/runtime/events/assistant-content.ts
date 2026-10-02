import type { RuntimeEvent } from "../agent/agent-runtime-types.js";

export type AssistantContentKind = "text" | "thinking";

const ASSISTANT_EVENT_TYPES: Record<AssistantContentKind, string[]> = {
  text: ["text_delta", "text", "text_end"],
  thinking: ["thinking_delta", "thinking", "thinking_end"],
};

function partSnapshot(value: unknown, contentIndex: number, kind: AssistantContentKind): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const part = content[contentIndex];
  if (!part || typeof part !== "object" || Array.isArray(part)) return undefined;
  const record = part as Record<string, unknown>;
  if (record.type !== kind) return undefined;
  const text = record[kind === "thinking" ? "thinking" : "text"];
  return typeof text === "string" ? text : undefined;
}

export interface AssistantContent { kind: AssistantContentKind; type: string; text: string; snapshot?: string; messageId: string; contentIndex: string; presentationRole?: "intermediate" | "final"; source: "core" | "legacy" }

export function legacyAssistantContent(event: RuntimeEvent): AssistantContent | null {
  if (event.type !== "message.updated") return null;
  const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistant) return null;
  const type = String(assistant.type ?? "");
  const kind = (Object.keys(ASSISTANT_EVENT_TYPES) as AssistantContentKind[]).find((candidate) => ASSISTANT_EVENT_TYPES[candidate].includes(type));
  if (!kind) return null;
  const message = event.message as Record<string, unknown> | undefined;
  const contentIndex = Number(assistant.contentIndex ?? 0);
  const text = String(
    type.endsWith("_delta")
      ? assistant.delta ?? assistant.text ?? assistant.content ?? ""
      : assistant[kind === "thinking" ? "thinking" : "content"] ?? assistant.text ?? assistant.delta ?? "",
  );
  // Pi may include the complete in-progress assistant message on every delta.
  // Prefer that authoritative snapshot over heuristics on provider chunks:
  // some providers resend or overlap deltas, while the snapshot remains
  // correct. `event.message` is a compatibility fallback for older runtimes.
  const snapshot = partSnapshot(assistant.partial, contentIndex, kind)
    ?? partSnapshot(message, contentIndex, kind);
  const role = assistant.presentationRole ?? message?.presentationRole;
  return {
    source: "legacy",
    kind,
    type,
    text,
    ...(snapshot === undefined ? {} : { snapshot }),
    messageId: typeof message?.id === "string" ? message.id : "",
    contentIndex: String(assistant.contentIndex ?? "0"),
    ...(role === "final" || role === "intermediate" ? { presentationRole: role } : {}),
  };
}

