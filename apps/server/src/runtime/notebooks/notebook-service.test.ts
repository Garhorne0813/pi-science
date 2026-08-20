import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotebookService } from "./notebook-service.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("NotebookService", () => {
  it("lists ipynb files while skipping dot directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-notebooks-"));
    cleanup.push(cwd);
    await writeFile(join(cwd, "a.ipynb"), "{}", "utf8");
    await mkdir(join(cwd, "nested"));
    await writeFile(join(cwd, "nested", "b.ipynb"), "{}", "utf8");
    await mkdir(join(cwd, ".hidden"));
    await writeFile(join(cwd, ".hidden", "c.ipynb"), "{}", "utf8");

    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) });
    const files = await service.list(cwd);
    expect(files.map((file) => file.path)).toEqual(["a.ipynb", "nested/b.ipynb"]);
  });

  it("reports jupyter env status and idle server state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-"));
    cleanup.push(cwd);
    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) });

    expect((await service.envStatus(cwd)).ready).toBe(false);
    expect(service.status()).toMatchObject({ running: false, port: null, url: null });
  });
});