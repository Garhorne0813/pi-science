import { z } from "zod";

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelSelectionSchema = z.object({
  model: z.string().regex(/^[^/\s]+\/\S+$/, "Model must use provider/model notation").nullable(),
  thinking: thinkingLevelSchema,
}).strict();
export const defaultModelSelectionSchema = z.object({ scope: z.literal("default"), selection: modelSelectionSchema });
export const sessionModelSelectionSchema = z.object({ scope: z.literal("session"), session_id: z.string().min(1), selection: modelSelectionSchema });
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type DefaultModelSelection = z.infer<typeof defaultModelSelectionSchema>;
export type SessionModelSelection = z.infer<typeof sessionModelSelectionSchema>;
