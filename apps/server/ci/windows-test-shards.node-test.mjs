import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionTestFiles } from './windows-test-shards.mjs';

const spec = (moduleId) => ({ moduleId, project: { name: '' }, pool: 'forks' });

test('assigns each discovered file once, including new files, regardless of discovery order', () => {
  const files = [
    spec('D:\\repo\\apps\\server\\src\\runtime\\agent\\agent-core-tools.test.ts'),
    spec('D:\\repo\\apps\\server\\src\\http\\routes\\business-routes.test.ts'),
    spec('D:\\repo\\apps\\server\\src\\new.test.ts'),
    spec('D:\\repo\\apps\\server\\src\\other.test.ts'),
    spec('D:\\repo\\apps\\server\\src\\another.test.ts'),
  ];
  const partition = (input) => partitionTestFiles(input, 'D:\\repo\\apps\\server', 4)
    .map((shard) => shard.map(({ moduleId }) => moduleId).sort());
  const shards = partition(files);
  assert.deepEqual(shards, partition([...files].reverse()));
  assert.deepEqual(shards.flat().sort(), files.map(({ moduleId }) => moduleId).sort());
  assert.equal(new Set(shards.flat()).size, files.length);
});

test('supports POSIX paths, empty shards, and fails closed on invalid inputs', () => {
  const files = [spec('/repo/apps/server/src/new.test.ts')];
  const shards = partitionTestFiles(files, '/repo/apps/server', 4);
  assert.deepEqual(shards.flat(), files);
  assert.equal(shards.filter((shard) => shard.length === 0).length, 3);
  assert.throws(() => partitionTestFiles(files, '/repo/apps/other', 4), /outside Vitest root/);
  assert.throws(() => partitionTestFiles([files[0], files[0]], '/repo/apps/server', 4), /Duplicate/);
  assert.throws(() => partitionTestFiles(files, '/repo/apps/server', 0), /Invalid/);
});
