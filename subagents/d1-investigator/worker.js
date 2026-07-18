const VERSION = '0.1.0';
const WORKER = 'afo-d1-investigator-mcp';
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
function limitNum(v, dflt, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt; }

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

function compactDb(db) {
  return {
    uuid: db.uuid || db.id,
    name: db.name,
    version: db.version,
    created_at: db.created_at,
    file_size: db.file_size,
    num_tables: db.num_tables
  };
}

function extractRows(queryResult) {
  if (Array.isArray(queryResult)) {
    const first = queryResult[0] || {};
    return first.results || first.result || first.rows || [];
  }
  return queryResult && (queryResult.results || queryResult.result || queryResult.rows) || [];
}

async function listD1Databases(env, args) {
  const track = stageTracker();
  track.start('d1_list');
  const result = await cfApi(env, args, 'GET', '/accounts/{account_id}/d1/database');
  const arr = Array.isArray(result) ? result : (result && (result.items || result.databases || result.result)) || [];
  const q = clean(args.query).toLowerCase();
  const databases = arr.map(compactDb).filter(db => !q || String(db.name || '').toLowerCase().includes(q));
  return { ok: true, count: databases.length, databases: databases.slice(0, limitNum(args.limit, 100, 1, 500)), timings: track.finish() };
}

async function resolveD1Database(env, args) {
  const name = clean(args.database_name || args.name);
  const id = clean(args.database_id || args.uuid);
  if (id) return { ok: true, database_id: id, source: 'provided' };
  if (!name) throw new Error('database_name or database_id is required');
  const listed = await listD1Databases(env, { ...args, query: name, limit: 500 });
  const exact = listed.databases.find(db => db.name === name) || listed.databases.find(db => String(db.name || '').toLowerCase() === name.toLowerCase());
  if (!exact) return { ok: false, error: 'database not found', database_name: name, candidates: listed.databases.slice(0, 20) };
  return { ok: true, database_name: exact.name, database_id: exact.uuid, database: exact, source: 'list_d1_databases' };
}

function assertSafeReadSql(sql) {
  const s = clean(sql).replace(/;\s*$/g, '');
  const lower = s.toLowerCase();
  if (!s) throw new Error('sql is required');
  if (s.split(';').length > 1) throw new Error('exactly one read statement is allowed');
  if (!(lower.startsWith('select ') || lower.startsWith('pragma ') || lower.startsWith('with '))) {
    throw new Error('only SELECT, WITH, or PRAGMA read statements are allowed');
  }
  const blocked = [' insert ', ' update ', ' delete ', ' drop ', ' alter ', ' create ', ' replace ', ' attach ', ' detach ', ' vacuum ', ' reindex '];
  const padded = ' ' + lower.replace(/\s+/g, ' ') + ' ';
  if (blocked.some(x => padded.includes(x))) throw new Error('write/DDL keywords are not allowed in d1 read queries');
  return s;
}

async function queryD1Read(env, args) {
  const sql = assertSafeReadSql(args.sql);
  const resolved = await resolveD1Database(env, args);
  if (!resolved.ok) return resolved;
  const track = stageTracker();
  track.start('d1_query');
  const body = { sql, params: Array.isArray(args.params) ? args.params : [] };
  const result = await cfApi(env, args, 'POST', '/accounts/{account_id}/d1/database/' + encodeURIComponent(resolved.database_id) + '/query', body);
  const rows = extractRows(result);
  const limit = limitNum(args.limit, 100, 1, 500);
  return { ok: true, database_name: resolved.database_name, database_id: resolved.database_id, sql, rows: rows.slice(0, limit), row_count: rows.length, raw_shape: Array.isArray(result) ? 'array' : typeof result, timings: track.finish() };
}

async function listD1Tables(env, args) {
  const sql = "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";
  const out = await queryD1Read(env, { ...args, sql, limit: limitNum(args.limit, 200, 1, 500) });
  if (!out.ok) return out;
  return { ok: true, database_name: out.database_name, database_id: out.database_id, tables: out.rows, count: out.rows.length, timings: out.timings };
}

