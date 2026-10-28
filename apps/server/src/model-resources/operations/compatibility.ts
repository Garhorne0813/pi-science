import { createHash } from "node:crypto";
import type { ProviderRead } from "./types.js";

export function providerReadToLegacy(provider: ProviderRead): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    models: provider.models,
    has_key: provider.has_key,
    auth: {
      kind: provider.auth_kind,
      api_key_supported: provider.auth_kind === "api_key" || provider.auth_kind === "api_key_or_oauth",
      oauth_supported: provider.auth_kind === "oauth" || provider.auth_kind === "api_key_or_oauth",
      login_supported: false,
    },
    credential_status: provider.credential_status,
    enabled: provider.enabled,
  };
}

export function modelResourceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
