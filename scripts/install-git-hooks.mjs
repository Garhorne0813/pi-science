import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const configuredPath = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
if (configuredPath.status === 0) {
  if (configuredPath.stdout.trim() === '.githooks') {
    console.log('Repository hooks are already configured.');
    process.exit(0);
  }
  console.error(`Refusing to replace existing core.hooksPath: ${configuredPath.stdout.trim()}`);
  process.exit(1);
}
if (configuredPath.status !== 1) {
  console.error('Could not read core.hooksPath.');
  process.exit(1);
}

const hookDirectory = git('rev-parse', '--git-path', 'hooks');
let hooks;
try {
  hooks = readdirSync(hookDirectory).filter((name) => !name.endsWith('.sample'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  hooks = [];
}
if (hooks.length > 0) {
  console.error(`Refusing to replace existing hooks in ${hookDirectory}: ${hooks.join(', ')}`);
  process.exit(1);
}

// Git shares repository-local config between worktrees. The user must invoke
// this installer explicitly because it changes the setting for all worktrees.
git('config', '--local', 'core.hooksPath', '.githooks');
console.log('Installed repository hooks. Git shares this setting across worktrees.');
