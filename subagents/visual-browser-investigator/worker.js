const VERSION = '0.1.0';
const WORKER = 'afo-visual-browser-investigator-mcp';
const CF = 'https://api.cloudflare.com/client/v4';
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
function accountId(env, args) { return clean((args && args.account_id) || env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID); }
function authToken(env) { return clean(env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN); }

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

async function cfApi(env, args, method, path, body) {
  const acct = accountId(env, args || {});
  const token = authToken(env);
  if (!acct) throw new Error('CF_ACCOUNT_ID is required');
  if (!token) throw new Error('CF_API_TOKEN is required');
  const finalPath = path.replaceAll('{account_id}', encodeURIComponent(acct));
  const res = await fetch(CF + finalPath, {
    method,
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': WORKER + '/' + VERSION
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.success === false) {
    const msg = data && data.errors && data.errors[0] ? data.errors[0].message : text.slice(0, 240);
    throw new Error('Cloudflare ' + method + ' ' + finalPath + ' -> ' + res.status + ': ' + msg);
  }
  return data.result;
}

function compactSettings(settings) {
  return {
    compatibility_date: settings && settings.compatibility_date,
    compatibility_flags: settings && settings.compatibility_flags || [],
    usage_model: settings && settings.usage_model,
    logpush: settings && settings.logpush,
    placement: settings && settings.placement || {},
    bindings: (settings && settings.bindings || []).map(b => {
      const out = { name: b.name, type: b.type };
      if (b.text && b.type !== 'secret_text') out.text = b.text;
      if (b.namespace_id) out.namespace_id = b.namespace_id;
      if (b.id) out.id = b.id;
      if (b.bucket_name) out.bucket_name = b.bucket_name;
      if (b.index_name) out.index_name = b.index_name;
      if (b.project) out.project = b.project;
      return out;
    }),
    annotations: settings && settings.annotations || {}
  };
}

async function listWorkers(env, args) {
  const track = stageTracker();
  track.start('cloudflare');
  const result = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/scripts');
  const scripts = Array.isArray(result) ? result : (result && result.scripts) || [];
  const q = clean(args && args.query).toLowerCase();
  const items = scripts
    .map(s => ({
      id: s.id || s.name,
      name: s.id || s.name,
      created_on: s.created_on,
      modified_on: s.modified_on,
      usage_model: s.usage_model,
      compatibility_date: s.compatibility_date
    }))
    .filter(x => !q || String(x.name || '').toLowerCase().includes(q));
  return { ok: true, count: items.length, workers: items.slice(0, Number(args.limit || 100)), timings: track.finish() };
}

async function getWorkerSettings(env, args) {
  const script = clean(args.script_name || args.worker_name || args.name);
  if (!script) throw new Error('script_name is required');
  const track = stageTracker();
  track.start('settings');
  const settings = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/scripts/' + encodeURIComponent(script) + '/settings');
  return { ok: true, script_name: script, settings: compactSettings(settings), timings: track.finish() };
}

async function getWorkerSubdomain(env, args) {
  const script = clean(args.script_name || args.worker_name || args.name);
  if (!script) throw new Error('script_name is required');
  const track = stageTracker();
  track.start('subdomain');
  const sub = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/scripts/' + encodeURIComponent(script) + '/subdomain');
  const acctSub = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/subdomain').catch(() => null);
  const url = acctSub && acctSub.subdomain && sub && sub.enabled ? 'https://' + script + '.' + acctSub.subdomain + '.workers.dev' : null;
  return { ok: true, script_name: script, subdomain: sub, account_subdomain: acctSub, url, timings: track.finish() };
}

async function listWorkerVersions(env, args) {
  const script = clean(args.script_name || args.worker_name || args.name);
  if (!script) throw new Error('script_name is required');
  const track = stageTracker();
  track.start('versions');
  const versions = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/scripts/' + encodeURIComponent(script) + '/versions').catch(e => ({ error: String(e.message || e) }));
  return { ok: !versions.error, script_name: script, versions, timings: track.finish() };
}

function bindingSummary(settings) {
  const bindings = settings.bindings || [];
  return {
    total: bindings.length,
    names: bindings.map(b => b.name),
    types: bindings.reduce((acc, b) => { acc[b.type] = (acc[b.type] || 0) + 1; return acc; }, {}),
    has_ai: bindings.some(b => b.type === 'ai' || b.name === 'AI'),
    has_d1: bindings.some(b => b.type === 'd1'),
    has_r2: bindings.some(b => b.type === 'r2_bucket'),
    has_kv: bindings.some(b => b.type === 'kv_namespace'),
    has_secret: bindings.some(b => b.type === 'secret_text')
  };
}

async function runModel(env, evidence, question) {
  if (!env.AI) return null;
  const system = 'You are an AFO Cloudflare Worker investigator. Answer only from the JSON evidence. Be concise. Mention missing evidence clearly. Do not expose secret values.';
  const user = 'Question: ' + question + '\n\nEvidence JSON:\n' + JSON.stringify(evidence, null, 2);
  const out = await env.AI.run(MODEL_DEFAULT, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1600 });
  return String(out.response || out.result || out.output_text || '').trim() || null;
}

