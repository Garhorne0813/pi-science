import { z } from "zod";

export const artifactManifestSchema = z
  .object({
    artifact_id: z.string().min(1),
    version: z.number().int().positive(),
    path: z.string().min(1),
    kind: z.string().min(1),
    mime: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().min(16).max(64),
    published_at: z.string(),
  })
  .passthrough();

export const provenanceRecordSchema = z
  .object({
    path: z.string(),
    version: z.number().int().nonnegative(),
    ts: z.number().finite(),
    tool: z.string(),
    toolCallId: z.string().optional(),
    sessionId: z.string(),
    model: z.string().optional(),
    contentHash: z.string().optional(),
    content: z.string().nullable().optional(),
    diff: z.string().optional(),
    log: z.string().optional(),
    executionId: z.string().optional(),
    env: z
      .object({
        python: z.string().optional(),
        platform: z.string().optional(),
        app: z.string().optional(),
        packages: z.object({ hash: z.string(), count: z.number().int().nonnegative() }).optional(),
        packages_hash: z.string().optional(),
        package_count: z.number().int().nonnegative().optional(),
        cpu_count: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const provenanceVersionsResponseSchema = z.object({
  path: z.string(),
  versions: z.array(provenanceRecordSchema).default([]),
});

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;
export type ProvenanceEnvironment = NonNullable<ProvenanceRecord["env"]>;
