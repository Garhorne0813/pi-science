import { basename } from "node:path";

const SENSITIVE_FILE_NAMES = new Set([
  ".env", ".netrc", ".pgpass", ".npmrc", ".pypirc",
  "credentials", "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml", "token.json",
  "application_default_credentials.json",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
]);

const SENSITIVE_FILE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

/**
 * Shared server-side policy for files that may be surfaced automatically as
 * artifacts. Explicit file operations remain separate: this policy only
 * controls automatic discovery/probing surfaces where model text or workspace
 * scans could otherwise expose credential-like paths without a user choosing
 * the file directly.
 */
export function isArtifactSurfaceablePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((part) => part === "." || part === ".." || part.startsWith("."))) return false;

  const name = basename(normalized).toLowerCase();
  return !SENSITIVE_FILE_NAMES.has(name)
    && !name.startsWith(".env.")
    && !SENSITIVE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
