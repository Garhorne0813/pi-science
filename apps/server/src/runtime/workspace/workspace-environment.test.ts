import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPythonExecutable, workspaceEnvironmentVariables } from "./workspace-environment.js";

describe("workspace environment platform defaults", () => {
  it("uses the Windows Python launcher name when no override is configured", () => {
    expect(defaultPythonExecutable({}, "win32")).toBe("python");
    expect(defaultPythonExecutable({}, "linux")).toBe("python3");
    expect(defaultPythonExecutable({ PYTHON: "custom-python" }, "win32")).toBe("custom-python");
  });

  it("preserves a Windows Path-only value under one canonical PATH key", () => {
    const workspace = "C:\\work\\project";
    const status = {
      ready: true, workspace, virtual_env: join(workspace, ".venv"), python: "python.exe", pip: "pip.exe",
      npm: { local_prefix: workspace, global_prefix: join(workspace, ".pi-science", "npm-global"), cache: join(workspace, ".pi-science", "cache", "npm") },
    };

    const environment = workspaceEnvironmentVariables(status, { Path: "C:\\Windows\\System32", TEMP: "C:\\Temp" }, "win32");

    expect(environment.PATH?.split(";").at(-1)).toBe("C:\\Windows\\System32");
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(environment.TEMP).toBe("C:\\Temp");
  });
});
