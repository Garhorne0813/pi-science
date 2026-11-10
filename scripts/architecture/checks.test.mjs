import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-science-architecture-"));
  const put = async (path, contents) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  try {
    for (const path of ["apps/server/src", "packages/contracts/src", "scripts/architecture"])
      await mkdir(join(root, path), { recursive: true });
    await put("scripts/architecture/boundary-baseline.json", "[]");
    await put("scripts/architecture/format-baseline.json", "{}");
    await run(root, put);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function check(script, root, ...args) {
  return spawnSync(
    process.execPath,
    [resolve(`scripts/architecture/${script}.mjs`), "--root", root, ...args],
    { encoding: "utf8" },
  );
}
test("boundary gate catches aliased singletons, type/dynamic imports, legacy placement and runtime cycles", () =>
  fixture(async (root, put) => {
    await put(
      "apps/server/src/memory/consumer.ts",
      'import {sessionRepository as hidden} from "../runtime/node/session-repository.js";',
    );
    await put(
      "apps/server/src/modules/consumer.ts",
      'import type { Response } from "../http/types.js"; import("../http/routes.js"); const hidden = new SessionRepository();',
    );
    await put("apps/server/src/runtime/a.ts", 'import "./b.js";');
    await put("apps/server/src/runtime/b.ts", 'export * from "./a.js";');
    await put("apps/server/src/runtime/new-repository.ts", "export const placeholder = true;");
    await put("packages/contracts/src/example.ts", 'import type { Contract } from "./index.js";');
    const result = check("check-boundaries", root);
    assert.equal(result.status, 1);
    for (const rule of [
      "singleton:",
      "owned-dependency:",
      "layer:",
      "cycle:",
      "legacy-repository-location:",
      "contracts-barrel:",
    ])
      assert.match(result.stderr, new RegExp(rule));
  }));
test("type-only cycles and text that resembles imports do not create runtime cycles", () =>
  fixture(async (root, put) => {
    await put(
      "apps/server/src/runtime/a.ts",
      'import type { B } from "./b.js"; // import "../http/route.js"\nexport type A = B;',
    );
    await put("apps/server/src/runtime/b.ts", 'export type { A as B } from "./a.js";');
    const result = check("check-boundaries", root);
    assert.equal(result.status, 0, result.stderr);
  }));
test("format ratchet permits untouched legacy text and rejects edits or new unformatted files", () =>
  fixture(async (root, put) => {
    const file = "apps/server/src/legacy.ts";
    await put(file, "export const value=1;");
    assert.equal(check("check-format", root, "--baseline").status, 0);
    assert.equal(check("check-format", root).status, 0);
    await put(file, "export const value=2;");
    assert.equal(check("check-format", root).status, 1);
    assert.equal(check("check-format", root, "--write").status, 0);
    await put("apps/server/src/new.ts", "export const other=1;");
    assert.equal(check("check-format", root).status, 1);
    assert.equal(check("check-format", root, "--write").status, 0);
    assert.equal(check("check-format", root).status, 0);
  }));

test("format checks and legacy hashes tolerate CRLF while rejecting content edits", () =>
  fixture(async (root, put) => {
    const legacy = "apps/server/src/legacy.ts";
    await put(legacy, "export const value=1;\n");
    assert.equal(check("check-format", root, "--baseline").status, 0);
    await put(legacy, "export const value=1;\r\n");
    await put("apps/server/src/formatted.ts", "export const value = 1;\r\n");
    assert.equal(check("check-format", root).status, 0);
    await put(legacy, "export const value=2;\r\n");
    assert.equal(check("check-format", root).status, 1);
  }));
