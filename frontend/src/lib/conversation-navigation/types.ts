/** Wire types for the conversation navigation endpoints
 *  (bookmarks, read state, attention). Mirrors the server contracts in
 *  packages/contracts — keep both in sync. */

export type BookmarkStatus = "accepted" | "proposed" | "rejected";
export type BookmarkOrigin = "user" | "agent_proposal" | "legacy_auto";

export interface ConversationBookmark {
  bookmark_id: string;
  session_id: string;
  message_id: string;
  role: "user" | "assistant";
  quote: string;
  label: string | null;
  origin: BookmarkOrigin;
  status: BookmarkStatus;
  created_at: string;
  updated_at: string;
}

export interface ConversationBookmarkListResponse {
  bookmarks: ConversationBookmark[];
  legacy_skipped: number;
}

export interface ConversationBookmarkProposeResponse {
  session_id: string;
  bookmarks: ConversationBookmark[];
  skipped: number;
}

export interface ConversationReadState {
  session_id: string;
  anchor_message_id: string | null;
  at_bottom: boolean;
  seen_snapshot_version: string | null;
  updated_at: string | null;
  /** True when the persisted anchor still resolves to a message in this session. */
  anchor_available: boolean;
  /** Dynamic cursor that loads the page containing the anchor. */
  before: string | null;
}

export interface ConversationReadStateUpdate {
  anchor_message_id?: string | null;
  at_bottom?: boolean;
  mark_seen?: boolean;
}

export type AttentionStatus = "needs_you" | "running" | "unread" | "idle";

export interface ConversationAttentionItem {
  session_id: string;
  status: AttentionStatus;
  updated_at: string | null;
}

export interface ConversationAttentionResponse {
  items: ConversationAttentionItem[];
  counts: { needs_you: number; running: number; unread: number };
  truncated: boolean;
}
