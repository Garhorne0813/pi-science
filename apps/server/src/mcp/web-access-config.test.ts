import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareWebAccessConfig } from "./web-access-config.js";

it("fails closed on invalid operator configuration without copying it into diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-web-config-"));
  try {
    const directory = join(root, "mcp", "web-access");
    await mkdir(directory, { recursive: true });
    for (const raw of ['{"private-key":"test-secret",', "null", "[]"]) {
      await writeFile(join(directory, "config.json"), raw);
      const error = await prepareWebAccessConfig(root).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`Invalid Web Access configuration at ${join(directory, "config.json")}`);
      expect((error as Error).cause).toBeUndefined();
      await expect(readFile(join(directory, "runtime", "web-search.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
