export type McpEnvironmentBinding =
  | { kind: "literal"; value: string }
  | { kind: "environment"; name: string }
  | { kind: "credential"; credential_ref: string };
