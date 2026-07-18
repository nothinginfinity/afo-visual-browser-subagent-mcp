const VERSION = '0.1.2';
const WORKER = 'afo-mcp-tool-auditor';
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
function clamp(n, dflt, min, max) { const x = Number(n); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : dflt; }

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

function isSafeEndpoint(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'invalid endpoint_url' }; }
  if (!['https:', 'http:'].includes(u.protocol)) return { ok: false, error: 'endpoint_url must be http or https' };
  const host = u.hostname.toLowerCase();
  const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  if (blockedHosts.includes(host)) return { ok: false, error: 'local/private hostnames are not allowed' };
  if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return { ok: false, error: 'private IP ranges are not allowed' };
  const allowed = host.endsWith('.workers.dev') || host.endsWith('agentfeedoptimization.com') || host.endsWith('.agentfeedoptimization.com');
  if (!allowed) return { ok: false, error: 'endpoint host is not in the default allowlist', host };
  return { ok: true, url: u.toString(), host };
}

async function postRpc(endpoint, method, params, id) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error('MCP endpoint returned HTTP ' + res.status + ': ' + text.slice(0, 240));
  if (data.error) throw new Error('MCP RPC error: ' + (data.error.message || JSON.stringify(data.error).slice(0, 240)));
  return data.result || data;
}

async function getJson(url) {
  const res = await fetch(url, { method: 'GET', headers: { 'accept': 'application/json' } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error('GET endpoint returned HTTP ' + res.status + ': ' + text.slice(0, 240));
  return data;
}

function toolsUrlFromEndpoint(endpoint) {
  const u = new URL(endpoint);
  u.pathname = '/tools';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function internalTargets() {
  return {
    'repo-investigator': { binding: 'REPO_INVESTIGATOR', worker: 'afo-repo-investigator-mcp' },
    repo_investigator: { binding: 'REPO_INVESTIGATOR', worker: 'afo-repo-investigator-mcp' },
    REPO_INVESTIGATOR: { binding: 'REPO_INVESTIGATOR', worker: 'afo-repo-investigator-mcp' },
    'visual-browser-investigator': { binding: 'WORKER_INVESTIGATOR', worker: 'afo-visual-browser-investigator-mcp' },
    worker_investigator: { binding: 'WORKER_INVESTIGATOR', worker: 'afo-visual-browser-investigator-mcp' },
    WORKER_INVESTIGATOR: { binding: 'WORKER_INVESTIGATOR', worker: 'afo-visual-browser-investigator-mcp' },
    'd1-investigator': { binding: 'D1_INVESTIGATOR', worker: 'afo-d1-investigator-mcp' },
    d1_investigator: { binding: 'D1_INVESTIGATOR', worker: 'afo-d1-investigator-mcp' },
    D1_INVESTIGATOR: { binding: 'D1_INVESTIGATOR', worker: 'afo-d1-investigator-mcp' }
  };
}

function resolveInternalTarget(args) {
  const raw = clean(args.target_worker || args.binding_name || args.target || args.endpoint_url || args.url);
  if (!raw) return null;
  const targets = internalTargets();
  const normalized = raw.toLowerCase().replace(/\s+/g, '-');
  return targets[raw] || targets[normalized] || targets[normalized.replace(/-/g, '_')] || null;
}

async function fetchInternalTools(env, target, track) {
  const service = env[target.binding];
  if (!service || typeof service.fetch !== 'function') return { ok: false, error: 'service binding is not configured: ' + target.binding, binding_name: target.binding, target_worker: target.worker };
  track.start('service_binding_tools');
  const res = await service.fetch(new Request('https://afo-internal.local/tools', { method: 'GET', headers: { accept: 'application/json' } }));
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) return { ok: false, error: 'service binding returned HTTP ' + res.status + ': ' + text.slice(0, 240), binding_name: target.binding, target_worker: target.worker };
  const tools = arr(data.tools || data.result && data.result.tools);
  return { ok: true, endpoint_url: 'service-binding://' + target.binding + '/tools', host: target.worker, source: 'cloudflare_service_binding_tools', target_worker: target.worker, binding_name: target.binding, count: tools.length, tools, timings: track.finish() };
}

async function fetchMcpTools(env, args) {
  const internalTarget = resolveInternalTarget(args || {});
  const track = stageTracker();
  if (internalTarget) return fetchInternalTools(env, internalTarget, track);

  const endpoint = clean(args.endpoint_url || args.url);
  const safe = isSafeEndpoint(endpoint);
  if (!safe.ok) return { ok: false, ...safe };
  let init = null;
  let listed = null;
  let source = 'mcp_tools_list';
  track.start('initialize');
  init = await postRpc(safe.url, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: WORKER, version: VERSION } }, 1).catch(e => ({ error: String(e.message || e) }));
  track.start('tools_list');
  try {
    listed = await postRpc(safe.url, 'tools/list', {}, 2);
  } catch (e) {
    const fallbackUrl = clean(args.tools_url) || toolsUrlFromEndpoint(safe.url);
    const fallbackSafe = isSafeEndpoint(fallbackUrl);
    if (!fallbackSafe.ok) return { ok: false, error: String(e.message || e), fallback_error: fallbackSafe.error };
    track.start('tools_fallback');
    const fallback = await getJson(fallbackSafe.url);
    source = 'http_tools_fallback';
    listed = { tools: arr(fallback.tools) };
  }
  const tools = arr(listed.tools);
  return { ok: true, endpoint_url: safe.url, host: safe.host, source, initialize: init, count: tools.length, tools, timings: track.finish() };
}

