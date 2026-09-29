import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../../../../..");

/** The runtime and extension packages pinned by the installer. Every one of
 *  them must be part of the single npm invocation in each script, carrying its
 *  pinned version variable (the shell and PowerShell spellings differ). */
const PINNED_PACKAGES = [
  { name: "@earendil-works/pi-coding-agent", shell: "PI_RUNTIME_VERSION", powershell: "PiRuntimeVersion" },
  { name: "@earendil-works/pi-agent-core", shell: "PI_RUNTIME_VERSION", powershell: "PiRuntimeVersion" },
  { name: "pi-mcp-adapter", shell: "PI_MCP_ADAPTER_VERSION", powershell: "PiMcpAdapterVersion" },
  { name: "pi-subagents", shell: "PI_SUBAGENTS_VERSION", powershell: "PiSubagentsVersion" },
  { name: "pi-web-access", shell: "PI_WEB_ACCESS_VERSION", powershell: "PiWebAccessVersion" },
  { name: "context-mode", shell: "CONTEXT_MODE_VERSION", powershell: "ContextModeVersion" },
  { name: "@juicesharp/rpiv-ask-user-question", shell: "RPIV_ASK_USER_QUESTION_VERSION", powershell: "AskUserQuestionVersion" },
  { name: "@juicesharp/rpiv-todo", shell: "RPIV_TODO_VERSION", powershell: "TodoVersion" },
] as const;

