import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identifyPolicy, workspacePolicy } from "./policy.js";
import { skillResourcePolicy } from "./skill-resources.js";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { processSettings } from "./settings.js";

let root: string, cwd: string, skill: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "skill-resources-")));
  cwd = join(root, "workspace"); skill = join(cwd, ".pi/skills/review");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review evidence\n---\nRun helper.py");
  await writeFile(join(skill, "helper.py"), "print('review')");
  vi.stubEnv("PI_SCIENCE_HOME", join(root, "service"));
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("grants only the selected skill directory and preserves parent and descendant denials", async () => {
  await writeFile(join(skill, "credentials.json"), "SECRET");
  await symlink(join(cwd, ".pi/settings.json"), join(skill, "linked.txt"));
  await link(join(skill, "helper.py"), join(skill, "hardlinked.py"));
  const policy = await skillResourcePolicy(await workspacePolicy(cwd), [skill]);
  expect(policy.readPaths).toEqual([cwd, skill]);
  expect(policy.writePaths).toEqual([cwd]);
  expect(policy.writeDenyPaths).toContain(skill);
  expect(policy.denyPaths).toEqual(expect.arrayContaining([join(cwd, ".pi"), join(skill, "credentials.json"), join(skill, "linked.txt"), join(skill, "helper.py"), join(skill, "hardlinked.py")]));
});
it.skipIf(!["linux", "darwin"].includes(process.platform))("emits a nested read exception with an independent write denial", async () => {
  const policy = await skillResourcePolicy(await workspacePolicy(cwd), [skill]);
  const { config: settings } = await processSettings(policy, []);
  expect(settings.filesystem.allowRead).toContainEqual({ path: skill, literal: true });
  expect(settings.filesystem.denyRead).toContainEqual({ path: join(cwd, ".pi"), literal: true });
  expect(settings.filesystem.denyWrite).toContainEqual({ path: skill, literal: true });
});
it("supports explicitly configured external skills without exposing their siblings", async () => {
  const external = join(root, "custom-skills/review"); await mkdir(external, { recursive: true });
  await writeFile(join(external, "SKILL.md"), "external skill");
  const policy = await skillResourcePolicy(await workspacePolicy(cwd), [external]);
  expect(policy.readPaths).toEqual([cwd, external]);
  expect(policy.writeDenyPaths).toContain(external);
});
it("refuses aliased resources, broad roots and service-owned skill paths", async () => {
  const base = await workspacePolicy(cwd);
  const alias = join(root, "alias"); await symlink(skill, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(skillResourcePolicy(base, [alias])).rejects.toThrow(/aliases|real directories/);
  await expect(skillResourcePolicy(base, [cwd])).rejects.toThrow("cover the workspace");
  const serviceSkill = join(root, "service/skills/review"); await mkdir(serviceSkill, { recursive: true });
  await writeFile(join(serviceSkill, "SKILL.md"), "private");
  await expect(skillResourcePolicy(base, [serviceSkill])).rejects.toThrow("protected service data");
});
it("never adds implicit skill reads to confined or candidate grants", async () => {
  const base = await workspacePolicy(cwd);
  for (const scope of ["candidate", "confined"] as const) {
    const policy = identifyPolicy({ ...base, scope });
    expect(await skillResourcePolicy(policy, [skill])).toBe(policy);
  }
});
it("drops the additional grant when the current skill list is empty", async () => {
  const base = await workspacePolicy(cwd);
  expect(await skillResourcePolicy(base, [])).toBe(base);
});

it("refreshes skill secrets and link counts while respecting removal from the current skill list", async () => {
  const policy = () => workspacePolicy(cwd);
  const before = await skillResourcePolicy(await policy(), [skill]);
  const helper = join(skill, "helper.py"), secret = join(skill, "credentials.json"), alias = join(skill, "linked.txt");
  expect(before.denyPaths).not.toContain(helper);
  await link(helper, join(root, "external-helper-link.py"));
  await writeFile(secret, "new secret");
  await symlink(join(root, "outside.txt"), alias);
  const refreshed = await skillResourcePolicy(await policy(), [skill]);
  expect(refreshed.denyPaths).toEqual(expect.arrayContaining([helper, secret, alias]));
  expect(refreshed.writeDenyPaths).toContain(skill);
  expect(refreshed.id).not.toBe(before.id);
  const revoked = await skillResourcePolicy(await policy(), []);
  expect(revoked.readPaths).not.toContain(skill);
  expect(revoked.denyPaths).toContain(join(cwd, ".pi"));
});

it.skipIf(process.platform === "win32").each(["project", "project[1]*?"])("generates Seatbelt child exceptions without weakening sibling or credential denials: %s", (name) => {
  const cwd = `/private/tmp/${name}`, pi = `${cwd}/.pi`, skill = `${pi}/skills/review`, secret = `${skill}/credentials.json`;
  const command = wrapCommandWithSandboxMacOS({ command: "true", needsNetworkRestriction: false,
    readConfig: { denyOnly: [], literalDenyOnly: ["/", pi, secret], literalAllowWithinDeny: [cwd, skill] },
    writeConfig: { allowOnly: [], literalAllowOnly: [cwd], denyWithinAllow: [], literalDenyWithinAllow: [pi, skill] } });
  // The restored parent deny excludes only the explicit child. Literal paths
  // must retain that meaning even when their names contain glob characters.
  const parentDeny = `(require-all (subpath ${JSON.stringify(pi)}) (require-not (subpath ${JSON.stringify(skill)})))`;
  expect(command).toContain(parentDeny);
  const lateDeny = command.slice(command.indexOf(parentDeny));
  expect(lateDeny).toContain(`(subpath ${JSON.stringify(secret)})`);
  expect(lateDeny).not.toContain(`(require-not (subpath ${JSON.stringify(secret)}))`);
  expect(command).toContain(`(deny file-write*`);
});
