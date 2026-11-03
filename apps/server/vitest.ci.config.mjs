import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
import { partitionTestFiles } from './ci/windows-test-shards.mjs';

class WindowsBalancedSequencer extends BaseSequencer {
  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    return partitionTestFiles(files, this.ctx.config.root, count)[index - 1];
  }
}

export default defineConfig({ test: { sequence: { sequencer: WindowsBalancedSequencer } } });
