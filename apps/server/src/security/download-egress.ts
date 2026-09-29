import { lookup } from "node:dns";
import { isIP } from "node:net";
import { execFileSync } from "node:child_process";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { isPrivateOrReservedAddress } from "./outbound-security.js";

const directAgent = new Agent({ connect: { lookup(hostname, options, callback) {
  lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error, address, family);
    const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
    if (addresses.some(isPrivateOrReservedAddress)) return callback(new Error("connection resolves to a private or reserved address"), address, family);
    callback(null, address, family);
  });
} } });

/** A URL is the authorization identity. The proxy, when explicitly configured,
 * resolves the hostname itself; local fake-IP DNS must never be trusted as a
 * public destination or used as an SSRF exception. */
export function parseDownloadUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("download URL must be absolute"); }
  if (url.protocol !== "https:") throw new Error("downloads require HTTPS");
  if (url.username || url.password || !url.hostname) throw new Error("download URL must have a hostname without credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) throw new Error("download URL must use a public hostname, not an IP literal");
  if (hostname === "localhost" || !hostname.includes(".")) throw new Error("download URL must use a public hostname");
  if (url.port && url.port !== "443") throw new Error("downloads require HTTPS port 443");
  return url;
}

let cachedSystemProxy: string | undefined;
let systemProxyCheckedAt = 0;
function systemProxyUrl(): string {
  if (cachedSystemProxy !== undefined && Date.now() - systemProxyCheckedAt < 30_000) return cachedSystemProxy;
  systemProxyCheckedAt = Date.now();
  if (process.platform !== "darwin") return cachedSystemProxy = "";
  try {
    const output = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 1_000, maxBuffer: 8_192 });
    const values = Object.fromEntries([...output.matchAll(/^\s*(HTTPS\w+)\s*:\s*(.+)\s*$/gm)].map((match) => [match[1], match[2]?.trim()]));
    if (values.HTTPSEnable !== "1" || !values.HTTPSProxy || !/^\d+$/.test(values.HTTPSPort ?? "")) return cachedSystemProxy = "";
    return cachedSystemProxy = `http://${values.HTTPSProxy}:${values.HTTPSPort}`;
  } catch { return cachedSystemProxy = ""; }
}

export function configuredLocalEgressProxyUrl(): string {
  return process.env.PI_SCIENCE_EGRESS_PROXY_URL ?? systemProxyUrl();
}

const proxyAgents = new Map<string, ProxyAgent>();
export function downloadDispatcher(proxyUrl = configuredLocalEgressProxyUrl()) {
  if (!proxyUrl) return directAgent;
  const url = new URL(proxyUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("egress proxy must use HTTP(S)");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("egress proxy URL must not contain credentials or a path");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") throw new Error("egress proxy must be local and explicitly configured");
  const key = url.toString();
  let agent = proxyAgents.get(key);
  if (!agent) { agent = new ProxyAgent({ uri: key }); proxyAgents.set(key, agent); }
  return agent;
}

export async function fetchDownloadHop(url: URL, signal: AbortSignal, proxyUrl?: string) {
  return undiciFetch(url, { method: "GET", redirect: "manual", signal, dispatcher: downloadDispatcher(proxyUrl) });
}
