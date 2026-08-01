// Identity helpers for research loops that keep working on insecure origins
// (e.g. plain-http LAN hosts), where crypto.randomUUID and crypto.subtle are unavailable.

export function randomIdSuffix(length = 12): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  let out = "";
  while (out.length < length) {
    out += typeof cryptoObj?.randomUUID === "function"
      ? cryptoObj.randomUUID().replace(/-/g, "")
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  return out.slice(0, length);
}

export async function contentDigest(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    const digestBytes = await subtle.digest("SHA-256", bytes);
    return `sha256:${[...new Uint8Array(digestBytes)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  // Deterministic FNV-1a 64-bit fallback; the server only stores and equality-compares this string.
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `fnv1a:${hash.toString(16).padStart(16, "0")}`;
}
