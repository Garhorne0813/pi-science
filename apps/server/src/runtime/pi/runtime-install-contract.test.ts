import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../../../..");
describe("Pi runtime installation contract", () => {
  it("verifies and records the platform-specific Pi Orbit release executable", async () => {
    const fetchScript = await readFile(resolve(projectRoot, "scripts/fetch-pi.sh"), "utf8");
    const installScript = await readFile(resolve(projectRoot, "scripts/install.sh"), "utf8");

    expect(fetchScript).toContain('archive="pi-orbit-${platform}-${arch}.tar.gz"');
    expect(fetchScript).toContain('PI_ORBIT_VERSION="${PI_ORBIT_VERSION:-0.3.0}"');
    expect(fetchScript).toContain('curl --fail --location --silent --show-error');
    expect(fetchScript).toContain('actual="$(shasum -a 256');
    expect(fetchScript).toContain('printf \'%s\\n\' "$pi_cli" > "$CLI_MARKER"');
    expect(fetchScript).toContain('pi-mcp-adapter@$PI_MCP_ADAPTER_VERSION');
    expect(fetchScript).toContain('pi-subagents@$PI_SUBAGENTS_VERSION');
    expect(fetchScript).toContain('pi-web-access@$PI_WEB_ACCESS_VERSION');
    expect(fetchScript).toContain('context-mode@$CONTEXT_MODE_VERSION');
    expect(fetchScript).toContain('@juicesharp/rpiv-ask-user-question@$RPIV_ASK_USER_QUESTION_VERSION');
    expect(fetchScript).toContain('@juicesharp/rpiv-todo@$RPIV_TODO_VERSION');
    expect(fetchScript).toContain('--no-save');
    expect(installScript).toContain('PI_CLI="$(cat "$PI_CLI_MARKER")"');
  });
});
