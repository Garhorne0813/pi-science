import { describe, expect, it } from "vitest";
import { defaultPythonExecutable } from "./workspace-environment.js";

describe("workspace environment platform defaults", () => {
  it("uses the Windows Python launcher name when no override is configured", () => {
    expect(defaultPythonExecutable({}, "win32")).toBe("python");
    expect(defaultPythonExecutable({}, "linux")).toBe("python3");
    expect(defaultPythonExecutable({ PYTHON: "custom-python" }, "win32")).toBe("custom-python");
  });
});
