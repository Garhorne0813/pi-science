import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../..");
const installedCli = "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

describe("Pi runtime installation contract", () => {
  it("keeps the runtime in ESM mode and records the installed CLI directly", async () => {
    const fetchScript = await readFile(resolve(projectRoot, "scripts/fetch-pi.sh"), "utf8");
    const installScript = await readFile(resolve(projectRoot, "scripts/install.sh"), "utf8");

    expect(fetchScript).toContain("npm pkg set type=module --silent");
    expect(fetchScript).toContain(`PI_INSTALLED="$RUNTIME_DIR/${installedCli}"`);
    expect(fetchScript).not.toContain("ln -sf");
    expect(installScript).toContain(`PI_CLI="$RUNTIME_DIR/${installedCli}"`);
  });
});