async function getD1Schema(env, args) {
  const table = clean(args.table_name || args.table);
  const resolved = await resolveD1Database(env, args);
  if (!resolved.ok) return resolved;
  const track = stageTracker();
  const evidence = { database_name: resolved.database_name, database_id: resolved.database_id };
  track.start('tables');
  const tables = await queryD1Read(env, { ...args, database_id: resolved.database_id, sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name", limit: 500 });
  evidence.objects = tables.rows || [];
  if (table) {
    track.start('pragma');
    const quoted = table.replaceAll("'", "''");
    const info = await queryD1Read(env, { ...args, database_id: resolved.database_id, sql: "PRAGMA table_info('" + quoted + "')", limit: 500 });
    evidence.table_info = info.rows || [];
  }
  return { ok: true, ...evidence, timings: track.finish() };
}

async function sampleD1Table(env, args) {
  const table = clean(args.table_name || args.table);
  if (!table) throw new Error('table_name is required');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('table_name must be a simple identifier');
  const limit = limitNum(args.limit, 10, 1, 50);
  return queryD1Read(env, { ...args, sql: 'SELECT * FROM ' + table + ' LIMIT ' + limit, limit });
}

async function runModel(env, evidence, question) {
  if (!env.AI) return null;
  const system = 'You are an AFO D1 database investigator. Answer only from the JSON evidence. Be concise. Mention missing evidence clearly. Do not invent schema or data. Do not expose secrets.';
  const user = 'Question: ' + question + '\n\nEvidence JSON:\n' + JSON.stringify(evidence, null, 2).slice(0, 38000);
  const out = await env.AI.run(MODEL_DEFAULT, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1600 });
  return String(out.response || out.result || out.output_text || '').trim() || null;
}

async function investigateDatabase(env, args) {
  const question = clean(args.question || 'Investigate this D1 database schema and readiness.');
  const resolved = await resolveD1Database(env, args);
  if (!resolved.ok) return resolved;
  const track = stageTracker();
  const evidence = { probes: [resolved.database_name || resolved.database_id], database_name: resolved.database_name, database_id: resolved.database_id, database: resolved.database };

  track.start('schema');
  const schema = await getD1Schema(env, { ...args, database_id: resolved.database_id });
  evidence.objects = schema.objects || [];
  evidence.table_count = evidence.objects.filter(o => o.type === 'table').length;
  evidence.view_count = evidence.objects.filter(o => o.type === 'view').length;
  evidence.index_count = evidence.objects.filter(o => o.type === 'index').length;
  evidence.tables = evidence.objects.filter(o => o.type === 'table').map(o => o.name);

  const sampleTables = Array.isArray(args.sample_tables) ? args.sample_tables : [];
  evidence.samples = [];
  for (const table of sampleTables.slice(0, 5)) {
    try {
      const sample = await sampleD1Table(env, { ...args, database_id: resolved.database_id, table_name: table, limit: 5 });
      evidence.samples.push({ table, row_count: sample.row_count, rows: sample.rows });
    } catch (e) {
      evidence.samples.push({ table, error: String(e.message || e) });
    }
  }

  track.start('synthesis');
  let answer = await runModel(env, evidence, question).catch(() => null);
  if (!answer) {
    answer = 'D1 database ' + (resolved.database_name || resolved.database_id) + ' has ' + evidence.table_count + ' tables, ' + evidence.index_count + ' indexes, and ' + evidence.view_count + ' views. Tables: ' + evidence.tables.join(', ') + '.';
  }

  return {
    ok: true,
    answer,
    flow: 'schema_first_read_only',
    evidence: {
      probes: evidence.probes,
      database_name: evidence.database_name,
      database_id: evidence.database_id,
      table_count: evidence.table_count,
      index_count: evidence.index_count,
      view_count: evidence.view_count,
      tables: evidence.tables,
      sampled_tables: evidence.samples.map(s => ({ table: s.table, row_count: s.row_count, error: s.error }))
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
    mode: 'read_only_d1_investigator',
    bindings: {
      AI: !!env.AI,
      CF_API_TOKEN: !!authToken(env),
      CF_ACCOUNT_ID: !!accountId(env, {}),
      WORKER_NAME: !!env.WORKER_NAME
    },
    tools: ['subagent_status', 'list_d1_databases', 'resolve_d1_database', 'list_d1_tables', 'get_d1_schema', 'query_d1_read', 'sample_d1_table', 'investigate_database']
  };
}

const toolSchemas = [
  { name: 'subagent_status', description: 'Health check: D1 investigator bindings, model, read-only mode, and tools.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_d1_databases', description: 'List D1 databases visible to the Cloudflare API token. Optional query filters by name.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'resolve_d1_database', description: 'Resolve a D1 database name to uuid. Accepts database_name or database_id.', inputSchema: { type: 'object', properties: { database_name: { type: 'string' }, name: { type: 'string' }, database_id: { type: 'string' }, uuid: { type: 'string' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'list_d1_tables', description: 'List tables and views in one D1 database using sqlite_master. Read-only.', inputSchema: { type: 'object', properties: { database_name: { type: 'string' }, database_id: { type: 'string' }, limit: { type: 'number' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'get_d1_schema', description: 'Read sqlite_master objects and optional PRAGMA table_info for one table. Read-only.', inputSchema: { type: 'object', properties: { database_name: { type: 'string' }, database_id: { type: 'string' }, table_name: { type: 'string' }, account_id: { type: 'string' } }, required: [] } },
  { name: 'query_d1_read', description: 'Run exactly one read-only SQL statement against D1. Only SELECT, WITH, and PRAGMA are allowed; write/DDL keywords are blocked.', inputSchema: { type: 'object', properties: { database_name: { type: 'string' }, database_id: { type: 'string' }, sql: { type: 'string' }, params: { type: 'array' }, limit: { type: 'number' }, account_id: { type: 'string' } }, required: ['sql'] } },
  { name: 'sample_d1_table', description: 'Read up to 50 rows from a simple table name. Read-only convenience wrapper.', inputSchema: { type: 'object', properties: { database_name: { type: 'string' }, database_id: { type: 'string' }, table_name: { type: 'string' }, limit: { type: 'number' }, account_id: { type: 'string' } }, required: ['table_name'] } },
  { name: 'investigate_database', description: 'ONE-CALL D1 investigation: resolve database -> read schema -> optionally sample selected tables -> evidence-grounded synthesis with timings. Read-only by design.', inputSchema: { type: 'object', properties: { database_name: { type: 'string' }, database_id: { type: 'string' }, question: { type: 'string' }, sample_tables: { type: 'array', items: { type: 'string' } }, include_raw: { type: 'boolean' }, account_id: { type: 'string' } }, required: [] } }
];

async function callTool(env, name, args) {
  if (name === 'subagent_status') return status(env);
  if (name === 'list_d1_databases') return listD1Databases(env, args || {});
  if (name === 'resolve_d1_database') return resolveD1Database(env, args || {});
  if (name === 'list_d1_tables') return listD1Tables(env, args || {});
  if (name === 'get_d1_schema') return getD1Schema(env, args || {});
  if (name === 'query_d1_read') return queryD1Read(env, args || {});
  if (name === 'sample_d1_table') return sampleD1Table(env, args || {});
  if (name === 'investigate_database') return investigateDatabase(env, args || {});
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
