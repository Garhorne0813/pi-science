import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, rootCertificates } from "node:tls";
import { afterEach, expect, it } from "vitest";
import { writeSandboxCaBundle } from "./certificates.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "sandbox-ca-"));
  roots.push(root);
  return root;
}

it("supplements an incomplete OS file with bundled and platform trust roots", async () => {
  const root = await scratch(),
    source = join(root, "old-system.pem");
  const original = rootCertificates[0]! + "\n";
  await writeFile(source, original);
  const path = await writeSandboxCaBundle(root, [source]);
  const bundle = await readFile(path, "utf8");
  for (const certificate of [...rootCertificates, ...getCACertificates("system")])
    expect(bundle).toContain(certificate);
  expect(await readFile(source, "utf8")).toBe(original);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("provides bundled trust even when the OS CA files are absent", async () => {
  const root = await scratch();
  const path = await writeSandboxCaBundle(root, [join(root, "missing.pem")]);
  expect(await readFile(path, "utf8")).toContain(rootCertificates[0]);
});

it("fails on an unreadable OS bundle instead of silently replacing its trust policy", async () => {
  const root = await scratch();
  await expect(writeSandboxCaBundle(root, [root])).rejects.toThrow();
});
