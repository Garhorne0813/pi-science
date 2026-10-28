import type { ProductInput } from "../product-input.js";
import { boundedToolDetails } from "../../node/message-details.js";
import { toolActivityPresentation, toolActivityTitle } from "../../presentation/tool-activity-presenters.js";
import type { TurnState } from "./types.js";
import { MAX_EVENT_TEXT, MAX_TOOL_EVENT_OUTPUT_BYTES } from "./limits.js";
import { cap, capUtf8, stringify, snapshotText, safeValue } from "./text.js";
import { questionnairePayload, browserQuestionnaireRequestId, markedMcpPermissionTitle, interactionKind, eventField } from "./interactions.js";
import { streamKey, newConversationId, turnFields, eventPhase, modelError } from "./records.js";
import { ConversationStreams } from "./streams.js";

/** Own per-conversation turn/content normalization, independently of delivery. */
export class ConversationProjection {
  private readonly turns = new Map<string, TurnState>();
  constructor(private readonly streams: ConversationStreams) {}
  rotateEpoch(key: string, epoch: string): void {
    const turn = this.turns.get(key);
    if (turn) turn.streamEpoch = epoch;
  }
  normalize(cwd: string, sessionId: string, input: ProductInput): Record<string, unknown>[] {
    const event = input;
    const key = streamKey(cwd, sessionId);
    let turn = this.turns.get(key);
    if (!turn) {
      turn = {
        hadText: false,
        hadError: false,
        hadActivity: false,
        contentByKey: new Map(),
        revisionByKey: new Map(),
        anonymousSerial: 0,
        activeAnonymousKey: null,
        turnOrdinal: 0,
        turnId: null,
        runId: null,
        streamEpoch: this.streams.get(cwd, sessionId).epoch,
      };
      this.turns.set(key, turn);
    }
    if (event.type === "operation.started") {
      turn.turnOrdinal += 1;
      turn.turnId = typeof event.turnId === "string" && event.turnId ? event.turnId : newConversationId("turn", sessionId, turn.turnOrdinal);
      turn.runId = typeof event.runId === "string" && event.runId ? event.runId : newConversationId("run", sessionId, turn.turnOrdinal);
      turn.hadText = false;
      turn.hadError = false;
      turn.lastRuntimeError = undefined;
      turn.hadActivity = false;
      turn.contentByKey.clear();
      turn.revisionByKey.clear();
      turn.activeAnonymousKey = null;
      return [{ type: "operation.started", sessionId, ...turnFields(turn) }];
    }
    if (!turn.turnId) {
      turn.turnOrdinal = Math.max(1, turn.turnOrdinal);
      turn.turnId = newConversationId("turn", sessionId, turn.turnOrdinal);
      turn.runId = newConversationId("run", sessionId, turn.turnOrdinal);
    }

    const content = event.type === "message.updated" ? event.content as import("../assistant-content.js").AssistantContent | undefined : undefined;
    if (content) {
      if (!content.messageId && !turn.activeAnonymousKey) {
        turn.activeAnonymousKey = `anonymous-${++turn.anonymousSerial}`;
      }
      const messageKey = content.messageId || turn.activeAnonymousKey!;
      const key = `${messageKey}:${content.contentIndex}`;
      const accumulated = turn.contentByKey.get(key) ?? "";
      let emitted = content.text;
      let replace = false;
      if (content.snapshot !== undefined) {
        if (content.snapshot === accumulated) emitted = "";
        else if (content.snapshot.startsWith(accumulated)) emitted = content.snapshot.slice(accumulated.length);
        else if (accumulated) {
          emitted = content.snapshot;
          replace = true;
        } else {
          emitted = content.snapshot;
        }
        turn.contentByKey.set(key, content.snapshot);
        if (content.type.endsWith("_end") && !content.messageId) turn.activeAnonymousKey = null;
      } else if (content.type.endsWith("_end")) {
        if (content.text === accumulated) emitted = "";
        else if (content.text.startsWith(accumulated)) emitted = content.text.slice(accumulated.length);
        else if (accumulated) replace = true;
        turn.contentByKey.set(key, content.text);
        if (!content.messageId) turn.activeAnonymousKey = null;
      } else {
        turn.contentByKey.set(key, accumulated + content.text);
      }
      const previousRevision = turn.revisionByKey.get(key) ?? 0;
      const revision = previousRevision + (emitted || replace ? 1 : 0);
      if (emitted || replace) turn.revisionByKey.set(key, revision);
      if (content.kind === "text" && (content.text.trim() || accumulated.trim())) turn.hadText = true;
      if (!emitted && !replace) return [];
      // Revisions are accumulated per content slot, so the wire identity must
      // have the same scope. itemId remains the enclosing assistant message;
      // partId identifies the independently revised content part within it.
      const partId = `${messageKey}:${content.contentIndex}`;
      return [{
        type: content.kind === "thinking" ? "message.reasoning.delta" : "message.delta",
        kind: content.kind,
        sessionId,
        partId,
        itemId: messageKey,
        ...turnFields(turn),
        phase: eventPhase(content.presentationRole),
        baseRevision: previousRevision,
        revision,
        text: capUtf8(emitted, MAX_EVENT_TEXT).text,
        ...(content.presentationRole ? { presentationRole: content.presentationRole } : {}),
        ...(replace ? { replace: true } : {}),
      }];
    }

    const exactError = modelError(event);
    if (exactError) {
      turn.hadError = true;
      if (turn.lastRuntimeError === exactError) return [];
      turn.lastRuntimeError = exactError;
      return [{ type: "error", sessionId, ...turnFields(turn), message: cap(exactError) }];
    }

    switch (event.type) {
      case "message.started": {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role !== "assistant") return [];
        const partId = typeof message.id === "string" && message.id
          ? message.id
          : `anonymous-${++turn.anonymousSerial}`;
        turn.activeAnonymousKey = typeof message.id === "string" && message.id ? null : partId;
        const presentationRole = message?.presentationRole === "final" || message?.presentationRole === "intermediate" ? message.presentationRole : undefined;
        return [{ type: "message.started", sessionId, partId, itemId: partId, ...turnFields(turn), phase: eventPhase(presentationRole), baseRevision: 0, revision: 0, text: "", ...(presentationRole ? { presentationRole } : {}) }];
      }
      case "message.completed": {
        const message = event.message;
        if (message.role !== "assistant") return [];
        return [{ type: "message.completed", sessionId, ...turnFields(turn),
          itemId: "id" in message ? message.id : turn.activeAnonymousKey,
          stopReason: message.stopReason }];
      }
      case "tool.started": {
        turn.hadActivity = true;
        const callId = String(event.toolCallId ?? "");
        const tool = String(event.toolName ?? "unknown");
        const records: Record<string, unknown>[] = [];
        if (tool === "ask_user_question") {
          const questionnaire = questionnairePayload(sessionId, callId, event.args);
          if (questionnaire) records.push(questionnaire);
        }
        const title = toolActivityTitle(tool, event.args);
        const presentation = event.presentation && typeof event.presentation === "object" ? event.presentation : toolActivityPresentation(tool, event.args);
        records.push({ type: "tool.started", sessionId, callId, itemId: callId, ...turnFields(turn), ...(title ? { title } : {}), ...(presentation ? { presentation: safeValue(presentation) } : {}), tool, status: "running", input: safeValue(event.args ?? {}), startedAt: new Date().toISOString() });
        return records;
      }
      case "tool.updated": {
        turn.hadActivity = true;
        const record: Record<string, unknown> = { type: "tool.updated", sessionId, callId: String(event.toolCallId ?? ""), itemId: String(event.toolCallId ?? ""), ...turnFields(turn), tool: String(event.toolName ?? ""), status: "running" };
        let snapshot: unknown = event.partialResult;
        if (typeof snapshot === "string") {
          try { snapshot = JSON.parse(snapshot); } catch { /* ordinary text output */ }
        }
        const partialDetails = snapshot && typeof snapshot === "object"
          ? (snapshot as { details?: { approval?: unknown } }).details : undefined;
        if (partialDetails?.approval === "waiting") record.status = "waiting-approval";
        // Partial results arrive as result-shaped snapshots; unwrap the text
        // so the live row shows real output. An empty snapshot must not
        // clobber an already accumulated tail, so it is simply omitted.
        const unwrapped = event.partialResult !== undefined ? snapshotText(event.partialResult) : null;
        const partial = unwrapped !== null ? unwrapped : typeof event.partialResult === "string" ? event.partialResult : stringify(event.partialResult);
        if (partial) {
          const preview = capUtf8(partial, MAX_TOOL_EVENT_OUTPUT_BYTES, "tail");
          record.partialOutput = preview.text;
          if (preview.truncated) {
            record.outputTruncated = true;
            record.originalOutputBytes = preview.originalBytes;
          }
        }
        return [record];
      }
      case "tool.completed": {
        turn.hadActivity = true;
        const callId = String(event.toolCallId ?? "");
        const tool = String(event.toolName ?? "");
        const records: Record<string, unknown>[] = [];
        if (tool === "ask_user_question") records.push({ type: "questionnaire.finished", sessionId, toolCallId: callId, cancelled: event.isError === true });
        const presentation = event.presentation && typeof event.presentation === "object" ? event.presentation : toolActivityPresentation(tool, event.args);
        const output = capUtf8(event.result, MAX_TOOL_EVENT_OUTPUT_BYTES, "tail");
        records.push({
          type: "tool.completed",
          sessionId,
          callId,
          itemId: callId,
          ...turnFields(turn),
          tool,
          status: event.isError ? "error" : "done",
          output: output.text,
          ...(output.truncated ? { outputTruncated: true, originalOutputBytes: output.originalBytes } : {}),
          ...(presentation ? { presentation: safeValue(presentation) } : {}),
          ...(event.details === undefined ? {} : { details: tool === "todo" ? boundedToolDetails(event.details) : safeValue(event.details) }),
          endedAt: new Date().toISOString(),
        });
        return records;
      }
      case "interaction.requested": {
        turn.hadActivity = true;
        const method = String(eventField(event, "method") ?? "");
        const rawTitle = eventField(event, "title");
        const markedPermissionTitle = markedMcpPermissionTitle(rawTitle);
        const explicitKind = interactionKind(eventField(event, "kind"));
        const kind = explicitKind
          ?? (markedPermissionTitle ? "permission" : method === "confirm" ? "confirmation" : "question");
        const rawGrant = eventField(event, "mcpGrant");
        const grant = rawGrant && typeof rawGrant === "object" && !Array.isArray(rawGrant)
          ? rawGrant as Record<string, unknown> : null;
        const mcpGrant = kind === "permission" && method === "confirm"
          && typeof grant?.connectorId === "string" && grant.connectorId
          && typeof grant?.toolName === "string" && grant.toolName
          ? { connectorId: grant.connectorId, toolName: grant.toolName } : undefined;
        const type = "interaction.requested";
        const requestId = String(eventField(event, "id") ?? eventField(event, "requestId") ?? "");
        const questionnaireId = method !== "confirm" ? browserQuestionnaireRequestId(rawTitle) : null;
        const common = {
          type,
          sessionId,
          ...turnFields(turn),
          requestId,
          kind,
          method,
          ...(typeof eventField(event, "toolCallId") === "string" ? { toolCallId: String(eventField(event, "toolCallId")) } : {}),
          title: questionnaireId
            ? "Questionnaire"
            : markedPermissionTitle ?? String(rawTitle ?? (method === "confirm" ? "Confirmation" : "Question")),
          message: cap(questionnaireId ? "Complete the questionnaire to continue." : eventField(event, "message")),
          operation: cap(eventField(event, "operation"), 500),
          scope: cap(eventField(event, "scope"), 500),
          effect: cap(eventField(event, "effect"), 500),
          ...(mcpGrant ? { mcpGrant } : {}),
        };
        if (method === "confirm") return [common];
        if (["select", "input", "editor"].includes(method)) {
          const toolCallId = questionnaireId;
          return [{
            ...common,
            options: safeValue(eventField(event, "options") ?? []),
            placeholder: String(eventField(event, "placeholder") ?? ""),
            prefill: String(eventField(event, "prefill") ?? ""),
            ...(toolCallId ? { questionnaire: true, toolCallId } : {}),
          }];
        }
        return [];
      }
      case "compaction.start":
      case "compaction.end":
      case "compaction.error":
        return [{ type: event.type === "compaction.start" ? "compaction.started" : event.type === "compaction.end" ? "compaction.completed" : event.type === "compaction.error" ? "compaction.failed" : "compaction.progress", sessionId, ...turnFields(turn), status: event.type.replace("compaction.", ""), message: cap(event.message ?? event.error ?? ""), progress: event.progress }];
      case "runtime.error": {
        turn.hadError = true;
        const message = String(event.message ?? event.error ?? "Agent runtime error");
        if (turn.lastRuntimeError === message) return [];
        turn.lastRuntimeError = message;
        return [{ type: "error", sessionId, ...turnFields(turn), message: cap(message) }];
      }
      case "retry.start":
      case "retry.update":
      case "retry.end":
        return [{ type: "status.updated", sessionId, ...turnFields(turn), status: event.type, message: cap(event.message ?? ""), attempt: event.attempt }];
      case "operation.settled": {
        const records: Record<string, unknown>[] = [];
        if (event.status === "completed" && !turn.hadText && !turn.hadError && !turn.hadActivity && !event.handledWithoutTurn) {
          records.push({
            type: "error",
            sessionId,
            ...turnFields(turn),
            message: "The model returned an empty response. Check the configured API key, model ID, thinking level, and network connection.",
          });
        }
        records.push({
          type: "operation.settled",
          sessionId,
          ...turnFields(turn),
          status: event.status,
          outcome: turn.hadError ? "with_issues" : turn.hadText ? "ok" : "no_answer",
          ...(event.handledWithoutTurn ? { handledWithoutTurn: true } : {}),
        });
        turn.hadText = false;
        turn.hadError = false;
        turn.lastRuntimeError = undefined;
        turn.hadActivity = false;
        turn.contentByKey.clear();
        turn.revisionByKey.clear();
        turn.activeAnonymousKey = null;
        turn.turnId = null;
        turn.runId = null;
        return records;
      }
      default:
        return [];
    }
  }
}
