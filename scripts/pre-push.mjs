import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(command) {
  const windows = process.platform === 'win32';
  const executable = windows ? process.env.ComSpec || 'cmd.exe' : 'pnpm';
  const args = windows ? ['/d', '/s', '/c', 'pnpm', command] : [command];
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`Could not run pnpm ${command}: ${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

try {
  const refs = readFileSync(0, 'utf8').split('\n').filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error('Invalid pre-push ref data.');
    return { local: fields[1], remote: fields[3] };
  });
  const updates = refs.filter(({ local }) => !/^0+$/.test(local));
  if (updates.length === 0) process.exit(0);

  // Check the exact commit being pushed. A dirty worktree or another checked
  // out branch could otherwise hide errors in that commit.
  const head = git('rev-parse', 'HEAD');
  if (updates.some(({ local }) => git('rev-parse', `${local}^{commit}`) !== head)) {
    throw new Error('Check out each commit before pushing it so hooks can check its contents.');
  }
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Commit or stash tracked changes before pushing so hooks check the pushed commit.');
  }
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0');
  if (untracked.some((path) => /(?:\.[cm]?[jt]sx?|(?:^|\/)(?:package|tsconfig[^/]*)\.json)$/.test(path))) {
    throw new Error('Commit or remove untracked source and configuration files before pushing.');
  }

  for (const { local, remote } of updates) {
    let base = remote;
    if (/^0+$/.test(base)) {
      try {
        base = git('merge-base', local, 'refs/remotes/origin/HEAD');
      } catch {
        try {
          base = git('merge-base', local, 'refs/remotes/origin/main');
        } catch {
          // Empty tree: validate the whole commit when no remote base exists.
          base = git('hash-object', '-t', 'tree', '--stdin');
        }
      }
    }
    execFileSync('git', ['diff', '--check', base, local], { stdio: 'inherit' });
  }

  console.log('Running project lint and typecheck before push.');
  const results = await Promise.all([run('lint'), run('typecheck')]);
  if (results.some((result) => !result)) process.exit(1);
} catch (error) {
  console.error(`Pre-push checks failed: ${error.message}`);
  process.exit(1);
}
