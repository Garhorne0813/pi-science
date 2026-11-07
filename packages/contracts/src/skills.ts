import { z } from "zod";

export const skillThirdPartySchema = z
  .object({
    kind: z.enum(["weights", "service", "dataset", "library", "other"]).default("other"),
    name: z.string().min(1).max(200),
    provider: z.string().max(200).nullish(),
    license: z.string().max(120).nullish(),
    terms_url: z.string().nullish(),
    info_url: z.string().nullish(),
    privacy_url: z.string().nullish(),
  })
  .passthrough();

export const skillRequirementSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: z
      .enum(["command", "python", "node", "r", "gpu", "package", "service", "other"])
      .default("other"),
    version: z.string().max(120).nullish(),
    optional: z.boolean().default(false),
    description: z.string().max(500).nullish(),
  })
  .passthrough();

export const skillMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    description: z.string().min(1).max(4000),
    version: z.string().max(80).default("0.1.0"),
    // Skills must declare their license explicitly; "UNLICENSED" (never a
    // silent Apache-2.0 assumption) is the fallback until an author declares
    // one. Catalog validation warns on the undeclared case and rejects builtin
    // skills that omit it.
    license: z.string().max(120).default("UNLICENSED"),
    // Agent Skills interop hint (e.g. "claude", "pi", "*"). Accepts lists or
    // scalars from foreign front matter; pi-science never enforces
    // Claude-only semantics. Non-string values are coerced downstream.
    compatibility: z
      .union([z.string(), z.array(z.string()), z.number(), z.boolean()])
      .nullish()
      .catch(undefined),
    category: z.string().max(80).default("general"),
    requirements: z.array(skillRequirementSchema).default([]),
    third_party: z.array(skillThirdPartySchema).default([]),
    risk: z.enum(["low", "medium", "high"]).default("low"),
    entrypoints: z.array(z.string()).default([]),
    required_tools: z.array(z.string()).default([]),
    required_mcp_tools: z.array(z.string()).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export const skillValidationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  checked_at: z.string(),
});

export const skillFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["skill", "reference", "helper", "requirement", "other"]).default("other"),
  size: z.number().int().nonnegative(),
});

export const skillInfoSchema = z
  .object({
    skill_id: z.string(),
    digest: z.string(),
    name: z.string(),
    description: z.string(),
    version: z.string(),
    category: z.string(),
    license: z.string(),
    compatibility: z.string().nullish(),
    risk: z.enum(["low", "medium", "high"]),
    quality: z.enum(["draft", "validated", "verified", "deprecated"]).default("draft"),
    location: z.string(),
    source: z.enum(["builtin", "project", "user"]),
    enabled: z.boolean().default(true),
    requirements: z.array(skillRequirementSchema).default([]),
    third_party: z.array(skillThirdPartySchema).default([]),
    entrypoints: z.array(z.string()).default([]),
    required_tools: z.array(z.string()).default([]),
    required_mcp_tools: z.array(z.string()).default([]),
    files: z.array(skillFileSchema).default([]),
    validation: skillValidationSchema,
    shadowed: z.array(z.string()).default([]),
  })
  .passthrough();

export type SkillThirdParty = z.infer<typeof skillThirdPartySchema>;
export type SkillRequirement = z.infer<typeof skillRequirementSchema>;
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export type SkillValidation = z.infer<typeof skillValidationSchema>;
export type SkillFile = z.infer<typeof skillFileSchema>;
export const skillContentSchema = z
  .object({
    skill_id: z.string().min(1),
    name: z.string().min(1),
    digest: z.string().min(1),
    source: z.enum(["builtin", "project", "user"]),
    // Relative/display path (e.g. ".pi/skills/x/SKILL.md") — never an absolute path.
    location: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.startsWith("\\") &&
          !/^[A-Za-z]:[\\/]/.test(value) &&
          !value.startsWith("~/") &&
          !value.startsWith("~\\"),
        "location must be a relative display path",
      ),
    content: z.string(),
  })
  .passthrough();

export type SkillContent = z.infer<typeof skillContentSchema>;
export type SkillInfo = z.infer<typeof skillInfoSchema>;
