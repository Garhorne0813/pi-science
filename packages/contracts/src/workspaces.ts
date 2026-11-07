import { z } from "zod";

export const workspaceInfoSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  project_id: z.string().min(1).optional(),
  session_count: z.number().int().nonnegative().default(0),
  last_modified: z.string().default(""),
  last_activity_at: z.string().optional(),
});

export const fileListEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  isDir: z.boolean(),
  size: z.number().nonnegative(),
  modified: z.number(),
});

export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;
export type FileListEntry = z.infer<typeof fileListEntrySchema>;
