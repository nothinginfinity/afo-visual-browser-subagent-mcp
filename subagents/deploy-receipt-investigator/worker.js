const VERSION = '0.1.0';
const WORKER = 'afo-deploy-receipt-investigator-mcp';
const GH = 'https://api.github.com';
const MODEL_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id'
};

function j(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function readJson(req) { try { return await req.json(); } catch { return {}; } }
function clean(v) { return String(v || '').trim(); }
function arr(v) { return Array.isArray(v) ? v : []; }
function limitNum(v, dflt, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt; }
function defaultOwner(env, args) { return clean((args && args.owner) || env.DEFAULT_OWNER || 'nothinginfinity'); }
function defaultRepo(args) { return clean(args && args.repo) || 'afo-visual-browser-subagent-mcp'; }
function defaultRef(args) { return clean(args && args.ref) || 'main'; }
function authToken(env) { return clean(env.GITHUB_TOKEN || env.GH_TOKEN); }

function stageTracker() {
  const t0 = Date.now();
  const stages = {};
  let cur = null;
  let start = 0;
  return {
    start(name) {
      if (cur) stages[cur] = (stages[cur] || 0) + Date.now() - start;
      cur = name;
      start = Date.now();
    },
    finish() {
      if (cur) stages[cur] = (stages[cur] || 0) + Date.now() - start;
      cur = null;
      return { stages_ms: stages, total_ms: Date.now() - t0 };
    }
  };
}

function ghHeaders(env) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': WORKER + '/' + VERSION,
    'x-github-api-version': '2022-11-28'
  };
  const token = authToken(env);
  if (token) headers.authorization = 'Bearer ' + token;
  return headers;
}

function qs(obj) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '') continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? '?' + s : '';
}

async function ghFetch(env, path, query) {
  const res = await fetch(GH + path + qs(query), { headers: ghHeaders(env) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data && data.message ? data.message : text.slice(0, 240);
    throw new Error('GitHub GET ' + path + ' -> ' + res.status + ': ' + msg);
  }
  return data;
}

function decodeBase64(s) {
  const raw = atob(String(s || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function compactRun(run) {
  return {
    id: run.id,
    name: run.name,
    workflow_id: run.workflow_id,
    workflow_url: run.workflow_url,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    run_number: run.run_number,
    run_attempt: run.run_attempt,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url
  };
}

function compactJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    html_url: job.html_url,
    steps: arr(job.steps).map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion, number: s.number }))
  };
}

function compactTreeFile(f) {
  return { path: f.path, size: f.size || null, type: f.type, sha: f.sha };
}

async function listRepoTree(env, args) {
  const owner = defaultOwner(env, args);
  const repo = defaultRepo(args);
  const ref = defaultRef(args);
  const data = await ghFetch(env, '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/git/trees/' + encodeURIComponent(ref), { recursive: 1 });
  return arr(data.tree).filter(f => f.type === 'blob').map(compactTreeFile);
}

async function listReceipts(env, args) {
  const track = stageTracker();
  track.start('tree');
  const files = await listRepoTree(env, args || {});
  const prefix = clean(args.prefix || 'receipts/');
  const query = clean(args.query).toLowerCase();
  const limit = limitNum(args.limit, 50, 1, 200);
  let receipts = files.filter(f => f.path.startsWith(prefix));
  if (query) receipts = receipts.filter(f => f.path.toLowerCase().includes(query));
  receipts = receipts.slice(0, limit);
  return { ok: true, owner: defaultOwner(env, args), repo: defaultRepo(args), ref: defaultRef(args), prefix, count: receipts.length, receipts, timings: track.finish() };
}

async function readReceipt(env, args) {
  const owner = defaultOwner(env, args || {});
  const repo = defaultRepo(args || {});
  const ref = defaultRef(args || {});
  const path = clean(args.path || args.receipt_path);
  if (!path) return { ok: false, error: 'path or receipt_path is required' };
  const maxChars = limitNum(args.max_chars, 30000, 1000, 100000);
  const data = await ghFetch(env, '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/' + path.split('/').map(encodeURIComponent).join('/'), { ref });
  const text = decodeBase64(data.content || '');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { ok: true, owner, repo, ref, path, sha: data.sha, size: data.size, truncated: text.length > maxChars, text: text.slice(0, maxChars), json: parsed, total_chars: text.length };
}

