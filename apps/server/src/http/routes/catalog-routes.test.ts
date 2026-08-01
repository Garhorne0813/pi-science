import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogToolCommands, expandUserPath } from "./catalog-routes.js";
import { userHome } from "../../support/platform-utils.js";

describe("catalog route platform defaults", () => {
  it("expands a bare tilde to the user home directory", () => {
    expect(expandUserPath("~")).toBe(resolve(userHome()));
  });

  it("probes the Windows Python command without relying on cached host status", () => {
    expect(catalogToolCommands({}, "win32")[0]).toEqual(["python", "python"]);
    expect(catalogToolCommands({}, "linux")[0]).toEqual(["python", "python3"]);
    expect(catalogToolCommands({ PYTHON: "py-custom" }, "win32")[0]).toEqual(["python", "py-custom"]);
  });
});
