import { z } from "zod";
export const sourceSchema = z
  .object({
    kind: z.enum([
      "message",
      "session",
      "run",
      "artifact",
      "file",
      "citation",
      "memory",
    ]),
    locator: z.string().min(1).max(500),
    projectId: z.string().max(200).optional(),
    digest: z.string().max(128).optional(),
    version: z.string().max(100).optional(),
  })
  .strict();
export const contentSchema = z
  .object({
    scope: z.enum(["profile", "project", "artifact", "frame"]),
    kind: z.enum([
      "preference",
      "workflow",
      "environment",
      "reference",
      "observation",
      "finding",
      "decision",
    ]),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    artifactId: z.string().max(200).optional(),
    artifactVersionId: z.string().max(100).optional(),
    subjectFrameId: z.string().max(200).optional(),
    categoryId: z.string().max(100).optional(),
    evidenceLevel: z
      .enum(["user_stated", "observed", "inferred"])
      .default("inferred"),
    sources: z.array(sourceSchema).max(20).default([]),
  })
  .strict();
export type MemoryContent = z.infer<typeof contentSchema>;
export type MemoryContext = {
  ownerId: string;
  projectId: string;
  sessionId?: string;
  actor: "user" | "agent" | "extractor" | "dream";
  agentKey?: string;
};
export type MemoryRecord = MemoryContent & {
  id: string;
  ownerId: string;
  projectId?: string;
  agentKey?: string;
  origin: "user_manual" | "agent_tool" | "background_extractor" | "dream";
  status:
    | "active"
    | "pending_review"
    | "needs_review"
    | "rejected"
    | "superseded"
    | "archived";
  revision: number;
  contentHash: string;
  reviewRequired: boolean;
  reviewStatus: "not_required" | "pending" | "approved" | "rejected" | "stale";
  approvedContentHash?: string;
  createdAt: number;
  updatedAt: number;
};
const windowSchema = z
  .object({
    enabled: z.boolean().default(true),
    start: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("00:00"),
    end: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("06:00"),
    timeZone: z
      .string()
      .refine((v) => {
        try {
          if (
            v !== "UTC" &&
            v !== "GMT" &&
            !/^[A-Za-z_+-]+\/[A-Za-z0-9_+/-]+$/.test(v)
          )
            return false;
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Invalid IANA time zone")
      .default("UTC"),
  })
  .strict()
  .refine(
    (v) => !v.enabled || v.start !== v.end,
    "Window start and end must differ",
  );
export const settingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    review: z
      .object({
        mode: z.enum(["smart", "all_manual"]).default("smart"),
        scientificClaimsRequireHuman: z.literal(true).default(true),
      })
      .strict()
      .default({ mode: "smart", scientificClaimsRequireHuman: true }),
    recall: z
      .object({
        enabled: z.boolean().default(true),
        maxItemsPerTurn: z.number().int().min(1).max(6).default(6),
        maxProfileItems: z.number().int().min(0).max(12).default(12),
        maxTokensPerTurn: z.number().int().min(100).max(2500).default(2500),
      })
      .strict()
      .default({
        enabled: true,
        maxItemsPerTurn: 6,
        maxProfileItems: 12,
        maxTokensPerTurn: 2500,
      }),
    extraction: z
      .object({
        enabled: z.boolean().default(false),
        model: z.string().max(200).default("inherit"),
        minMessages: z.number().int().min(1).max(100).default(3),
      })
      .strict()
      .default({ enabled: false, model: "inherit", minMessages: 3 }),
    dream: z
      .object({
        enabled: z.boolean().default(false),
        mode: z
          .enum(["manual", "idle", "interval", "window"])
          .default("manual"),
        allowedWindow: windowSchema.default({
          enabled: true,
          start: "00:00",
          end: "06:00",
          timeZone: "UTC",
        }),
        requireIdle: z.boolean().default(true),
        idleMinutes: z.number().min(1).max(1440).default(30),
        minNewItems: z.number().int().min(1).max(1000).default(3),
        oncePerWindow: z.boolean().default(true),
        intervalHours: z.number().min(1).max(8760).default(24),
        minIntervalHours: z.number().min(0).max(8760).default(24),
        maxRuntimeMinutes: z.number().min(1).max(60).default(10),
        updatePolicy: z
          .enum(["suggest_only", "auto_low_risk"])
          .default("suggest_only"),
        model: z.string().max(200).default("inherit"),
      })
      .strict()
      .default({
        enabled: false,
        mode: "manual",
        allowedWindow: {
          enabled: true,
          start: "00:00",
          end: "06:00",
          timeZone: "UTC",
        },
        requireIdle: true,
        idleMinutes: 30,
        minNewItems: 3,
        oncePerWindow: true,
        intervalHours: 24,
        minIntervalHours: 24,
        maxRuntimeMinutes: 10,
        updatePolicy: "suggest_only",
        model: "inherit",
      }),
    budget: z
      .object({
        dailyTokens: z.number().int().min(1000).max(1000000).default(30000),
        perRunTokens: z.number().int().min(1000).max(30000).default(6000),
        dailyCostUsd: z.number().min(0.01).max(100).default(1),
      })
      .strict()
      .default({ dailyTokens: 30000, perRunTokens: 6000, dailyCostUsd: 1 }),
  })
  .strict();
export type MemorySettings = z.infer<typeof settingsSchema> & {
  revision: number;
};

/** Human record browsing; automatic recall keeps its separate bounded policy. */
export const memoryBrowseQuerySchema = z.object({
  q: z.string().max(500).default(""),
  scope: contentSchema.shape.scope.optional(),
  kind: contentSchema.shape.kind.optional(),
  status: z
    .enum([
      "active",
      "pending_review",
      "needs_review",
      "rejected",
      "superseded",
      "archived",
      "approved",
    ])
    .optional(),
  categoryId: z.string().min(1).max(100).optional(),
  sort: z.enum(["updated_desc", "created_desc", "relevance"]).optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type MemoryBrowseResult = {
  records: MemoryRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sort: "updated_desc" | "created_desc" | "relevance";
};
