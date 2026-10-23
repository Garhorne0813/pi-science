import { z } from "zod";
import type { OAuthCredential } from "@earendil-works/pi-ai";

// Provider-specific refresh fields (clientId, enterpriseUrl, etc.) must survive.
const schema = z.object({ type: z.literal("oauth"), access: z.string().min(1), refresh: z.string(), expires: z.number().finite().positive() }).passthrough();
export function oauthCredential(value: unknown): OAuthCredential {
  return schema.parse(value) as OAuthCredential;
}
export function readOAuthCredential(secret: string | null | undefined): OAuthCredential | undefined {
  if (!secret || secret.length > 262144) return undefined;
  try { return oauthCredential(JSON.parse(secret)); } catch { return undefined; }
}
