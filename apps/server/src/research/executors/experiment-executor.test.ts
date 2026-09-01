import { describe, expect, it } from "vitest";
import { entrypointCommand } from "./experiment-executor.js";

describe("entrypointCommand", () => {
  it("runs python entrypoints with python3 so script source is not interpreted by bash", () => {
    expect(entrypointCommand("/work/solve.py", "/bin/bash")).toEqual(["python3", "/work/solve.py"]);
    expect(entrypointCommand("/work/entrypoint.py", "/bin/bash", "/opt/venv/bin/python")).toEqual(["/opt/venv/bin/python", "/work/entrypoint.py"]);
  });

  it("keeps the bash invocation for shell scripts and extensionless entrypoints", () => {
    expect(entrypointCommand("/work/run.sh", "/bin/bash")).toEqual(["/bin/bash", "/work/run.sh"]);
    expect(entrypointCommand("/work/run", "/bin/bash")).toEqual(["/bin/bash", "/work/run"]);
  });
});