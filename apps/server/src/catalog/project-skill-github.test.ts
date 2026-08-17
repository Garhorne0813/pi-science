import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../security/outbound-security.js", () => ({ safeConnectorFetch: vi.fn() }));

import { safeConnectorFetch } from "../security/outbound-security.js";
import { importGithubSkills, previewGithubSkills } from "./project-skill-service.js";

const cleanups: string[] = [];
let home = "";
let cwd = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-github-skill-"));
  cwd = join(home, "ws");
  await mkdir(cwd, { recursive: true });
  cleanups.push(home);
  process.env.PI_SCIENCE_HOME = home;
});

afterEach(async () => {
  delete process.env.PI_SCIENCE_HOME;
  vi.mocked(safeConnectorFetch).mockReset();
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}, 30_000);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

const tree = {
  tree: [
    { path: "skills/alpha/SKILL.md", type: "blob", size: 40 },
    { path: "skills/alpha/scripts/run.py", type: "blob", size: 15 },
  ],
};

describe("GitHub skill import", () => {
  it("previews candidates and reads the SKILL.md description", async () => {
    vi.mocked(safeConnectorFetch)
      .mockResolvedValueOnce(jsonResponse(tree))
      .mockResolvedValueOnce(textResponse("---\nname: alpha-skill\ndescription: Alpha skill\n---\n"));

    const candidates = await previewGithubSkills("owner/repo");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("alpha");
    expect(candidates[0]!.description).toBe("Alpha skill");
    expect(candidates[0]!.files.some((file) => file.path === "scripts/run.py")).toBe(true);
  });

  it("imports the selected GitHub skill into the project", async () => {
    vi.mocked(safeConnectorFetch)
      .mockResolvedValueOnce(jsonResponse(tree))
      .mockResolvedValueOnce(textResponse("---\nname: alpha-skill\ndescription: Alpha skill\n---\n\n# Alpha\n"))
      .mockResolvedValueOnce(textResponse("print('alpha')"));

    const result = await importGithubSkills(cwd, "owner/repo", ["skills/alpha"]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]!.name).toBe("alpha-skill");
    expect(result.skipped).toHaveLength(0);
    const skillMd = await readFile(join(cwd, ".pi", "skills", "alpha-skill", "SKILL.md"), "utf8");
    expect(skillMd).toContain("name: alpha-skill");
    const helper = await readFile(join(cwd, ".pi", "skills", "alpha-skill", "scripts", "run.py"), "utf8");
    expect(helper).toBe("print('alpha')");
  });
});