import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const registry = JSON.parse(readFileSync('scripts/subagents.json', 'utf8'));
const deployable = registry.subagents.filter(x => x.status !== 'planned');

for (const item of deployable) {
  console.log('\n=== Deploying ' + item.worker_name + ' ===');
  const result = spawnSync('node', ['scripts/deploy-one.mjs', item.id], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if ((result.status ?? 1) !== 0) {
    console.error('Deploy failed: ' + item.id);
    process.exit(result.status ?? 1);
  }
}

console.log('\nAll deployable subagents completed.');
