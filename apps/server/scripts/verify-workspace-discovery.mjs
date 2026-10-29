import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, link, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDiscovery } from '../dist/runtime/agent/worker/workspace-discovery-runner.js';
const root = await mkdtemp(join(await realpath(tmpdir()), 'discovery-acceptance-'));
// A clean runner has no initialized application state. Keep grant-directory
// initialization inside the sandbox's writable fixture, never in the real home.
const previousHome = process.env.PI_SCIENCE_HOME;
process.env.PI_SCIENCE_HOME = join(root, 'service-state');
try {
const cwd = root + '/workspace'; const outside = root + '/private';
await mkdir(cwd); await mkdir(outside); await mkdir(cwd + '/data'); await mkdir(cwd + '/holdout');
await writeFile(cwd+'/data/sample.csv','temperature,humidity\n10,20\n');
await writeFile(cwd+'/data/skip.csv','PRIVATE\n'); await writeFile(cwd+'/.gitignore','data/skip.csv\n');
await writeFile(cwd+'/.env','PRIVATE'); await writeFile(cwd+'/holdout/labels.txt','PRIVATE');
await writeFile(outside+'/secret.txt','PRIVATE'); await symlink(outside,cwd+'/alias'); await link(outside+'/secret.txt',cwd+'/hard.txt');
assert.deepEqual((await runDiscovery('ls',cwd,{limit:200})).details.result.entries,[{path:'data/',type:'directory'}]);
assert.deepEqual((await runDiscovery('glob',cwd,{pattern:'**/*.csv',limit:500})).details.result.files,['data/sample.csv']);
assert.deepEqual((await runDiscovery('grep',cwd,{pattern:'temperature',limit:100})).details.result.matches,[{path:'data/sample.csv',line:1,column:1,text:'temperature,humidity'}]);
assert.deepEqual((await runDiscovery('grep',cwd,{pattern:'PRIVATE',limit:100})).details.result.matches,[]);
await writeFile(cwd+'/long.txt','😀'.repeat(5000)+'needle');
assert.deepEqual((await runDiscovery('grep',cwd,{path:'long.txt',pattern:'needle',limit:100})).details.result.matches,[{path:'long.txt',line:1,column:5001,text:'😀'.repeat(128)+'needle'}]);
const controller = new AbortController(); const cancelled = runDiscovery('grep',cwd,{pattern:'.',limit:100},controller.signal); setTimeout(()=>controller.abort(),10);
await assert.rejects(cancelled,/cancelled/);
const skill = cwd+'/.pi/skills/review';
await mkdir(skill,{recursive:true});
await writeFile(skill+'/SKILL.md','review guidance');
await writeFile(skill+'/helper.py',"print('guidance')");
await writeFile(cwd+'/.pi/settings.json','PRIVATE');
const skillFiles = [skill+'/SKILL.md'];
assert.deepEqual((await runDiscovery('ls',cwd,{path:'.pi',limit:100},undefined,skillFiles)).details.result.entries,[{path:'.pi/skills/',type:'directory'}]);
assert.deepEqual((await runDiscovery('glob',cwd,{path:'.pi/skills',pattern:'**/*.py',limit:100},undefined,skillFiles)).details.result.files,['.pi/skills/review/helper.py']);
assert.equal((await runDiscovery('grep',cwd,{path:'.pi/skills',pattern:'guidance',limit:100},undefined,skillFiles)).details.result.matches.length,2);
await assert.rejects(runDiscovery('ls',cwd,{path:'.pi/skills',limit:100}),/access_denied/);
await assert.rejects(runDiscovery('grep',cwd,{path:'.pi/settings.json',pattern:'.',limit:100},undefined,skillFiles),/access_denied/);
console.log('PASS: compiled ls/glob/grep + ignore, links, secrets, long Unicode match windows, and cancellation');
} finally {
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
