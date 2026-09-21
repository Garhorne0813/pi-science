import type { Thread } from "../../agent-runtime/event-fold";
import type { AgentMessageBlock, ConversationBlockIdentity, ThreadBlock, ToolCallBlock, TurnArtifactItem } from "../../../types/thread";
import { activityPolicy } from "../activity-policy";
import { buildTurnPresentations, type TurnLifecycle, type TurnPresentation } from "../turn-presentation";
import type {
  ActivityKind,
  ActivityProjection,
  ActivityState,
  AnswerProjection,
  ArtifactKind,
  ArtifactProjection,
  ConversationProjection,
  InteractionProjection,
  ProjectionSessionState,
  RevisionedProjection,
  TurnProjection,
  UserMessageProjection,
} from "./types";

export const LEGACY_STREAM_EPOCH = "legacy";

export interface ConversationProjectionOptions {
  lastTurnLifecycle?: TurnLifecycle;
  lastTurnId?: string;
  sessionState?: ProjectionSessionState;
  streamEpoch?: string;
  throughSeq?: number;
}

/** Build the canonical UI read model without changing the existing event fold. */
export function projectConversation(thread: Thread, options: ConversationProjectionOptions = {}): ConversationProjection {
  const turns = buildTurnPresentations(thread.blocks, {
    ...(options.lastTurnLifecycle ? { lastTurnLifecycle: options.lastTurnLifecycle } : {}),
    ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
  }).map(projectTurn);
  const activeTurn = turns.findLast((turn) => isLive(turn.lifecycle));
  return {
    streamEpoch: options.streamEpoch ?? thread.foldState?.streamEpoch ?? LEGACY_STREAM_EPOCH,
    throughSeq: options.throughSeq ?? thread.foldState?.lastSequence ?? maxSequence(thread.blocks),
    turns,
    ...(activeTurn ? { activeTurnId: activeTurn.id } : {}),
    sessionState: options.sessionState ?? sessionStateFor(turns),
  };
}

export function projectTurn(turn: TurnPresentation): TurnProjection {
  const answerBlock = turn.finalAgent ?? turn.provisionalAgent;
  const activities = latestByRevision(turn.activityBlocks.flatMap((block) => {
    if (block.kind === "tool" && activityPolicy(block).plane === "interaction") return [];
    return [projectActivity(block)];
  }));
  const interactions = latestByRevision(turn.interactionTools.map(projectInteraction));
  const artifacts = latestByRevision(turn.artifacts.flatMap((summary) => summary.artifacts.map((artifact) => projectArtifact(turn, summary.id, artifact))));
  const id = turn.turnId ?? turn.id;
  return {
    id,
    revision: maxRevision(turn.blocks),
    lifecycle: turn.lifecycle,
    user: turn.user ? projectUser(turn.user) : null,
    activities,
    interactions,
    ...(answerBlock ? { answer: projectAnswer(answerBlock, turn.lifecycle, answerBlock === turn.finalAgent ? "final" : "provisional") } : {}),
    artifacts,
    researchRuns: [],
  };
}

export function latestByRevision<T extends RevisionedProjection>(entities: T[]): T[] {
  const positions = new Map<string, number>();
  const result: T[] = [];
  for (const entity of entities) {
    const position = positions.get(entity.id);
    if (position === undefined) {
      positions.set(entity.id, result.length);
      result.push(entity);
      continue;
    }
    if (entity.revision > result[position].revision) result[position] = entity;
  }
  return result;
}

function projectUser(block: Extract<ThreadBlock, { kind: "user" }>): UserMessageProjection {
  return {
    id: block.itemId ?? block.id,
    revision: entityRevision(block),
    text: block.text,
    ...(block.timestamp ? { timestamp: block.timestamp } : {}),
    ...(block.images ? { images: block.images } : {}),
  };
}

function projectActivity(block: Extract<ThreadBlock, { kind: "agent" | "thinking" | "tool" }>): ActivityProjection {
  if (block.kind !== "tool") {
    const title = block.kind === "thinking" ? "Thinking" : "Progress update";
    return {
      id: block.itemId ?? block.id,
      revision: entityRevision(block),
      kind: "process_summary",
      state: block.partial ? "running" : "success",
      title,
      subtitle: block.parts.map((part) => part.text).join(""),
      ...(block.kind === "thinking" && block.startedAt ? { startedAt: block.startedAt } : {}),
      ...(block.kind === "thinking" && block.endedAt ? { endedAt: block.endedAt } : {}),
    };
  }
  return {
    // event-fold already makes retries/attempts distinct in the block id;
    // an enclosing protocol item id is not necessarily attempt-specific.
    id: block.id,
    revision: entityRevision(block),
    kind: activityKind(block),
    state: activityState(block.status),
    title: block.presentation?.title ?? block.title ?? block.tool,
    ...(block.presentation?.description ? { subtitle: block.presentation.description } : {}),
    toolName: block.tool,
    ...(block.input ? { inputSummary: block.input } : {}),
    ...(block.output ?? block.partialOutput ? { outputSummary: block.output ?? block.partialOutput } : {}),
    detailRef: block.id,
    ...(block.startedAt ? { startedAt: block.startedAt } : {}),
    ...(block.endedAt ? { endedAt: block.endedAt } : {}),
    presentation: {
      renderer: activityKind(block),
      groupKey: `${activityKind(block)}:${block.presentation?.domain ?? "generic"}`,
      importance: block.presentation?.importance === "interrupt" ? "high" : "normal",
    },
  };
}

