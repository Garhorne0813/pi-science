import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requiresVerification } from "./changes.mjs";

test("only documentation and root README files skip expensive checks", () => {
  assert.equal(requiresVerification(["docs/architecture.md", "README.zh-CN.md"]), false);
  for (const path of ["skills/auto-research/SKILL.md", "harness/AGENTS.md", "AGENTS.md", "apps/server/src/app/app.ts", ".github/workflows/quality.yml", "pnpm-lock.yaml"]) {
    assert.equal(requiresVerification(["docs/architecture.md", path]), true, path);
  }
  assert.equal(requiresVerification([]), true);
});

test("missing history fails open to full verification", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ci-changes-"));
  try {
    const output = join(root, "output");
    execFileSync(process.execPath, [fileURLToPath(new URL("./changes.mjs", import.meta.url))], {
      cwd: root,
      env: { ...process.env, BASE_SHA: "missing", HEAD_SHA: "missing", GITHUB_OUTPUT: output },
      stdio: "pipe",
    });
    assert.equal(readFileSync(output, "utf8"), "run=true\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("moving runtime code into docs cannot skip verification", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ci-rename-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init");
    writeFileSync(join(root, "runtime.ts"), "export const value = 1;\n");
    git("add", ".");
    git("-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid", "commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "runtime.ts", "README.md");
    git("-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid", "commit", "-m", "rename");
    const output = join(root, "output");
    execFileSync(process.execPath, [fileURLToPath(new URL("./changes.mjs", import.meta.url))], {
      cwd: root,
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: git("rev-parse", "HEAD"), GITHUB_OUTPUT: output },
      stdio: "pipe",
    });
    assert.equal(readFileSync(output, "utf8"), "run=true\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
