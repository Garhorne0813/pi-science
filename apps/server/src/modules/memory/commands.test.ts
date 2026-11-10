import { expect, it } from "vitest";
import { parseMemoryCommand, parseMemoryInput } from "./commands.js";
import { ApplicationError } from "../application-error.js";
import type { MemoryService } from "../../memory/service.js";
import type { MemoryContext } from "@pi-science/contracts";

// These checks are compiled by tsc but never dispatch work.
function commandTypeChecks(memory: MemoryService, context: MemoryContext) {
  const settings = memory.command(context, "settings");
  const enabled: Promise<boolean> = settings.then((result) => result.enabled);
  void enabled;
  // @ts-expect-error Unknown commands cannot cross an in-process call site.
  void memory.command(context, "settingz");
  // @ts-expect-error Read requires its identifier.
  void memory.command(context, "read", {});
  // @ts-expect-error Callers cannot select an unrelated output type.
  void memory.command<{ invented: true }>(context, "settings");
  // @ts-expect-error Settings output has no record field.
  void settings.then((result) => result.record);
}
void commandTypeChecks;

it("validates both the IPC envelope and the action-specific input", () => {
  const context = { ownerId: "owner", projectId: "project", actor: "user" };
  expect(parseMemoryCommand({ context, action: "read", input: { id: "record" } })).toEqual({
    context,
    action: "read",
    input: { id: "record" },
  });
  expect(() => parseMemoryCommand({ context, action: "unknown", input: {} })).toThrow(
    ApplicationError,
  );
  expect(() =>
    parseMemoryCommand({ context: { ...context, actor: "root" }, action: "settings", input: {} }),
  ).toThrow(ApplicationError);
  expect(() => parseMemoryInput("read", { id: 12 })).toThrow(ApplicationError);
});
