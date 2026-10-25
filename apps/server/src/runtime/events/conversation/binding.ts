import type { ProductInput } from "../product-input.js";
import type { AssistantContentKind } from "../assistant-content.js";
import type { RuntimeEventSource } from "../../agent/agent-runtime-types.js";
import type { BindingOptions, StderrChunk } from "./types.js";
import { STDERR_WINDOW_MS } from "./limits.js";
import { cap } from "./text.js";
import { streamKey } from "./records.js";
import type { HubLogger } from "./types.js";
import { matchesWorkspace } from "./records.js";

interface BindingOperations {
  publish(cwd: string, sessionId: string, payload: Record<string, unknown>): Promise<void>;
  normalize(cwd: string, sessionId: string, event: ProductInput): Record<string, unknown>[];
  queueText(cwd: string, sessionId: string, payload: Record<string, unknown>, kind: AssistantContentKind): Promise<void>;
  flushPendingText(cwd: string, sessionId: string): Promise<void>;
  log: HubLogger;
}
/** Own per-process binding, observation queues and expected-exit diagnostics. */
export class ConversationBindings {
  private readonly observing = new Map<Promise<void>, string>();
  private readonly bound = new WeakSet<RuntimeEventSource>();
  private readonly expectedExits = new WeakSet<RuntimeEventSource>();
  private readonly stderrLogAt = new WeakMap<RuntimeEventSource, number>();
  constructor(private readonly operations: BindingOperations) {}
  pending(cwd?: string): Promise<void>[] {
    return [...this.observing].filter(([, key]) => matchesWorkspace(key, cwd)).map(([promise]) => promise);
  }
  private trackObservation(pending: Promise<void>, cwd: string, sessionId: string): void {
    this.observing.set(pending, streamKey(cwd, sessionId));
    const done = () => this.observing.delete(pending);
    void pending.then(done, done);
  }
  expectExit(process: RuntimeEventSource): void {
    this.expectedExits.add(process);
  }
  private eventSessionId(event: ProductInput): string | null {
    for (const value of [event.sessionId]) {
      if (typeof value === "string" && value) return value;
    }
    return null;
  }
  bind(cwd: string, process: RuntimeEventSource, options: BindingOptions): void {
    if (this.bound.has(process)) return;
    this.bound.add(process);
    const boundAt = Date.now();
    let turnNumber = 0;
    let turnStartedAt = boundAt;
    let eventQueue = Promise.resolve();
    const stderr: StderrChunk[] = [];
    process.on("stderr", (chunk: string) => {
      stderr.push({ text: cap(chunk, 4_000), at: Date.now(), turn: turnNumber });
      while (stderr.reduce((size, item) => size + item.text.length, 0) > 16_000) stderr.shift();
      // Forward diagnostics immediately (throttled) instead of hiding them in
      // the exit-only buffer: a silently failed event stream must be visible
      // in the control-plane log at the moment it happens.
      const now = Date.now();
      const last = this.stderrLogAt.get(process) ?? 0;
      if (now - last >= 2_000) {
        this.stderrLogAt.set(process, now);
        this.operations.log("warn", `Agent worker stderr: ${cap(chunk, 500).trimEnd()}`);
      }
    });
    process.on("malformed", (line: string) => {
      const sessionId = options.activeSessionId();
      if (sessionId) void this.operations.publish(cwd, sessionId, { type: "error", sessionId, message: `Malformed agent worker output: ${cap(line, 500)}`, recoverable: true });
    });
    process.on("event", (input: ProductInput) => {
      const event = input;
      const sessionId = this.eventSessionId(event) ?? options.activeSessionId();
      if (!sessionId) return;
      if (event.type === "operation.started") {
        turnNumber += 1;
        turnStartedAt = Date.now();
        stderr.length = 0;
        options.onBusy(true);
      }
      if (event.type === "operation.settled") options.onBusy(false);
      eventQueue = eventQueue.catch(() => undefined).then(async () => {
        const normalizedEvents = this.operations.normalize(cwd, sessionId, event);
        const owner = normalizedEvents.find((item) => typeof item.turnId === "string");
        const identity = owner ? { turnId: String(owner.turnId), turnOrdinal: Number(owner.turnOrdinal) } : undefined;
        for (const normalized of normalizedEvents) {
          if ((normalized.type === "message.delta" || normalized.type === "message.reasoning.delta")) {
            await this.operations.queueText(cwd, sessionId, normalized, normalized.kind === "thinking" ? "thinking" : "text");
          } else {
            await this.operations.flushPendingText(cwd, sessionId);
            await this.operations.publish(cwd, sessionId, normalized);
          }
        }
        await Promise.resolve(options.observe?.(input, sessionId, identity)).catch(() => undefined);
      });
      this.trackObservation(eventQueue, cwd, sessionId);
    });
    process.on("exit", ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
      const sessionId = options.activeSessionId();
      options.onBusy(false);
      options.onExit();
      if (this.expectedExits.has(process)) return;
      if (!sessionId) return;
      const now = Date.now();
      const recentStderr = stderr
        .filter((item) => item.turn === turnNumber && item.at >= turnStartedAt && now - item.at <= STDERR_WINDOW_MS)
        .map((item) => item.text)
        .join("");
      const suffix = recentStderr ? `\n${cap(recentStderr, 8_000)}` : "";
      const terminal = eventQueue.catch(() => undefined).then(async () => {
        await this.operations.publish(cwd, sessionId, {
          type: "error",
          sessionId,
          message: `Agent worker exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.${suffix}`,
          terminal: true,
        });
        await this.operations.publish(cwd, sessionId, { type: "runtime.paused", sessionId });
      });
      this.trackObservation(terminal, cwd, sessionId);
    });
  }
}
