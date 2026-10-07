/** Product tasks expose completion and usage, never backend event streams. */
export interface TaskUsage { model_tokens: number; cost_usd: number }
export interface TaskPrompt {
  message: string;
  clientMessageId: string;
  deadline: number;
  onUsage?: (delta: TaskUsage) => void;
}
export interface TaskRuntime {
  initialize(): Promise<void>;
  prompt(request: TaskPrompt): Promise<string>;
}
