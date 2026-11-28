import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, rootCertificates } from "node:tls";

/** Give confined curl/Python the same public roots available to the Node host.
 * macOS's /etc/ssl/cert.pem can lag behind its Keychain and Node's Mozilla roots. */
export async function writeSandboxCaBundle(
  scratch: string,
  sources = process.platform === "darwin"
    ? ["/etc/ssl/cert.pem"]
    : ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"],
) {
  const certificates = new Set([...rootCertificates, ...getCACertificates("system")]);
  // Retain distribution roots and operator-supplied trust anchors (for example
  // NODE_EXTRA_CA_CERTS in corporate or laboratory installations) too.
  const operatorSources = [
    process.env.SSL_CERT_FILE,
    process.env.CURL_CA_BUNDLE,
    process.env.REQUESTS_CA_BUNDLE,
    process.env.NODE_EXTRA_CA_CERTS,
  ].filter((value): value is string => Boolean(value));
  for (const source of [...operatorSources, ...sources]) {
    try {
      certificates.add(await readFile(source, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const path = join(scratch, "system-ca.pem");
  await writeFile(path, [...certificates].join("\n") + "\n", { mode: 0o600 });
  return path;
}