function schemaProps(schema) {
  const s = schema || {};
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
  return Object.keys(props);
}

function hasObjectInput(schema) {
  return !!schema && typeof schema === 'object' && (schema.type === 'object' || schema.properties);
}

function riskVerb(name, desc) {
  const text = (String(name || '') + ' ' + String(desc || '')).toLowerCase();
  const verbs = ['send', 'deploy', 'write', 'update', 'create', 'archive', 'trash', 'delete', 'remove', 'purge', 'destroy', 'modify', 'apply', 'execute', 'forward', 'label', 'move'];
  return verbs.filter(v => text.includes(v));
}

function oneCallName(name) {
  const n = String(name || '').toLowerCase();
  return n.startsWith('investigate_') || n.startsWith('audit_') || n.startsWith('ask_') || n.includes('one_call');
}

function auditOneTool(tool) {
  const name = clean(tool && tool.name);
  const description = clean(tool && tool.description);
  const inputSchema = tool && (tool.inputSchema || tool.input_schema || tool.schema);
  const props = schemaProps(inputSchema);
  const required = arr(inputSchema && inputSchema.required);
  const risks = riskVerb(name, description);
  const issues = [];
  const strengths = [];
  let score = 100;

  if (!name) { issues.push('missing name'); score -= 30; }
  if (name && !/^[a-z][a-z0-9_]*$/.test(name)) { issues.push('name should be lowercase snake_case for agent reliability'); score -= 10; }
  if (!description) { issues.push('missing description'); score -= 25; }
  else if (description.length < 40) { issues.push('description is too short for reliable agent selection'); score -= 10; }
  else strengths.push('description is present and useful length');
  if (!hasObjectInput(inputSchema)) { issues.push('missing object inputSchema'); score -= 20; }
  else strengths.push('object inputSchema present');
  if (hasObjectInput(inputSchema) && props.length === 0) issues.push('inputSchema has no properties; okay only for status/health tools');
  if (hasObjectInput(inputSchema) && !Array.isArray(inputSchema.required)) { issues.push('inputSchema.required should be an array, even if empty'); score -= 5; }
  if (risks.length && !/(read-only|read only|confirm|safe|does not|dry-run|dry run|no mutation|never)/i.test(description)) {
    issues.push('mutation-capable wording detected without clear safety/confirmation wording: ' + risks.join(', '));
    score -= 15;
  }
  if (oneCallName(name)) strengths.push('one-call style tool name');
  if (/status|health/.test(name) && props.length === 0) strengths.push('simple health/status tool shape');
  if (props.length > 18) { issues.push('large input surface may be hard for mobile agents'); score -= 5; }

  score = Math.max(0, Math.min(100, score));
  return { name, score, grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F', risk_verbs: risks, props, required, issues, strengths };
}

function summarizeAudits(audits) {
  const scores = audits.map(a => a.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const issueCount = audits.reduce((n, a) => n + a.issues.length, 0);
  const risky = audits.filter(a => a.risk_verbs.length).map(a => a.name);
  const oneCalls = audits.filter(a => a.strengths.includes('one-call style tool name')).map(a => a.name);
  return { tool_count: audits.length, average_score: avg, issue_count: issueCount, risky_tools: risky, one_call_tools: oneCalls, grades: audits.reduce((acc, a) => { acc[a.grade] = (acc[a.grade] || 0) + 1; return acc; }, {}) };
}

async function auditToolSchema(env, args) {
  const tool = args.tool || args;
  return { ok: true, audit: auditOneTool(tool) };
}

async function auditToolList(env, args) {
  const tools = arr(args.tools);
  const audits = tools.map(auditOneTool);
  return { ok: true, summary: summarizeAudits(audits), audits };
}

async function auditMcpEndpoint(env, args) {
  const fetched = await fetchMcpTools(env, args || {});
  if (!fetched.ok) return fetched;
  const audits = fetched.tools.map(auditOneTool);
  return { ok: true, endpoint_url: fetched.endpoint_url, host: fetched.host, source: fetched.source, target_worker: fetched.target_worker || null, binding_name: fetched.binding_name || null, tool_count: fetched.count, summary: summarizeAudits(audits), audits, timings: fetched.timings };
}

async function runModel(env, evidence, question) {
  if (!env.AI) return null;
  const system = 'You are an AFO MCP tool auditor. Answer only from the JSON evidence. Focus on agent usability, mobile readiness, tool naming, schema clarity, one-call workflow quality, and safety wording. Be concise.';
  const user = 'Question: ' + question + '\n\nEvidence JSON:\n' + JSON.stringify(evidence, null, 2).slice(0, 38000);
  const out = await env.AI.run(MODEL_DEFAULT, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1600 });
  return String(out.response || out.result || out.output_text || '').trim() || null;
}

async function investigateMcpTool(env, args) {
  const track = stageTracker();
  const question = clean(args.question || 'Audit this MCP tool surface for agent usability and safety.');
  let evidence;
  track.start('collect');
  if (args.endpoint_url || args.url || args.target_worker || args.binding_name || args.target) evidence = await auditMcpEndpoint(env, args);
  else evidence = await auditToolList(env, args);
  if (!evidence.ok) return evidence;
  track.start('synthesis');
  let answer = await runModel(env, evidence, question).catch(() => null);
  if (!answer) {
    answer = 'Audited ' + (evidence.tool_count || evidence.summary.tool_count) + ' tools. Average score: ' + evidence.summary.average_score + '. Issues: ' + evidence.summary.issue_count + '. One-call tools: ' + evidence.summary.one_call_tools.join(', ') + '.';
  }
  return { ok: true, answer, flow: 'tool_surface_audit', evidence: { endpoint_url: evidence.endpoint_url || null, summary: evidence.summary, top_issues: evidence.audits.flatMap(a => a.issues.map(i => ({ tool: a.name, issue: i }))).slice(0, 20) }, raw: args.include_raw ? evidence : undefined, timings: track.finish() };
}

function status(env) {
  return {
    ok: true,
    worker: WORKER,
    deployed_as: env.WORKER_NAME || null,
    version: VERSION,
    model_default: MODEL_DEFAULT,
    mode: 'read_only_mcp_tool_auditor',
    endpoint_allowlist: ['*.workers.dev', 'agentfeedoptimization.com', '*.agentfeedoptimization.com'],
    internal_targets: Object.keys(internalTargets()).filter(k => k.includes('-')),
    bindings: { AI: !!env.AI, WORKER_NAME: !!env.WORKER_NAME, REPO_INVESTIGATOR: !!env.REPO_INVESTIGATOR, WORKER_INVESTIGATOR: !!env.WORKER_INVESTIGATOR, D1_INVESTIGATOR: !!env.D1_INVESTIGATOR },
    tools: ['subagent_status', 'fetch_mcp_tools', 'audit_tool_schema', 'audit_tool_list', 'audit_mcp_endpoint', 'investigate_mcp_tool']
  };
}

const toolSchemas = [
  { name: 'subagent_status', description: 'Health check: MCP tool auditor status, model, allowlist, and available tools.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'fetch_mcp_tools', description: 'Read-only fetch of tools/list from an allowed MCP endpoint URL or first-wave service binding target. Default public allowlist is workers.dev and agentfeedoptimization.com.', inputSchema: { type: 'object', properties: { endpoint_url: { type: 'string' }, url: { type: 'string' }, tools_url: { type: 'string' }, target_worker: { type: 'string' }, binding_name: { type: 'string' } }, required: [] } },
  { name: 'audit_tool_schema', description: 'Audit one MCP tool schema for name quality, description clarity, inputSchema shape, risk wording, and mobile agent usability.', inputSchema: { type: 'object', properties: { tool: { type: 'object' } }, required: [] } },
  { name: 'audit_tool_list', description: 'Audit a provided list of MCP tool schemas and return scores, grades, risky tools, one-call tools, and issue summaries.', inputSchema: { type: 'object', properties: { tools: { type: 'array', items: { type: 'object' } } }, required: ['tools'] } },
  { name: 'audit_mcp_endpoint', description: 'Fetch tools from an allowed MCP endpoint or first-wave service binding target and audit the entire tool surface. Read-only and does not call individual tools.', inputSchema: { type: 'object', properties: { endpoint_url: { type: 'string' }, url: { type: 'string' }, tools_url: { type: 'string' }, target_worker: { type: 'string' }, binding_name: { type: 'string' } }, required: [] } },
  { name: 'investigate_mcp_tool', description: 'ONE-CALL MCP tool surface investigation: fetch/provided tools or service-binding target -> audit names/descriptions/schemas/safety wording -> AI synthesis with evidence and timings.', inputSchema: { type: 'object', properties: { endpoint_url: { type: 'string' }, url: { type: 'string' }, tools_url: { type: 'string' }, target_worker: { type: 'string' }, binding_name: { type: 'string' }, tools: { type: 'array', items: { type: 'object' } }, question: { type: 'string' }, include_raw: { type: 'boolean' } }, required: [] } }
];

async function callTool(env, name, args) {
  if (name === 'subagent_status') return status(env);
  if (name === 'fetch_mcp_tools') return fetchMcpTools(env, args || {});
  if (name === 'audit_tool_schema') return auditToolSchema(env, args || {});
  if (name === 'audit_tool_list') return auditToolList(env, args || {});
  if (name === 'audit_mcp_endpoint') return auditMcpEndpoint(env, args || {});
  if (name === 'investigate_mcp_tool') return investigateMcpTool(env, args || {});
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