async function listDeployRuns(env, args) {
  const owner = defaultOwner(env, args || {});
  const repo = defaultRepo(args || {});
  const branch = clean(args.branch || args.ref || 'main');
  const status = clean(args.status);
  const event = clean(args.event);
  const limit = limitNum(args.limit, 10, 1, 50);
  const query = { branch, per_page: limit };
  if (status) query.status = status;
  if (event) query.event = event;
  const data = await ghFetch(env, '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/actions/runs', query);
  let runs = arr(data.workflow_runs).map(compactRun);
  const workflow = clean(args.workflow || args.workflow_name).toLowerCase();
  if (workflow) runs = runs.filter(r => String(r.name || '').toLowerCase().includes(workflow));
  return { ok: true, owner, repo, branch, total_count: data.total_count, count: runs.length, runs };
}

async function inspectDeployRun(env, args) {
  const owner = defaultOwner(env, args || {});
  const repo = defaultRepo(args || {});
  const runId = clean(args.run_id || args.id);
  if (!runId) return { ok: false, error: 'run_id is required' };
  const track = stageTracker();
  track.start('run');
  const run = await ghFetch(env, '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/actions/runs/' + encodeURIComponent(runId));
  track.start('jobs');
  const jobs = await ghFetch(env, '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/actions/runs/' + encodeURIComponent(runId) + '/jobs', { per_page: 100 });
  return { ok: true, owner, repo, run: compactRun(run), jobs: arr(jobs.jobs).map(compactJob), timings: track.finish() };
}

function summarize(receipts, runs, jobs) {
  const completed = runs.filter(r => r.status === 'completed');
  const failures = completed.filter(r => r.conclusion && r.conclusion !== 'success');
  const successes = completed.filter(r => r.conclusion === 'success');
  return {
    receipt_count: receipts.length,
    run_count: runs.length,
    completed_runs: completed.length,
    successful_runs: successes.length,
    non_success_runs: failures.length,
    latest_run: runs[0] || null,
    failed_jobs: arr(jobs).filter(j => j.conclusion && j.conclusion !== 'success').map(j => ({ name: j.name, conclusion: j.conclusion }))
  };
}

async function runModel(env, evidence, question) {
  if (!env.AI) return null;
  const system = 'You are an AFO deploy receipt investigator. Use only the JSON evidence. Focus on deployment history, receipts, drift signals, missing receipts, and next verification steps. Be concise.';
  const user = 'Question: ' + question + '\n\nEvidence JSON:\n' + JSON.stringify(evidence, null, 2).slice(0, 38000);
  const out = await env.AI.run(MODEL_DEFAULT, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1600 });
  return String(out.response || out.result || out.output_text || '').trim() || null;
}

async function investigateDeployReceipts(env, args) {
  const track = stageTracker();
  const question = clean(args.question || 'Inspect deployment receipts, recent workflow runs, and drift signals.');
  track.start('receipts');
  const receiptsRes = await listReceipts(env, { ...args, limit: limitNum(args.receipt_limit, 20, 1, 100) });
  track.start('runs');
  const runsRes = await listDeployRuns(env, { ...args, limit: limitNum(args.run_limit, 10, 1, 30) });
  let jobs = [];
  if (runsRes.runs[0]) {
    track.start('latest_jobs');
    const inspected = await inspectDeployRun(env, { ...args, run_id: runsRes.runs[0].id });
    jobs = inspected.jobs;
  }
  const evidence = { receipts: receiptsRes.receipts, runs: runsRes.runs, jobs, summary: summarize(receiptsRes.receipts, runsRes.runs, jobs) };
  track.start('synthesis');
  let answer = await runModel(env, evidence, question).catch(() => null);
  if (!answer) {
    const s = evidence.summary;
    answer = 'Found ' + s.receipt_count + ' receipt files and ' + s.run_count + ' recent workflow runs. Latest run: ' + (s.latest_run ? s.latest_run.name + ' / ' + s.latest_run.conclusion : 'none') + '. Non-success runs in window: ' + s.non_success_runs + '.';
  }
  return { ok: true, answer, flow: 'deploy_receipt_investigation', evidence: args.include_raw ? evidence : { summary: evidence.summary, receipts: evidence.receipts.slice(0, 10), runs: evidence.runs.slice(0, 10) }, timings: track.finish() };
}