describe("Pi runtime installation contract", () => {
  it("installs the pinned runtime packages in one npm invocation from the shell script", async () => {
    const fetchScript = await readFile(resolve(projectRoot, "scripts/fetch-pi.sh"), "utf8");
    const installScript = await readFile(resolve(projectRoot, "scripts/install.sh"), "utf8");

    expect(fetchScript).toContain('PI_RUNTIME_VERSION="${PI_RUNTIME_VERSION:-0.84.4}"');
    // Exactly one npm invocation: npm reifies the whole runtime/pi prefix, so a
    // second `npm install --no-save` into it would evict the first packages.
    expect(fetchScript.match(/^\s*npm install /gm) ?? []).toHaveLength(1);
    for (const pkg of PINNED_PACKAGES) expect(fetchScript).toContain(`"${pkg.name}@$${pkg.shell}"`);
    expect(fetchScript).toContain('--prefix "$RUNTIME_DIR"');
    expect(fetchScript).toContain("--no-save");
    expect(fetchScript).toContain("--no-package-lock");
    expect(fetchScript).toContain("--omit=dev");
    expect(fetchScript).toContain('--cache "$NPM_CACHE_DIR"');
    // The MCP adapter patches must land on the freshly installed adapter, and
    // the pinned-version check runs after both install and patch steps.
    expect(fetchScript).toContain('node "$SCRIPT_DIR/patch-mcp-adapter.mjs"');
    expect(fetchScript).toContain('assert_installed_version "pi-mcp-adapter" "$PI_MCP_ADAPTER_VERSION"');
    expect(fetchScript).toContain('actual="$(node -p "require(process.argv[1]).version"');
    // The marker records the bundled CLI entrypoint the control plane runs.
    expect(fetchScript).toContain('RUNTIME_CLI="$RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"');
    expect(fetchScript).toContain('[ -f "$RUNTIME_CLI" ] || {');
    expect(fetchScript).toContain('node "$RUNTIME_CLI" --help >/dev/null');
    expect(fetchScript).toContain('"$RUNTIME_CLI" > "$CLI_MARKER"');
    expect(fetchScript).not.toContain("@earendil-works/pi-ai@");
    expect(installScript).toContain('PI_CLI="$(cat "$PI_CLI_MARKER")"');
    // The removed release-download flow must not creep back in.
    expect(fetchScript).not.toContain("releases/download");
    expect(fetchScript).not.toContain("SHA256SUMS");
    expect(fetchScript).not.toContain("curl --fail");
    expect(fetchScript).not.toContain("shasum -a 256");
  });

  it("installs the pinned runtime packages in one npm invocation from the Windows script", async () => {
    const windowsFetchScript = await readFile(resolve(projectRoot, "scripts/fetch-pi.ps1"), "utf8");

    expect(windowsFetchScript).toContain('$PiRuntimeVersion = Get-Setting "PI_RUNTIME_VERSION" "0.84.4"');
    // The package list is built once and handed to a single npm call.
    expect(windowsFetchScript).toContain("$arguments = @(");
    expect(windowsFetchScript.match(/@arguments/g) ?? []).toHaveLength(1);
    expect(windowsFetchScript).toContain('"install",');
    for (const pkg of PINNED_PACKAGES) expect(windowsFetchScript).toContain(`"${pkg.name}@$${pkg.powershell}"`);
    expect(windowsFetchScript).toContain('"--prefix", $RuntimeDir');
    expect(windowsFetchScript).toContain('"--no-save"');
    expect(windowsFetchScript).toContain('"--no-package-lock"');
    expect(windowsFetchScript).toContain('"--omit=dev"');
    expect(windowsFetchScript).toContain('"--cache", (Join-Path $RuntimeDir ".npm-cache")');
    expect(windowsFetchScript).toContain("& $npmPath @arguments");
    expect(windowsFetchScript).toContain('& $nodePath (Join-Path $ScriptDir "patch-mcp-adapter.mjs")');
    expect(windowsFetchScript).toContain('Assert-InstalledVersion -PackageName "pi-mcp-adapter" -ExpectedVersion $PiMcpAdapterVersion');
    // The marker records the bundled CLI entrypoint the control plane runs.
    expect(windowsFetchScript).toContain('$RuntimeCli = Join-Path $RuntimeDir "node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js"');
    expect(windowsFetchScript).toContain("if (-not (Test-Path -LiteralPath $RuntimeCli -PathType Leaf)) {");
    expect(windowsFetchScript).toContain("$null = @(& $nodePath $RuntimeCli --help 2>&1 | Out-String)");
    expect(windowsFetchScript).toContain("Write-TextFile -Path $CliMarker -Content ($RuntimeCli + [Environment]::NewLine)");
    expect(windowsFetchScript).not.toContain("@earendil-works/pi-ai@");
    // The removed release-download flow must not creep back in.
    expect(windowsFetchScript).not.toContain("releases/download");
    expect(windowsFetchScript).not.toContain("SHA256SUMS");
    expect(windowsFetchScript).not.toContain("Expand-Archive");
    expect(windowsFetchScript).not.toContain("Invoke-WebRequest");
  });

  it("pins the same runtime version default in both install scripts", async () => {
    const fetchScript = await readFile(resolve(projectRoot, "scripts/fetch-pi.sh"), "utf8");
    const windowsFetchScript = await readFile(resolve(projectRoot, "scripts/fetch-pi.ps1"), "utf8");

    const shellDefault = /PI_RUNTIME_VERSION="\$\{PI_RUNTIME_VERSION:-([^}]+)\}"/.exec(fetchScript)?.[1];
    const powershellDefault = /Get-Setting "PI_RUNTIME_VERSION" "([^"]+)"/.exec(windowsFetchScript)?.[1];

    expect(shellDefault).toMatch(/^\d+\.\d+\.\d+$/);
    // A Windows install and a macOS/Linux install must land on the same runtime.
    expect(powershellDefault).toBe(shellDefault);
  });

  it("patches the freshly installed MCP adapter with the Pi-Science hooks", async () => {
    const mcpPatchScript = await readFile(resolve(projectRoot, "scripts/patch-mcp-adapter.mjs"), "utf8");

    expect(mcpPatchScript).toContain("PI_SCIENCE_SESSION_CONFIG_FACTORY_V1");
    expect(mcpPatchScript).toContain("PI_SCIENCE_PERMISSION_UI_V1");
    expect(mcpPatchScript).toContain("PI_SCIENCE_MCP_ACTION_ENUM_V1");
    expect(mcpPatchScript).toContain('Type.Literal("ui-messages")');
    expect(mcpPatchScript).toContain('error: "invalid_action"');
  });
});
