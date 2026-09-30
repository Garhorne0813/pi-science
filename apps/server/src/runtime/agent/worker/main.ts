import type { RuntimeResult } from "../agent-runtime-types.js";
import type { WorkerCommand, WorkerEvent } from "./protocol.js";
import { SessionRuntime } from "./session-runtime.js";

let runtime: SessionRuntime | undefined;
let shuttingDown = false;

function send(message: WorkerEvent): void {
  if (process.connected) process.send?.(message);
}

function errorResult(error: unknown): RuntimeResult {
  return { success: false, code: "worker_error", error: error instanceof Error ? error.message : String(error) };
}

async function handle(message: WorkerCommand): Promise<void> {
  if (!message || typeof message !== "object") return;
  if (message.type === "shutdown") {
    await shutdown();
    return;
  }
  try {
    if (message.type === "initialize") {
      if (runtime) throw new Error("worker is already initialized");
      runtime = await SessionRuntime.open(message.options, (event) => send({ type: "runtime_event", event }), (error) => {
        send({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
      send({ type: "ready", sessionId: runtime.sessionId });
      send({ type: "result", requestId: message.requestId, result: { success: true, data: { sessionId: runtime.sessionId } } });
      return;
    }
    if (!runtime) throw new Error("worker is not initialized");
    if (message.type === "notification") {
      send({ type: "result", requestId: message.requestId, result: runtime.notify(message.notification, message.params) });
      return;
    }
    const result = await runtime.command(message.command, message.params);
    send({ type: "result", requestId: message.requestId, result });
  } catch (error) {
    send({ type: "result", requestId: message.requestId, result: errorResult(error) });
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await runtime?.close(); }
  catch (error) { send({ type: "fatal", error: String(error) }); }
  process.exit(0);
}

process.on("message", (message: WorkerCommand) => { void handle(message); });
process.once("disconnect", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("uncaughtException", (error) => {
  send({ type: "fatal", error: error.message });
  process.exit(1);
});
process.once("unhandledRejection", (error) => {
  send({ type: "fatal", error: String(error) });
  process.exit(1);
});
