import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const compilerPackage = require.resolve('typescript/package.json', { paths: [join(root, 'packages/contracts')] });
const compiler = join(dirname(compilerPackage), 'bin', 'tsc');

test('pre-push guards the actual commit and preserves existing hooks', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-science-hook-'));
  const repo = join(temp, 'repo');
  const bin = join(temp, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  // Git for Windows cannot read Node's \\.\nul device path as a config file.
  const emptyConfig = join(temp, 'empty-gitconfig');
  writeFileSync(emptyConfig, '');
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    HOOK_TEST_NODE: process.execPath,
    HOOK_TEST_TSC: compiler,
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const node = (script, input = '') => spawnSync(process.execPath, [script], { cwd: repo, env, input, encoding: 'utf8' });
  const zero = '0'.repeat(40);
  const ref = (local, remote) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;

  try {
    git('init', '-q');
    git('config', 'user.name', 'Hook test');
    git('config', 'user.email', 'hook-test@example.invalid');
    // The Windows checkout can contain CRLF. Store the copied text as LF so
    // git diff --check tests trailing whitespace instead of checkout settings.
    writeFileSync(join(repo, '.gitattributes'), '* text=auto\n');
    mkdirSync(join(repo, 'scripts'));
    for (const name of ['pre-push.mjs', 'install-git-hooks.mjs']) {
      const content = readFileSync(join(root, 'scripts', name), 'utf8');
      writeFileSync(join(repo, 'scripts', name), content.replace(/\r?\n/g, '\r\n'));
    }
    mkdirSync(join(repo, '.githooks'));
    const hook = join(repo, '.githooks', 'pre-push');
    cpSync(join(root, '.githooks', 'pre-push'), hook);
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, types: [] } }));
    writeFileSync(join(repo, 'source.ts'), 'export const value: number = 1;\n');
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'pnpm.cmd'), '@echo off\r\nif "%1"=="typecheck" "%HOOK_TEST_NODE%" "%HOOK_TEST_TSC%" --noEmit -p tsconfig.json\r\n');
    } else {
      const pnpm = join(bin, 'pnpm');
      writeFileSync(pnpm, '#!/bin/sh\nif [ "$1" = typecheck ]; then exec "$HOOK_TEST_NODE" "$HOOK_TEST_TSC" --noEmit -p tsconfig.json; fi\nexit 0\n');
      chmodSync(pnpm, 0o755);
    }
    git('add', '.');
    git('commit', '-qm', 'initial');
    const initial = git('rev-parse', 'HEAD');

    const defaultHooks = join(repo, '.git', 'hooks');
    writeFileSync(join(defaultHooks, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    assert.notEqual(node('scripts/install-git-hooks.mjs').status, 0, 'must preserve an existing hook');
    rmSync(join(defaultHooks, 'pre-commit'));
    git('config', 'core.hooksPath', 'custom-hooks');
    assert.notEqual(node('scripts/install-git-hooks.mjs').status, 0, 'must preserve an existing hooksPath');
    git('config', '--unset', 'core.hooksPath');
    assert.equal(node('scripts/install-git-hooks.mjs').status, 0, 'must install when no hook exists');
    git('config', '--unset', 'core.hooksPath');

    assert.equal(node('scripts/pre-push.mjs', ref(zero, initial)).status, 0, 'deleting a ref needs no source checks');
    const valid = node('scripts/pre-push.mjs', ref(initial, zero));
    assert.equal(valid.status, 0, `valid source must pass: ${valid.stdout}\n${valid.stderr}`);

    writeFileSync(join(repo, 'source.ts'), 'export const value: number = 1;  \n');
    git('add', 'source.ts');
    git('commit', '-qm', 'add whitespace');
    assert.notEqual(node('scripts/pre-push.mjs', ref(git('rev-parse', 'HEAD'), initial)).status, 0, 'whitespace errors must fail');
    git('reset', '--hard', initial);

    writeFileSync(join(repo, 'source.ts'), "export const value: number = 'wrong';\n");
    git('add', 'source.ts');
    git('commit', '-qm', 'add type error');
    const bad = node('scripts/pre-push.mjs', ref(git('rev-parse', 'HEAD'), initial));
    assert.notEqual(bad.status, 0, 'a type error must block the push');
    assert.match(`${bad.stdout}\n${bad.stderr}`, /TS2322/, 'failure must come from TypeScript');

    const remote = join(temp, 'remote.git');
    git('init', '--bare', '-q', remote);
    git('config', 'core.hooksPath', '.githooks');
    const push = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], { cwd: repo, env, encoding: 'utf8' });
    assert.notEqual(push.status, 0, 'the installed pre-push hook must block a real push with a type error');
    assert.match(`${push.stdout}\n${push.stderr}`, /TS2322/, 'the real push must fail because of the TypeScript error');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
