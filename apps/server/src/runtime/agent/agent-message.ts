import type { UserMessage } from "@earendil-works/pi-ai";

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
