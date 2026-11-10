export function sessionRuntimeStatus(code: unknown): number {
  switch (String(code ?? "")) {
    case "workspace_invalid":
      return 403;
    case "not_found":
    case "runtime_not_found":
    case "session_mismatch":
      return 404;
    case "client_message_id_conflict":
    case "prompt_request_in_flight":
    case "stale_approval":
    case "project_trust_required":
    case "runtime_workspace_mismatch":
    case "session_in_use":
    case "runtime_busy":
    case "pi_session_mismatch":
    case "busy":
    case "approval_revision_conflict":
    case "session_busy":
    case "cancelled":
      return 409;
    case "permission_transition_failed":
      return 503;
    case "runtime_evicted":
      return 410;
    case "invalid_model":
    case "legacy_session_invalid":
    case "legacy_session_unsupported":
    case "legacy_import_failed":
    case "runtime_initialization_failed":
      return 422;
    case "runtime_capacity_exceeded":
    case "agent_turn_capacity_exceeded":
      return 429;
    case "invalid_request":
      return 400;
    case "environment_failed":
      return 500;
    case "spawn_failed":
    case "configuration_reload_failed":
    case "process_closed":
    case "process_exit":
      return 503;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}
