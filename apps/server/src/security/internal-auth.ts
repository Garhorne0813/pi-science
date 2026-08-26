import { timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-pi-science-internal-token";
export const INTERNAL_TOKEN_COOKIE = "pi-science-internal";

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cookieValue(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== INTERNAL_TOKEN_COOKIE) continue;
    try { return decodeURIComponent(value.join("=")); } catch { return value.join("="); }
  }
  return undefined;
}

export function requestInternalToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const headerToken = firstHeaderValue(headers[INTERNAL_TOKEN_HEADER]);
  if (headerToken) return headerToken;
  const authorization = firstHeaderValue(headers.authorization);
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  return cookieValue(firstHeaderValue(headers.cookie));
}

export function tokensMatch(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

/** HttpOnly session cookie used by the production static frontend. */
export function internalAuthCookie(token: string): string {
  return `${INTERNAL_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}
