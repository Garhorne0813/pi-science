import { readFile } from "node:fs/promises";
import { z } from "zod";
export interface Budget { deadline: number; maxExecutions: number; used: number }
export const MAX_SECONDS = 3600;
export const MAX_EXECUTIONS = 100;
const budgetSchema = z.object({ deadline: z.number().finite().positive(), maxExecutions: z.number().int().min(1).max(MAX_EXECUTIONS), used: z.number().int().min(0).max(MAX_EXECUTIONS),
  // Historical official-score counters are ignored; consumed calls and deadline remain authoritative.
  maxEvaluations: z.unknown().optional(), evaluations: z.unknown().optional(),
}).strict().transform(({ deadline, maxExecutions, used }) => ({ deadline, maxExecutions, used }));
export async function readBudget(path: string): Promise<Budget | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const parsed = budgetSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("Invalid saved execution budget; refusing to reset its limits");
  return parsed.data;
}
