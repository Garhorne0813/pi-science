import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { macosRootKeychain, writeCertificateBundle } from "./process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function scratch() { const root = await mkdtemp(join(tmpdir(), "ps-ca-")); roots.push(root); return root; }
const exporter = (output: string) => { const calls: Array<{ file: string; args: readonly string[] }> = []; const run = async (file: string, args: readonly string[]) => { calls.push({ file, args }); return { stdout: output }; }; return { calls, run }; };
const samplePem = "-----BEGIN CERTIFICATE-----\nMIIBc2FtcGxl\n-----END CERTIFICATE-----\n";

describe.runIf(process.platform === "darwin")("macOS sandbox certificate bundle", () => {
  it("writes the system root keychain export so the workload trusts what the host trusts", async () => {
    const root = await scratch(), { calls, run } = exporter(samplePem);
    expect(await writeCertificateBundle(root, run)).toBe(join(root, "system-ca.pem"));
    expect(await readFile(join(root, "system-ca.pem"), "utf8")).toBe(samplePem);
    expect(calls).toEqual([{ file: "/usr/bin/security", args: ["find-certificate", "-a", "-p", macosRootKeychain] }]);
  });
  it("falls back to the system PEM when the keychain export produces no certificate", async () => {
    const root = await scratch(), { run } = exporter("");
    expect(await writeCertificateBundle(root, run)).toBe(join(root, "system-ca.pem"));
    expect(await readFile(join(root, "system-ca.pem"), "utf8")).toBe(await readFile("/etc/ssl/cert.pem", "utf8"));
  });
  it("falls back to the system PEM when the keychain export fails", async () => {
    const root = await scratch();
    expect(await writeCertificateBundle(root, async () => { throw new Error("security unavailable"); })).toBe(join(root, "system-ca.pem"));
    expect(await readFile(join(root, "system-ca.pem"), "utf8")).toContain("BEGIN CERTIFICATE");
  });
});
