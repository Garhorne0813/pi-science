/** Interpret questionnaire and interaction payloads without bypassing the event fold. */
import { enqueueInteraction, resolveInteraction } from "../interaction-queue";
import type { PiScienceEvent } from "../../client/pi-science-client";
import { bumpConversationGeneration } from "../generations";
import { runtimeStore } from "../store-access";
import type { PendingInteraction, PendingQuestionnaire } from "../types";

type InteractionKind = NonNullable<PendingInteraction["kind"]>;

function interactionKind(value: unknown): InteractionKind | undefined {
  return value === "permission" || value === "confirmation" || value === "question" ? value : undefined;
}

function questionnaireQuestions(value: unknown): PendingQuestionnaire["questions"] {  if (!Array.isArray(value)) return [];
  return value.flatMap((rawQuestion) => {
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return [];
    const question = rawQuestion as Record<string, unknown>;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
        if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
        const option = rawOption as Record<string, unknown>;
        const label = typeof option.label === "string" ? option.label : "";
        if (!label) return [];
        return [{
          label,
          description: typeof option.description === "string" ? option.description : "",
          ...(typeof option.preview === "string" && option.preview ? { preview: option.preview } : {}),
        }];
      })
      : [];
    const prompt = typeof question.question === "string" ? question.question : "";
    if (!prompt || options.length === 0) return [];
    return [{
      question: prompt,
      header: typeof question.header === "string" ? question.header : "",
      multiSelect: question.multiSelect === true,
      options,
    }];
  });
}

export function applyInteractionEvent(event: PiScienceEvent): void {
  if (event.type === "questionnaire.asked") {
    const questions = questionnaireQuestions(event.questions);
    // An invalid payload cannot build a card, but it consumed a stream
    // position just the same: fold it instead of dropping it.
    if (questions.length > 0) {
      bumpConversationGeneration();
      runtimeStore.setState({
        working: true,
        turnLifecycle: "waiting",
        status: "ready",
        pendingQuestionnaire: {
          toolCallId: String(event.toolCallId || ""),
          questions,
        },
      });
    }
  }

  if (event.type === "questionnaire.finished") {
    bumpConversationGeneration();
    const current = runtimeStore.getState();
    const toolCallId = String(event.toolCallId || "");
    const questionnaireMatches = current.pendingQuestionnaire?.toolCallId === toolCallId;
    const interactionMatches = current.pendingInteraction?.questionnaire === true
      && current.pendingInteraction.toolCallId === toolCallId;
    runtimeStore.setState({
      ...(questionnaireMatches ? { pendingQuestionnaire: null } : {}),
      ...(interactionMatches ? resolveInteraction(current, current.pendingInteraction!.requestId) : {}),
    });
  }

  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};

  if (event.type === "interaction.requested") {
    const interactionId = String(event.interactionId || event.requestId || payload.interactionId || payload.requestId || event.itemId || "");
    // Same rule for a request without an id: no card, but the position is
    // still consumed, so it is folded below rather than dropped.
    if (interactionId) {
      bumpConversationGeneration();
      const method = String(event.method || payload.method || "input") as PendingInteraction["method"];
      const kind = interactionKind(event.kind) ?? interactionKind(payload.kind) ?? (method === "confirm" ? "confirmation" : "question");
      runtimeStore.setState({
        working: true,
        turnLifecycle: "waiting",
        status: "ready",
        ...enqueueInteraction(runtimeStore.getState(), {
          requestId: interactionId,
          kind,
          method: ["confirm", "select", "input", "editor"].includes(method) ? method : "input",
          title: String(event.title || payload.title || "Question"),
          message: String(event.message || payload.message || ""),
          options: Array.isArray(event.options || payload.options) ? (event.options || payload.options) as PendingInteraction["options"] : [],
          placeholder: String(event.placeholder || payload.placeholder || ""),
          prefill: String(event.prefill || payload.prefill || ""),
          operation: String(event.operation || payload.operation || ""),
          scope: String(event.scope || payload.scope || ""),
          effect: String(event.effect || payload.effect || ""),
          ...(event.toolCallId ? { toolCallId: String(event.toolCallId) } : {}),
          ...(event.questionnaire === true ? { questionnaire: true } : {}),
        }),
      });
    }
    // The reducer still records the envelope; the interaction card is a
    // separate state dimension and must not be hidden by process folding.
  } else if (event.type === "interaction.resolved") {
    bumpConversationGeneration();
    const interactionId = String(event.interactionId || event.requestId || payload.interactionId || payload.requestId || event.itemId || "");
    const current = runtimeStore.getState();
    const remaining = resolveInteraction(current, interactionId);
    runtimeStore.setState({ ...remaining, turnLifecycle: remaining.pendingInteraction ? "waiting" : current.working ? "active" : current.turnLifecycle });
  }

}
