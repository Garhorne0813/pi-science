import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function ipv4IsBlocked(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = octets[0]!;
  const b = octets[1]!;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function ipv6IsBlocked(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return ipv4IsBlocked(mapped);
    return true;
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? ipv4IsBlocked(address) : family === 6 ? ipv6IsBlocked(address) : true;
}

export async function validateOutboundHttpUrl(raw: string, options: { allowPrivate?: boolean } = {}): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("base_url must be a valid absolute URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  if (!url.hostname) throw new Error("URL hostname is required");
  const allowPrivate = options.allowPrivate ?? process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0";
  // URL.hostname keeps the brackets for IPv6 literals ("[::1]"); strip them
  // so isIP can classify the address without a DNS round-trip.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [hostname] : (await lookup(url.hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!addresses.length || (!allowPrivate && addresses.some(isPrivateOrReservedAddress))) throw new Error("outbound URL resolves to a private or reserved address");
  return url;
}

/**
 * Connector-grade URL validation. Same checks as validateOutboundHttpUrl; kept
 * as a distinct name so connector code (literature service, MCP fetch) can be
 * audited separately from provider settings. Re-resolves DNS after parsing so
 * hostnames that resolve into private ranges are rejected (DNS rebinding
 * baseline).
 *
 * NOTE: the private-range guard is RELAXED BY DEFAULT — when
 * allowPrivate is omitted (or PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0")
 * loopback/private destinations pass. Callers handling untrusted input MUST
 * pass `allowPrivate: false` explicitly; treat this function as permissive
 * unless the caller opts into strictness.
 */
export async function validateConnectorOutboundUrl(raw: string, options: { allowPrivate?: boolean } = {}): Promise<URL> {
  return validateOutboundHttpUrl(raw, options);
}

export type ConnectorFetchOptions = {
  /** Allow loopback/private destinations (tests, local tooling). Default: PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0". */
  allowPrivate?: boolean;
  /** Maximum redirects followed manually; each hop is re-validated. Default 3. */
  maxRedirects?: number;
  /** Maximum response body bytes. Default 10 MiB. */
  maxResponseBytes?: number;
  /** Content-Type allowlist (exact match or prefix before ";"); empty/missing type passes when the list is set. */
  allowedContentTypes?: readonly string[];
  /** Total request timeout including redirect hops. Default 30s. */
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
};

/** Headers that must never leak to a cross-origin redirect target. */
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);

function stripSensitiveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

/**
 * Restricted fetch for connector outbound calls:
 * - validates the URL (and every redirect hop) against private/reserved ranges
 * - follows redirects manually with a hop cap (default 3)
 * - enforces a response size cap (content-length pre-check + streaming count)
 * - optionally enforces a Content-Type allowlist
 * - applies a total timeout via AbortController
 * DNS is re-checked per hop right before each request, which closes the
 * parse-then-connect gap for hostnames that resolve to private ranges.
 */
export async function safeConnectorFetch(raw: string, options: ConnectorFetchOptions = {}): Promise<Response> {
  const allowPrivate = options.allowPrivate ?? process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0";
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
  const allowedTypes = options.allowedContentTypes ?? null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let current = await validateConnectorOutboundUrl(raw, { allowPrivate });
  const initialOrigin = current.origin;
  let redirects = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`connector fetch timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    for (;;) {
      // Sensitive headers (authorization, cookies, api keys) belong to the
      // original connector origin only; cross-origin hops must not receive them.
      const hopHeaders = current.origin === initialOrigin ? options.headers : stripSensitiveHeaders(options.headers);
      const response = await fetch(current, { method: options.method ?? "GET", headers: hopHeaders, body: options.body, redirect: "manual", signal: controller.signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        response.body?.cancel();
        if (redirects >= maxRedirects) throw new Error(`too many redirects (max ${maxRedirects})`);
        const next = new URL(location, current);
        // Same-origin hops keep the caller's policy; cross-origin hops must
        // resolve to public addresses even when private origins are allowed
        // (a public server steering us into a private range is the classic
        // SSRF redirect vector).
        const sameOrigin = next.origin === current.origin;
        current = await validateConnectorOutboundUrl(next.toString(), sameOrigin ? { allowPrivate } : { allowPrivate: false });
        redirects += 1;
        continue;
      }
      if (allowedTypes?.length) {
        const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        if (contentType && !allowedTypes.some((type) => contentType === type)) {
          response.body?.cancel();
          throw new Error(`unexpected content type: ${contentType}`);
        }
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.body?.cancel();
        throw new Error(`response exceeds size limit (${contentLength} > ${maxBytes} bytes)`);
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      let received = 0;
      const bounded = new ReadableStream<Uint8Array>({
        async pull(stream) {
          const { done, value } = await reader.read();
          if (done) { stream.close(); return; }
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel();
            stream.error(new Error(`response exceeds size limit (max ${maxBytes} bytes)`));
            return;
          }
          stream.enqueue(value);
        },
        cancel() { return reader.cancel(); },
      });
      return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  } finally {
    clearTimeout(timer);
  }
}
