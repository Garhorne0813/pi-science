import { ApplicationError } from "../application-error.js";
import { z } from "zod";
import {
  contentSchema,
  settingsSchema,
  memoryBrowseQuerySchema,
  type MemoryRecord,
  type MemorySettings,
  type MemoryBrowseResult,
} from "@pi-science/contracts";

const empty = z.object({}).passthrough();
const id = z.object({ id: z.string() }).passthrough();
const cas = id.extend({ expectedRevision: z.number(), contentHash: z.string() });
const lease = id.extend({ leaseToken: z.string() });
const usage = lease.extend({
  tokens: z.number(),
  costUsd: z.number(),
  model: z.string().optional(),
});
const kind = z.enum(["dream", "extraction"]);
const search = memoryBrowseQuerySchema.partial().passthrough();
const review = z
  .object({
    id: z.string().optional(),
    proposalId: z.string().optional(),
    expectedRevision: z.number().optional(),
    contentHash: z.string().optional(),
  })
  .passthrough();

/** IPC schemas belong to the Memory domain; the SQLite transport only carries them. */
export const memoryCommandSchemas = {
  settings: empty,
  "settings.update": z.object({ expectedRevision: z.number(), settings: settingsSchema }),
  "project.settings": empty,
  "project.settings.update": z.object({ autoRecall: z.boolean() }),
  browse: search,
  list: search,
  "agent.search": search,
  recall: search,
  read: id,
  write: z
    .object({
      id: z.string().optional(),
      content: contentSchema.optional(),
      operation: z.enum(["append", "replace", "remove"]).optional(),
      expectedRevision: z.number().optional(),
      contentHash: z.string().optional(),
      reason: z.string().optional(),
      operationId: z.string().optional(),
    })
    .passthrough(),
  approve: review,
  reject: review,
  reviews: empty,
  history: id,
  delete: cas,
  "mark.stale": cas,
  frames: empty,
  "frame.delete": z.object({ sessionId: z.string() }),
  categories: empty,
  "category.write": z.object({
    id: z.string().optional(),
    name: z.string(),
    autoRecall: z.boolean(),
  }),
  touch: z.object({ cwd: z.string() }),
  schedules: empty,
  "schedule.success": empty,
  "schedule.error": z.object({ diagnostic: z.object({ code: z.string(), stage: z.string() }) }),
  cursor: z.object({ sessionId: z.string() }),
  "run.skip": z.object({
    kind,
    reason: z.string(),
    purpose: z.string().optional(),
    diagnostic: z.record(z.string(), z.unknown()).optional(),
  }),
  "run.latest": z.object({ kind }),
  "run.pending": empty,
  runs: empty,
  "run.reconcile": empty,
  "run.enqueue": z.object({ kind, logicalKey: z.string(), deadline: z.number() }).passthrough(),
  "run.claim": id,
  "run.cancel": id,
  "run.get": id,
  "run.retry": id.extend({ deadline: z.number() }),
  "run.dispatch": lease,
  "run.heartbeat": lease,
  "run.usage": usage,
  "run.finish": usage.extend({ outputs: z.array(z.unknown()) }),
  "run.fail": lease.extend({
    error: z.string(),
    tokens: z.number().optional(),
    costUsd: z.number().optional(),
    model: z.string().optional(),
  }),
  export: empty,
} as const;
export type MemoryAction = keyof typeof memoryCommandSchemas;
export type MemoryInput<K extends MemoryAction> = z.input<(typeof memoryCommandSchemas)[K]>;
export interface MemoryProposal {
  id: string;
  recordId: string;
  expectedRevision: number;
  expectedHash: string;
  contentHash: string;
  candidate: MemoryRecord;
  status: string;
  reason: string;
  mode: string;
  current?: MemoryRecord;
}
export interface MemoryRun {
  id: string;
  kind: "dream" | "extraction";
  status: string;
  createdAt: number;
  deadline: number;
  purpose?: string;
  evidence?: string;
  watermark?: number;
  endedAt?: number;
  startedAt?: number;
  leaseUntil?: number;
  leaseToken?: string;
  sessionId?: string;
  resolvedModel?: string;
  records?: MemoryRecord[];
  messages?: Array<{ id: string; role: string; text: string }>;
  error?: string;
  reason?: string;
  diagnostic?: Record<string, unknown>;
}
export type ClaimedMemoryRun = MemoryRun & { leaseToken: string; leaseUntil: number };
export interface MemorySkip {
  purpose?: string;
  id: string;
  kind: "dream" | "extraction";
  status: "skipped";
  createdAt: number;
  reason: string;
}
export type MemoryWriteResult =
  | { record: MemoryRecord; proposal?: never }
  | { proposal: MemoryProposal; record?: never };
