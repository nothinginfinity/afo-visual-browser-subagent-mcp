import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const id = process.argv[2];
const workerName = process.argv[3];
if (!id || !workerName) {
  console.error('Usage: node scripts/create-subagent.mjs <id> <worker-name>');
  process.exit(1);
}

const dst = join('subagents', id);
if (existsSync(dst)) {
  console.error('Subagent already exists: ' + dst);
  process.exit(1);
}

mkdirSync(dst, { recursive: true });
cpSync('template/worker.js', join(dst, 'worker.js'));
cpSync('template/wrangler.example.jsonc', join(dst, 'wrangler.jsonc'));

let worker = readFileSync(join(dst, 'worker.js'), 'utf8');
worker = worker.replace("const WORKER = 'afo-subagent-mcp';", "const WORKER = '" + workerName + "';");
writeFileSync(join(dst, 'worker.js'), worker);

let config = readFileSync(join(dst, 'wrangler.jsonc'), 'utf8');
config = config.replaceAll('afo-visual-browser-subagent-mcp', workerName);
writeFileSync(join(dst, 'wrangler.jsonc'), config);

writeFileSync(join(dst, 'README.md'), '# ' + workerName + '\n\nCreated from the AFO Visual Browser Sub-Agent MCP template.\n\nPrimary task: fill in the domain-specific investigation tools.\n');

console.log('Created ' + dst);
