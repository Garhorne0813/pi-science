import { createHash } from "node:crypto";
import { unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PromptIdentityApi = {
  on(event: string, handler: (event: any, context: any) => unknown): void;
};

type Association = { sessionId: string; clientMessageId: string };

/** Install the controlled Pi Orbit persistence hook. The control plane writes
 *  one short-lived association marker before submitting a serialized prompt.
 *  This hook consumes it at before_agent_start and puts the ID directly onto
 *  the actual user message before Pi appends that message to its JSONL file.
 *  No text, timestamp, entry order, or nearby-message inference is involved. */
export function installPromptIdentity(piValue: unknown): void {
  const pi = piValue as PromptIdentityApi;
  const active = new Map<string, Association>();

  pi.on("before_agent_start", (_event, context) => {
    const sessionId = context.sessionManager.getSessionId();
    const path = markerPath(context.cwd, sessionId);
    try {
      const marker = JSON.parse(readFileSync(path, "utf8")) as {
        version?: unknown;
        session_id?: unknown;
        client_message_id?: unknown;
      };
      // Consume only a well-formed marker for this exact Pi session.
      unlinkSync(path);
      if (marker.version !== 1 || marker.session_id !== sessionId || typeof marker.client_message_id !== "string") return;
      active.set(sessionId, { sessionId, clientMessageId: marker.client_message_id });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });

  pi.on("message_end", (event, context) => {
    if (event.message?.role !== "user") return;
    const sessionId = context.sessionManager.getSessionId();
    const association = active.get(sessionId);
    if (!association) return;
    active.delete(sessionId);
    return { message: { ...event.message, client_message_id: association.clientMessageId } };
  });

  pi.on("agent_settled", (_event, context) => {
    active.delete(context.sessionManager.getSessionId());
  });
}

export default function promptIdentityExtension(pi: unknown): void {
  installPromptIdentity(pi);
}

function markerPath(cwd: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(cwd, ".pi-science", "prompt-associations", `${key}.json`);
}
