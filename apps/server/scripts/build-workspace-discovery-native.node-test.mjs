// Run with node --test. The .node-test.mjs suffix keeps this suite out of Vitest discovery.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildWorkspaceDiscoveryNative } from "./build-workspace-discovery-native.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "discovery-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeExecutable = join(root, "bin/node");
  const headersDirectory = join(root, "headers");
  const output = join(root, "dist/native/workspace-discovery-darwin.node");
  await mkdir(dirname(nodeExecutable), { recursive: true });
  await writeFile(nodeExecutable, "");
  await mkdir(headersDirectory);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "stale backend");
  const warnings = [];
  return { root, nodeExecutable, headersDirectory, output, warnings,
    options: { platform: "darwin", root, nodeExecutable, headersDirectory, warn: message => warnings.push(message) } };
}

for (const required of [false, true]) {
  test(`missing headers clean up the old module (required=${required})`, async t => {
    const f = await fixture(t);
    const build = buildWorkspaceDiscoveryNative({ ...f.options, required, compile: () => assert.fail("must not invoke compiler") });
    if (required) await assert.rejects(build, /local Node.js headers/);
    else {
      await build;
      assert.match(f.warnings[0], /node_api.h.*tool_unavailable/);
    }
    assert.deepEqual(await readdir(dirname(f.output)), []);
  });
}

for (const failure of ["missing compiler", "nonzero exit", "timeout"]) {
  test(`${failure} warns and removes stale and partial modules`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.headersDirectory, "node_api.h"), "");
    // A compiler can leave partial output even on failure or timeout.
    await writeFile(`${f.output}.${process.pid}`, "partial backend");
    const result = failure === "nonzero exit" ? { status: 1 } : { status: null, error: new Error(failure) };
    await buildWorkspaceDiscoveryNative({ ...f.options, compile: () => result });
    assert.match(f.warnings[0], /Xcode Command Line Tools.*tool_unavailable/);
    assert.deepEqual(await readdir(dirname(f.output)), []);
  });
}

test("required builds propagate compiler failure", async t => {
  const f = await fixture(t);
  await writeFile(join(f.headersDirectory, "node_api.h"), "");
  await assert.rejects(buildWorkspaceDiscoveryNative({ ...f.options, required: true, compile: () => ({ status: 1 }) }), /macOS discovery build failed/);
  assert.deepEqual(await readdir(dirname(f.output)), []);
});

test("successful builds publish the module and use the selected local headers", async t => {
  const f = await fixture(t);
  await writeFile(join(f.headersDirectory, "node_api.h"), "");
  // The compilation fixture is ready before the synchronous compiler callback.
  await writeFile(`${f.output}.${process.pid}`, "new backend");
  await buildWorkspaceDiscoveryNative({ ...f.options, compile: (command, args, options) => {
    assert.equal(command, "xcrun");
    assert.equal(args[args.indexOf("-I") + 1], f.headersDirectory);
    assert.equal(args[args.indexOf("-o") + 1], `${f.output}.${process.pid}`);
    assert.equal(options.timeout, 60000);
    return { status: 0 };
  } });
  assert.equal(await readFile(f.output, "utf8"), "new backend");
  assert.deepEqual(await readdir(dirname(f.output)), ["workspace-discovery-darwin.node"]);
  assert.deepEqual(f.warnings, []);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} does not invoke the macOS compiler or remove artifacts`, async t => {
    const f = await fixture(t);
    await buildWorkspaceDiscoveryNative({ ...f.options, platform, required: true, compile: () => assert.fail("must not invoke compiler") });
    assert.equal(await readFile(f.output, "utf8"), "stale backend");
    assert.deepEqual(f.warnings, []);
  });
}
