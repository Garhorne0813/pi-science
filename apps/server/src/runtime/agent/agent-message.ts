import type { UserMessage } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

export function promptOperationId(sessionId: string, clientMessageId: string): string {
  return `prompt-${createHash("sha256").update(`${sessionId}\0${clientMessageId}`).digest("hex")}`;
}

declare module "@earendil-works/pi-ai" {
  interface UserMessage {
    /** Browser send identity persisted with the original user message. */
    client_message_id?: string;
  }
}

export function userPrompt(text: string, clientMessageId?: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
  };
}