function status(env) {
  return {
    ok: true,
    worker: WORKER,
    deployed_as: env.WORKER_NAME || null,
    version: VERSION,
    mode: 'read_only_deploy_receipt_investigator',
    model_default: MODEL_DEFAULT,
    bindings: { AI: !!env.AI, WORKER_NAME: !!env.WORKER_NAME, GITHUB_TOKEN: !!authToken(env), DEFAULT_OWNER: !!env.DEFAULT_OWNER },
    tools: ['subagent_status', 'list_receipts', 'read_receipt', 'list_deploy_runs', 'inspect_deploy_run', 'investigate_deploy_receipts']
  };
}

const toolSchemas = [
  { name: 'subagent_status', description: 'Health check: deploy receipt investigator bindings, read-only mode, model, and tool list.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_receipts', description: 'List receipt files from a GitHub repo path, defaulting to receipts/. Read-only and does not mutate repo state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, prefix: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
  { name: 'read_receipt', description: 'Read one receipt file by path and parse JSON when possible. Read-only evidence pull.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' }, receipt_path: { type: 'string' }, max_chars: { type: 'number' } }, required: [] } },
  { name: 'list_deploy_runs', description: 'List recent GitHub Actions workflow runs for a repo, optionally filtered by workflow name, branch, status, or event. Read-only.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, ref: { type: 'string' }, workflow: { type: 'string' }, workflow_name: { type: 'string' }, status: { type: 'string' }, event: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
  { name: 'inspect_deploy_run', description: 'Read one GitHub Actions run and its latest jobs/steps by run_id. Read-only deploy evidence inspection.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, run_id: { type: 'string' }, id: { type: 'string' } }, required: [] } },
  { name: 'investigate_deploy_receipts', description: 'ONE-CALL deploy receipt investigation: list receipts -> list deploy runs -> inspect latest jobs -> evidence-grounded synthesis with timings. Read-only.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, branch: { type: 'string' }, workflow: { type: 'string' }, question: { type: 'string' }, receipt_limit: { type: 'number' }, run_limit: { type: 'number' }, include_raw: { type: 'boolean' } }, required: [] } }
];

async function callTool(env, name, args) {
  if (name === 'subagent_status') return status(env);
  if (name === 'list_receipts') return listReceipts(env, args || {});
  if (name === 'read_receipt') return readReceipt(env, args || {});
  if (name === 'list_deploy_runs') return listDeployRuns(env, args || {});
  if (name === 'inspect_deploy_run') return inspectDeployRun(env, args || {});
  if (name === 'investigate_deploy_receipts') return investigateDeployReceipts(env, args || {});
  throw new Error('Unknown tool: ' + name);
}

async function handleMcp(req, env) {
  const rpc = await readJson(req);
  const id = rpc.id == null ? null : rpc.id;
  try {
    if (rpc.method === 'initialize') return j({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: WORKER, version: VERSION } } });
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204, headers: CORS });
    if (rpc.method === 'ping') return j({ jsonrpc: '2.0', id, result: {} });
    if (rpc.method === 'tools/list') return j({ jsonrpc: '2.0', id, result: { tools: toolSchemas } });
    if (rpc.method === 'tools/call') {
      let result;
      try { result = await callTool(env, rpc.params && rpc.params.name, rpc.params && rpc.params.arguments || {}); }
      catch (e) { result = { ok: false, error: String(e.message || e) }; }
      return j({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result && result.ok === false } });
    }
    return j({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    return j({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/' || url.pathname === '/status' || url.pathname === '/health') return j(status(env));
      if (url.pathname === '/tools') return j({ ok: true, tools: toolSchemas });
      if (url.pathname === '/mcp') return handleMcp(req, env);
      if (req.method === 'POST' && url.pathname === '/call') {
        const b = await readJson(req);
        try { return j(await callTool(env, b.name, b.arguments || {})); }
        catch (e) { return j({ ok: false, error: String(e.message || e) }, 200); }
      }
      return j({ ok: false, error: 'not_found', worker: WORKER }, 404);
    } catch (e) {
      return j({ ok: false, error: String(e.message || e), worker: WORKER }, 500);
    }
  }
};
