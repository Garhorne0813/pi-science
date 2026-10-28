export type Operation = "ls" | "glob" | "grep";
export interface DiscoveryInput { path?: string; pattern?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; limit: number }
export interface DiscoveryResult {
  entries?: Array<{ path: string; type: "file" | "directory" }>;
  files?: string[];
  matches?: Array<{ path: string; line: number; column: number; text: string }>;
  truncated: boolean;
  limit: number;
  truncationReason?: "limit" | "bytes" | "scan_budget";
}
export class DiscoveryError extends Error {
  constructor(readonly code: string) { super(code); }
}
export const discoveryBackendAvailable = () => process.platform === "linux";
