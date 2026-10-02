import type { PiProcess, PiEvent } from "./pi-process.js";
import type { TaskRuntime, TaskPrompt } from "../agent/runner-transport.js";

/** All legacy stream parsing stays behind the task boundary. */
export class OrbitTaskRuntime implements TaskRuntime {
  constructor(private readonly process: PiProcess) {}
  async initialize(): Promise<void> {
    const result = await this.process.sendCommand("get_state");
    if (!result.success) throw new Error(String(result.error ?? "unable to initialize task runtime"));
  }
  async prompt(request: TaskPrompt): Promise<string> {
    let text = "";
    let finish!: (error?: Error) => void;
    const event = (event: PiEvent) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (["text_delta", "text"].includes(String(update?.type))) {
          text += String(update?.delta ?? update?.text ?? update?.content ?? "");
          if (Buffer.byteLength(text) > 2_000_000) finish(new Error("task response exceeds 2 MB"));
        }
      }
      if (event.type === "message_end") {
        const usage = (event.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined)?.usage;
        request.onUsage?.({ model_tokens: (usage?.input ?? 0) + (usage?.output ?? 0), cost_usd: usage?.cost?.total ?? 0 });
      }
      if (event.type === "agent_settled") finish();
    };
    const exit = () => finish(new Error("task runtime exited before completing"));
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("task runtime timed out")), Math.max(1, request.deadline - Date.now()));
      let done = false;
      finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.process.off("event", event); this.process.off("exit", exit);
        error ? reject(error) : resolve();
      };
      this.process.on("event", event); this.process.once("exit", exit);
    });
    void completed.catch(() => undefined);
    try {
      const admission = this.process.sendCommand("prompt", { message: request.message }).then((admitted) => {
        if (!admitted.success) throw new Error(String(admitted.error ?? "task rejected prompt"));
      });
      await Promise.all([admission, completed]);
      return text;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