async function investigateWorker(env, args) {
  const script = clean(args.script_name || args.worker_name || args.name);
  const question = clean(args.question || ('Investigate Worker ' + script));
  if (!script) throw new Error('script_name is required');
  const track = stageTracker();
  const evidence = { probes: [script], script_name: script };

  track.start('settings');
  const settingsRaw = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/scripts/' + encodeURIComponent(script) + '/settings');
  evidence.settings = compactSettings(settingsRaw);
  evidence.binding_summary = bindingSummary(evidence.settings);

  track.start('subdomain');
  evidence.subdomain = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/scripts/' + encodeURIComponent(script) + '/subdomain').catch(e => ({ error: String(e.message || e) }));
  evidence.account_subdomain = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/subdomain').catch(e => ({ error: String(e.message || e) }));
  if (evidence.account_subdomain && evidence.account_subdomain.subdomain && evidence.subdomain && evidence.subdomain.enabled) {
    evidence.workers_dev_url = 'https://' + script + '.' + evidence.account_subdomain.subdomain + '.workers.dev';
  }

  track.start('versions');
  evidence.versions = await cfApi(env, args, 'GET', '/accounts/{account_id}/workers/scripts/' + encodeURIComponent(script) + '/versions').catch(e => ({ error: String(e.message || e) }));

  track.start('synthesis');
  let answer = await runModel(env, evidence, question).catch(e => null);
  if (!answer) {
    answer = 'Worker ' + script + ' is reachable through the Cloudflare API. It has ' + evidence.binding_summary.total + ' bindings: ' + evidence.binding_summary.names.join(', ') + '. workers.dev is ' + (evidence.subdomain && evidence.subdomain.enabled ? 'enabled' : 'not confirmed') + (evidence.workers_dev_url ? ' at ' + evidence.workers_dev_url : '') + '.';
  }

  return {
    ok: true,
    answer,
    flow: 'cloudflare_settings_first',
    evidence: {
      probes: evidence.probes,
      script_name: script,
      workers_dev_url: evidence.workers_dev_url || null,
      compatibility_date: evidence.settings.compatibility_date,
      binding_summary: evidence.binding_summary,
      subdomain: evidence.subdomain
    },
    raw: args.include_raw ? evidence : undefined,
    timings: track.finish()
  };
}

function status(env) {
  return {
    ok: true,
    worker: WORKER,
    deployed_as: env.WORKER_NAME || null,
    version: VERSION,
    model_default: MODEL_DEFAULT,
    bindings: {
      AI: !!env.AI,
      CF_API_TOKEN: !!authToken(env),
      CF_ACCOUNT_ID: !!accountId(env, {}),
      WORKER_NAME: !!env.WORKER_NAME
    },
    tools: ['subagent_status', 'list_workers', 'get_worker_settings', 'get_worker_subdomain', 'list_worker_versions', 'investigate_worker']
  };
}

const toolSchemas = [
  { name: 'subagent_status', description: 'Health check: bindings, model, runtime secret readiness, and tool list.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_workers', description: 'List Cloudflare Workers in the account. Optional query filters by Worker name.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'get_worker_settings', description: 'Read one Worker settings object: bindings, compatibility date, annotations, usage model. Secret values are never returned by Cloudflare.', inputSchema: { type: 'object', properties: { script_name: { type: 'string' }, worker_name: { type: 'string' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'get_worker_subdomain', description: 'Check whether a Worker workers.dev subdomain is enabled and return the expected URL when possible.', inputSchema: { type: 'object', properties: { script_name: { type: 'string' }, worker_name: { type: 'string' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'list_worker_versions', description: 'List Worker versions when the Cloudflare API token has permission. Returns a structured error if that endpoint is unavailable.', inputSchema: { type: 'object', properties: { script_name: { type: 'string' }, worker_name: { type: 'string' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'investigate_worker', description: 'ONE-CALL Cloudflare Worker investigation: settings -> bindings -> workers.dev status -> versions if available -> evidence-grounded synthesis with timings. Use this for deploy, binding, and runtime configuration questions.', inputSchema: { type: 'object', properties: { script_name: { type: 'string' }, worker_name: { type: 'string' }, question: { type: 'string' }, include_raw: { type: 'boolean' }, account_id: { type: 'string' } }, required: [] } }
];

async function callTool(env, name, args) {
  if (name === 'subagent_status') return status(env);
  if (name === 'list_workers') return listWorkers(env, args || {});
  if (name === 'get_worker_settings') return getWorkerSettings(env, args || {});
  if (name === 'get_worker_subdomain') return getWorkerSubdomain(env, args || {});
  if (name === 'list_worker_versions') return listWorkerVersions(env, args || {});
  if (name === 'investigate_worker') return investigateWorker(env, args || {});
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
