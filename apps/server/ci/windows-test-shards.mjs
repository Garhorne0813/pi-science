import { readFileSync } from 'node:fs';

// Relative weights from the Windows run of commit 4de89af3. They are unitless
// scheduling hints, not test durations. Unlisted and new files get weight 1.
const weights = JSON.parse(readFileSync(new URL('./windows-test-weights.json', import.meta.url), 'utf8'));

function relativeModuleId(root, moduleId) {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedId = moduleId.replaceAll('\\', '/');
  const prefix = `${normalizedRoot}/`;
  const windowsPath = /^[A-Za-z]:\//.test(prefix);
  if (!(windowsPath ? normalizedId.toLowerCase().startsWith(prefix.toLowerCase()) : normalizedId.startsWith(prefix))) {
    throw new Error(`Test file is outside Vitest root: ${moduleId}`);
  }
  return normalizedId.slice(prefix.length);
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// All runners independently compute the same partition from the discovered set.
// No local test cache is read. Every input specification is assigned exactly once.
export function partitionTestFiles(files, root, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid shard count');
  const seen = new Set();
  const items = files.map((spec) => {
    const path = relativeModuleId(root, spec.moduleId);
    const key = `${spec.project?.name ?? ''}:${path}:${spec.pool ?? ''}`;
    if (seen.has(key)) throw new Error(`Duplicate test specification: ${key}`);
    seen.add(key);
    return { spec, key, weight: Object.hasOwn(weights, path) ? weights[path] : 1 };
  });
  items.sort((a, b) => b.weight - a.weight || compare(a.key, b.key));
  const partitions = Array.from({ length: count }, () => []);
  const totals = Array(count).fill(0);
  for (const item of items) {
    let target = 0;
    for (let i = 1; i < count; i += 1) {
      if (totals[i] < totals[target]) target = i;
    }
    partitions[target].push(item.spec);
    totals[target] += item.weight;
  }
  return partitions;
}
