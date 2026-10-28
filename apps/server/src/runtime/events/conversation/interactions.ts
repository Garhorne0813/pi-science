import type { ProductInput } from "../product-input.js";
import { cap } from "./text.js";

export const BROWSER_QUESTIONNAIRE_REQUEST_PREFIX = "pi-science-questionnaire-v1:";

export function questionnairePayload(sessionId: string, toolCallId: string, args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const rawQuestions = (args as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const questions = rawQuestions.slice(0, 4).flatMap((rawQuestion) => {
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return [];
    const question = rawQuestion as Record<string, unknown>;
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    return [{
      question: cap(question.question),
      header: cap(question.header, 200),
      multiSelect: question.multiSelect === true,
      options: rawOptions.slice(0, 4).flatMap((rawOption) => {
        if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
        const option = rawOption as Record<string, unknown>;
        return [{
          label: cap(option.label, 500),
          description: cap(option.description),
          ...(typeof option.preview === "string" && option.preview.length > 0 ? { preview: cap(option.preview) } : {}),
        }];
      }),
    }];
  });
  return { type: "questionnaire.asked", sessionId, toolCallId, questions };
}

export function browserQuestionnaireRequestId(title: unknown): string | null {
  if (typeof title !== "string" || !title.startsWith(BROWSER_QUESTIONNAIRE_REQUEST_PREFIX)) return null;
  const encoded = title.slice(BROWSER_QUESTIONNAIRE_REQUEST_PREFIX.length);
  if (!encoded) return null;
  try {
    const value = decodeURIComponent(encoded);
    return value || null;
  } catch {
    return null;
  }
}

export type InteractionKind = "permission" | "confirmation" | "question";

/**
 * Pi's interaction.requested protocol does not carry a semantic kind. The
 * managed MCP approval producer adds this private marker to its select title;
 * the server consumes it here and removes it before the UI sees the title.
 */
export const MCP_PERMISSION_TITLE_PREFIX = "[pi-science:permission] ";

export function markedMcpPermissionTitle(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(MCP_PERMISSION_TITLE_PREFIX)) return undefined;
  return value.slice(MCP_PERMISSION_TITLE_PREFIX.length).trim() || "MCP approval";
}

export function interactionKind(value: unknown): InteractionKind | undefined {
  return value === "permission" || value === "confirmation" || value === "question" ? value : undefined;
}

export function eventField(event: ProductInput, key: string): unknown {
  const direct = (event as Record<string, unknown>)[key];
  if (direct !== undefined) return direct;
  const payload = (event as Record<string, unknown>).payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return (payload as Record<string, unknown>)[key];
  return undefined;
}
