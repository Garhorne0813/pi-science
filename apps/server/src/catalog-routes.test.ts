import { describe, expect, it } from "vitest";
import { catalogToolCommands } from "./catalog-routes.js";

describe("catalog route platform defaults", () => {
  it("probes the Windows Python command without relying on cached host status", () => {
    expect(catalogToolCommands({}, "win32")[0]).toEqual(["python", "python"]);
    expect(catalogToolCommands({}, "linux")[0]).toEqual(["python", "python3"]);
    expect(catalogToolCommands({ PYTHON: "py-custom" }, "win32")[0]).toEqual(["python", "py-custom"]);
  });
});
