/** Narrow-privilege role profiles (reverse-cs-inspiration 4.4), enforced by
 *  the Node control plane at the PiProcess command boundary — independent of
 *  prompt text. A runtime without an attached role is unrestricted (science),
 *  preserving existing behavior. */

import type { AgentRoleProfile } from "@pi-science/contracts";

/** Read-only command surface: inspection, navigation and transcript access. */
const READ_ONLY_COMMANDS = [
  "get_state", "get_session_stats", "get_available_models", "get_available_thinking_levels",
  "get_commands", "get_messages", "get_fork_messages", "get_entries", "get_tree",
  "get_last_assistant_text", "switch_session",
];

export const ROLE_PROFILES: Record<string, AgentRoleProfile> = {
  /** The unrestricted main agent. */
  science: { role: "science", read_scope: ["workspace", "transcript", "artifacts"], write_scope: ["workspace"], computational: true },
  /** Trace-only reviewer: reads transcripts and artifacts, never recomputes,
   *  never writes files, never runs code. */
  result_reviewer: {
    role: "result_reviewer",
    read_scope: ["workspace", "transcript", "artifacts"],
    write_scope: [],
    allowed_commands: [...READ_ONLY_COMMANDS, "prompt", "abort"],
    computational: false,
  },
  /** Span selector: reads the transcript, writes only bookmarks. */
  bookmarker: {
    role: "bookmarker",
    read_scope: ["transcript"],
    write_scope: ["bookmarks"],
    allowed_commands: [...READ_ONLY_COMMANDS, "abort"],
    computational: false,
  },
};

/** Whether a runtime with `role` may issue command `type`. */
export function assertCommandAllowed(role: string | undefined, type: string): { allowed: true } | { allowed: false; error: string } {
  if (role === undefined) return { allowed: true };
  const profile = ROLE_PROFILES[role];
  if (!profile) return { allowed: true };
  const allowed = profile.allowed_commands;
  if (allowed === undefined) return { allowed: true };
  if (allowed.includes(type)) return { allowed: true };
  return { allowed: false, error: `role "${role}" does not permit command "${type}"` };
}
