import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const id = process.argv[2];
if (!id) {
  console.error('Usage: node scripts/deploy-one.mjs <subagent-id>');
  process.exit(1);
}

const registry = JSON.parse(readFileSync('scripts/subagents.json', 'utf8'));
const item = registry.subagents.find(x => x.id === id || x.worker_name === id);
if (!item) {
  console.error('Unknown subagent: ' + id);
  process.exit(1);
}

const configPath = join(item.path, 'wrangler.jsonc');
if (!existsSync(configPath)) {
  console.error('Missing config: ' + configPath);
  process.exit(1);
}

console.log('Deploying ' + item.worker_name + ' from ' + item.path);
const result = spawnSync('npx', ['wrangler', 'deploy', '--config', configPath], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
process.exit(result.status ?? 1);