function projectInteraction(block: ToolCallBlock): InteractionProjection {
  const tool = block.tool.trim().toLowerCase();
  const kind = tool.includes("permission") || block.status === "waiting-approval"
    ? "permission"
    : tool.includes("confirm") ? "confirmation" : "question";
  return {
    id: block.id,
    revision: entityRevision(block),
    kind,
    state: block.status === "error" ? "cancelled" : block.status === "done" || block.interactionResolved ? "submitted" : "pending",
    title: block.presentation?.title ?? block.title ?? block.tool,
    ...(block.presentation?.description ? { description: block.presentation.description } : {}),
    relatedActivityId: block.id,
  };
}

function projectAnswer(block: AgentMessageBlock, lifecycle: TurnLifecycle, role: AnswerProjection["role"]): AnswerProjection {
  return {
    id: block.itemId ?? block.id,
    revision: entityRevision(block),
    role,
    state: answerState(block, lifecycle),
    markdown: block.parts.map((part) => part.text).join(""),
  };
}

function projectArtifact(turn: TurnPresentation, summaryId: string, artifact: TurnArtifactItem): ArtifactProjection {
  const id = artifact.artifactId
    ? `${artifact.artifactId}:${artifact.version ?? 0}`
    : `${summaryId}:${artifact.path}`;
  return {
    id,
    revision: artifact.version ?? 0,
    ...(artifact.version !== undefined ? { version: artifact.version } : {}),
    filename: artifact.path.split("/").at(-1) ?? artifact.path,
    path: artifact.path,
    kind: artifactKind(artifact),
    mime: artifact.mime,
    size: artifact.size,
    state: "published",
    generatedBy: { ...(turn.turnId ? { turnId: turn.turnId } : {}) },
  };
}

function activityKind(block: ToolCallBlock): ActivityKind {
  const tool = block.tool.trim().toLowerCase();
  if (block.childSessionId || tool.includes("subagent") || tool.includes("agent")) return "subagent";
  if (tool.includes("python") || tool.includes("kernel") || tool === "r" || tool.includes("notebook")) return "kernel";
  if (block.presentation?.domain === "research" || /pubmed|literature|crossref|semantic_scholar/.test(tool)) return "literature";
  if (/dataset|csv|parquet|table/.test(tool)) return "dataset";
  if (/read|write|file|grep|glob|find|list/.test(tool)) return "file";
  if (/environment|package|install|dependency/.test(tool)) return "environment";
  if (/research|candidate|optimization/.test(tool)) return "research";
  return block.tool ? "tool" : "unknown";
}

function activityState(status: ToolCallBlock["status"]): ActivityState {
  if (status === "done") return "success";
  if (status === "error") return "error";
  if (status === "waiting-approval") return "waiting_approval";
  if (status === "running") return "running";
  return "queued";
}

function answerState(block: AgentMessageBlock, lifecycle: TurnLifecycle): AnswerProjection["state"] {
  if (lifecycle === "failed") return "error";
  if (lifecycle === "aborted") return "interrupted";
  if (block.partial || isLive(lifecycle)) return "streaming";
  return "complete";
}

function artifactKind(artifact: TurnArtifactItem): ArtifactKind {
  if (artifact.kind === "figure" || artifact.mime.startsWith("image/")) return "image";
  if (artifact.kind === "table") return "table";
  if (artifact.kind === "data" || /csv|parquet|json/.test(artifact.mime)) return "dataset";
  if (artifact.kind === "notebook") return "notebook";
  if (artifact.kind === "code" || artifact.kind === "script") return "code";
  if (artifact.kind === "report" || /pdf|document|text/.test(artifact.mime)) return "document";
  return "file";
}

function entityRevision(identity: ConversationBlockIdentity): number {
  return Math.max(nonNegativeInteger(identity.revision) ?? 0, nonNegativeInteger(identity.sequence) ?? 0);
}

function maxRevision(blocks: ThreadBlock[]): number {
  return blocks.reduce((maximum, block) => Math.max(maximum, "revision" in block || "sequence" in block ? entityRevision(block) : 0), 0);
}

function maxSequence(blocks: ThreadBlock[]): number {
  return blocks.reduce((maximum, block) => Math.max(maximum, nonNegativeInteger("sequence" in block ? block.sequence : undefined) ?? 0), 0);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function sessionStateFor(turns: TurnProjection[]): ProjectionSessionState {
  const lifecycle = turns.at(-1)?.lifecycle;
  if (lifecycle === "waiting") return "waiting_user";
  if (lifecycle === "recovering") return "recovering";
  if (lifecycle === "failed") return "error";
  return lifecycle && isLive(lifecycle) ? "running" : "idle";
}

function isLive(lifecycle: TurnLifecycle): boolean {
  return lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering" || lifecycle === "stopping";
}
