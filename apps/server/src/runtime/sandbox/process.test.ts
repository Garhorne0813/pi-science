import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { identifyPolicy } from "./policy.js";
import { prepareSandbox } from "./process.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.skipIf(!["darwin", "linux"].includes(process.platform))(
  "adds trusted operator certificates to the isolated CA bundle",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-ca-")));
    roots.push(root);
    const additional = join(root, "operator-ca.pem");
    await writeFile(
      additional,
      "-----BEGIN CERTIFICATE-----\nOPERATOR_TEST_CA\n-----END CERTIFICATE-----\n",
    );
    vi.stubEnv("NODE_EXTRA_CA_CERTS", additional);
    const policy = identifyPolicy({
      mode: "required",
      scope: "candidate",
      cwd: root,
      readPaths: [root],
      writePaths: [root],
      denyPaths: [],
      network: { mode: "none" },
    });
    const prepared = await prepareSandbox(policy, ["/usr/bin/true"], [], 1);
    try {
      const manifest = JSON.parse(await readFile(prepared.manifest, "utf8")) as {
        env: Record<string, string>;
      };
      expect(manifest.env.SSL_CERT_FILE).toBeTruthy();
      expect(manifest.env.CURL_CA_BUNDLE).toBe(manifest.env.SSL_CERT_FILE);
      expect(manifest.env.REQUESTS_CA_BUNDLE).toBe(manifest.env.SSL_CERT_FILE);
      expect(manifest.env.NODE_EXTRA_CA_CERTS).toBe(manifest.env.SSL_CERT_FILE);
      expect(await readFile(manifest.env.SSL_CERT_FILE!, "utf8")).toContain("OPERATOR_TEST_CA");
    } finally {
      await prepared.cleanup();
    }
  },
);
