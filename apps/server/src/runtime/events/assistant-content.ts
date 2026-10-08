export type AssistantContentKind = "text" | "thinking";

/** Content facts projected directly from a Harness message frame. */
export interface AssistantContent {
  kind: AssistantContentKind;
  type: string;
  text: string;
  snapshot?: string;
  messageId: string;
  contentIndex: string;
  presentationRole?: "intermediate" | "final";
}