interface MemoryOutputs {
  settings: MemorySettings;
  "settings.update": MemorySettings;
  "project.settings": { autoRecall: boolean };
  "project.settings.update": { autoRecall: boolean };
  browse: MemoryBrowseResult;
  list: { records: MemoryRecord[] };
  recall: { records: MemoryRecord[] };
  "agent.search": {
    records: Array<
      Omit<MemoryRecord, "body" | "sources"> & { preview: string; sourceCount: number }
    >;
    truncated: boolean;
  };
  read: { record: MemoryRecord };
  write: MemoryWriteResult;
  approve: MemoryWriteResult;
  reject: MemoryWriteResult;
  reviews: { records: MemoryRecord[]; proposals: MemoryProposal[] };
  history: { revisions: unknown[]; reviews: unknown[] };
  frames: string[];
  categories: { categories: Array<{ id: string; name: string; autoRecall: number }> };
  "category.write": { id: string };
  schedules: Array<{
    project_id: string;
    cwd: string;
    last_interaction: number;
    next_scan_at: number;
  }>;
  "schedule.error": MemorySkip;
  cursor: number;
  "run.skip": MemorySkip;
  "run.latest": MemoryRun | null;
  "run.pending": { runs: MemoryRun[] };
  runs: { runs: Array<MemoryRun | MemorySkip> };
  "run.enqueue": MemoryRun;
  "run.claim": ClaimedMemoryRun | null;
  "run.cancel": MemoryRun;
  "run.get": MemoryRun;
  "run.retry": MemoryRun;
  "run.finish": MemoryRun;
  "run.fail": MemoryRun;
  export: {
    version: number;
    records: MemoryRecord[];
    history: unknown[];
    categories: MemoryOutputs["categories"];
  };
}
type SuccessActions =
  | "delete"
  | "mark.stale"
  | "frame.delete"
  | "touch"
  | "schedule.success"
  | "run.reconcile"
  | "run.dispatch"
  | "run.heartbeat"
  | "run.usage";
export type MemoryCommands = {
  [K in MemoryAction]: {
    input: MemoryInput<K>;
    output: K extends keyof MemoryOutputs
      ? MemoryOutputs[K]
      : K extends SuccessActions
        ? { ok: true }
        : never;
  };
};
export type MemoryOutput<K extends MemoryAction> = MemoryCommands[K]["output"];
export type MemoryCommand = {
  [K in MemoryAction]: {
    action: K;
    input: MemoryInput<K>;
    context: import("@pi-science/contracts").MemoryContext;
  };
}[MemoryAction];
export function parseMemoryInput<K extends MemoryAction>(
  action: K,
  input: unknown,
): MemoryInput<K> {
  const parsed = memoryCommandSchemas[action].safeParse(input);
  if (!parsed.success)
    throw new ApplicationError(
      "invalid_input",
      "invalid_memory_command",
      "Invalid Memory command input",
      { fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
    );
  return parsed.data as MemoryInput<K>;
}
export function parseMemoryCommand(value: unknown): MemoryCommand {
  const parsed = z
    .object({
      action: z.enum(Object.keys(memoryCommandSchemas) as [MemoryAction, ...MemoryAction[]]),
      context: z.object({
        ownerId: z.string(),
        projectId: z.string(),
        actor: z.enum(["user", "agent", "extractor", "dream"]),
        sessionId: z.string().optional(),
        agentKey: z.string().optional(),
      }),
      input: z.unknown(),
    })
    .safeParse(value);
  if (!parsed.success)
    throw new ApplicationError(
      "invalid_input",
      "invalid_memory_command",
      "Invalid Memory command envelope",
    );
  const envelope = parsed.data;
  return { ...envelope, input: parseMemoryInput(envelope.action, envelope.input) } as MemoryCommand;
}
