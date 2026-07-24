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

export async function validateOutboundHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("base_url must be a valid absolute URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  if (!url.hostname) throw new Error("URL hostname is required");
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateOrReservedAddress)) throw new Error("outbound URL resolves to a private or reserved address");
  return url;
}
