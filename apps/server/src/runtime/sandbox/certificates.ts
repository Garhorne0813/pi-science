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
  // Retain distribution/operator roots supplied by the existing file bundle too.
  for (const source of sources) {
    try {
      certificates.add(await readFile(source, "utf8"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const path = join(scratch, "system-ca.pem");
  await writeFile(path, [...certificates].join("\n") + "\n", { mode: 0o600 });
  return path;
}
