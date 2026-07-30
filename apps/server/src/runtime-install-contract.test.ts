import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../..");
describe("Pi runtime installation contract", () => {
  it("verifies and records the platform-specific Pi Web release executable", async () => {
    const fetchScript = await readFile(resolve(projectRoot, "scripts/fetch-pi.sh"), "utf8");
    const installScript = await readFile(resolve(projectRoot, "scripts/install.sh"), "utf8");

    expect(fetchScript).toContain('archive="pi-web-${platform}-${arch}.tar.gz"');
    expect(fetchScript).toContain('curl --fail --location --silent --show-error');
    expect(fetchScript).toContain('actual="$(shasum -a 256');
    expect(fetchScript).toContain('printf \'%s\\n\' "$pi_cli" > "$CLI_MARKER"');
    expect(installScript).toContain('PI_CLI="$(cat "$PI_CLI_MARKER")"');
  });
});
