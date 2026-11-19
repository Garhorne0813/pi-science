import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { InteractionBridge } from "./interaction-bridge.js";
import {
  approveLocalExecution,
  executionGrantSettings,
  revokeExecutionGrant,
} from "./local-execution-approval.js";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["project", "global"] as const)(
  "reuses %s execution approval at its selected scope",
  async (scope) => {
    root = await mkdtemp(join(tmpdir(), "execution-approval-"));
    vi.stubEnv("PI_SCIENCE_HOME", join(root, "settings"));
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    const events: Array<{ type: string; id?: string }> = [];
    const bridge = new InteractionBridge((event) => events.push(event));
    const pending = approveLocalExecution(
      bridge,
      firstWorkspace,
      "session-a",
      "bash",
      "python -V",
      "call-1",
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "interaction.requested")).toBe(true),
    );
    bridge.notify("extension_ui_response", {
      id: events.find((event) => event.type === "interaction.requested")!.id,
      value: scope,
    });
    expect(await pending).toBe(true);
    expect(
      await approveLocalExecution(
        bridge,
        firstWorkspace,
        "session-b",
        "bash",
        "python -V",
        "call-2",
      ),
    ).toBe(true);
    if (scope === "global")
      expect(
        await approveLocalExecution(
          bridge,
          secondWorkspace,
          "session-c",
          "bash",
          "python -V",
          "call-3",
        ),
      ).toBe(true);
    expect((await executionGrantSettings(firstWorkspace))[scope].bash).toBe(true);
    await revokeExecutionGrant(scope, "bash", firstWorkspace);
    expect((await executionGrantSettings(firstWorkspace))[scope].bash).toBeUndefined();
    const again = approveLocalExecution(
      bridge,
      scope === "global" ? secondWorkspace : firstWorkspace,
      "new-session",
      "bash",
      "python -V",
      "call-4",
    );
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "interaction.requested")).toHaveLength(2),
    );
    bridge.notify("extension_ui_response", {
      id: events.filter((event) => event.type === "interaction.requested")[1]!.id,
      value: "deny",
    });
    expect(await again).toBe(false);
    bridge.close();
  },
);
