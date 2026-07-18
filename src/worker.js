import puppeteer from '@cloudflare/puppeteer';

const VERSION = '0.1.0-phase1';
const NAME = 'afo-visual-browser-subagent-mcp';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id' };
const VIEWPORTS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 1000, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false }
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { ...CORS, 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' } });
}
async function body(req) { try { return await req.json(); } catch { return {}; } }
function clamp(v, lo, hi, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; }
function targetUrl(raw) {
  const url = new URL(String(raw || '').trim());
  if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed in public_readonly mode');
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) throw new Error('Localhost targets are blocked');
  if (/^(127\.|10\.|169\.254\.|192\.168\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) throw new Error('Private IPv4 targets are blocked');
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) throw new Error('Private IPv6 targets are blocked');
  url.username = ''; url.password = '';
  return url;
}
function redact(url) {
  const copy = new URL(url.toString());
  for (const key of copy.searchParams.keys()) if (/token|key|secret|auth|password|signature/i.test(key)) copy.searchParams.set(key, '[REDACTED]');
  return copy.toString();
}
function viewport(input) {
  if (typeof input === 'string' && VIEWPORTS[input]) return { name: input, ...VIEWPORTS[input] };
  if (input && typeof input === 'object') return { name: String(input.name || 'custom'), width: clamp(input.width, 240, 2560, 1440), height: clamp(input.height, 240, 2560, 1000), deviceScaleFactor: clamp(input.deviceScaleFactor, 1, 3, 1), isMobile: input.isMobile === true, hasTouch: input.hasTouch === true };
  return { name: 'desktop', ...VIEWPORTS.desktop };
}
function analytics(env, tool, status, runId, vp, host, duration, bytes = 0) {
  env.ANALYTICS?.writeDataPoint({ blobs: [tool, status, vp || 'none', host || 'unknown'], doubles: [duration || 0, bytes], indexes: [runId] });
}
async function receipt(env, data) {
  const key = `runs/${data.run_id}/receipt.json`;
  await env.RECEIPTS?.put(key, JSON.stringify(data, null, 2), { httpMetadata: { contentType: 'application/json' } });
  if (env.DB) await env.DB.prepare('INSERT INTO visual_runs (run_id, kind, target_url, created_at, status, receipt_key, viewport_count, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(data.run_id, data.kind, data.target_url, data.created_at, data.ok ? 'ok' : 'error', key, data.viewport_count || 1, data.duration_ms || 0).run();
  return key;
}
async function open(env, args, vp) {
  if (!env.BROWSER) throw new Error('BROWSER binding is not configured');
  const url = targetUrl(args.url);
  const timeout = clamp(args.timeout_ms, 5000, 60000, 30000);
  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.setDefaultNavigationTimeout(timeout);
  page.setDefaultTimeout(timeout);
  const started = Date.now();
  const response = await page.goto(url.toString(), { waitUntil: args.wait_until || 'networkidle2', timeout });
  if (args.wait_for_selector) await page.waitForSelector(String(args.wait_for_selector), { timeout });
  if (args.delay_ms) await new Promise(r => setTimeout(r, clamp(args.delay_ms, 0, 10000, 0)));
  return { browser, page, url, response, started };
}
async function capture(env, args, profile, kind = 'screenshot') {
  const vp = viewport(profile);
  const runId = crypto.randomUUID();
  let browser;
  try {
    const state = await open(env, args, vp); browser = state.browser;
    const png = new Uint8Array(await state.page.screenshot({ type: 'png', fullPage: args.full_page !== false, captureBeyondViewport: true }));
    if (png.byteLength > 10 * 1024 * 1024) throw new Error('Screenshot exceeded 10 MiB limit');
    const shotKey = `runs/${runId}/${vp.name}.png`;
    await env.RECEIPTS?.put(shotKey, png, { httpMetadata: { contentType: 'image/png' } });
    const page = await state.page.evaluate(() => ({ title: document.title, lang: document.documentElement.lang || null, ready_state: document.readyState, scroll_width: document.documentElement.scrollWidth, scroll_height: document.documentElement.scrollHeight, viewport_width: innerWidth, viewport_height: innerHeight, text_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200) }));
    const result = { ok: true, run_id: runId, kind, target_url: redact(state.url), final_url: redact(new URL(state.page.url())), created_at: new Date().toISOString(), viewport: vp, http_status: state.response?.status() || null, screenshot: { r2_key: env.RECEIPTS ? shotKey : null, content_type: 'image/png', bytes: png.byteLength }, page, duration_ms: Date.now() - state.started };
    result.receipt_key = await receipt(env, result);
    analytics(env, 'capture_screenshot', 'ok', runId, vp.name, state.url.hostname, result.duration_ms, png.byteLength);
    return result;
  } finally { await browser?.close(); }
}
async function snapshot(env, args) {
  const vp = viewport(args.viewport), runId = crypto.randomUUID();
  let browser;
  try {
    const state = await open(env, args, vp); browser = state.browser;
    const [pngRaw, html, data] = await Promise.all([
      state.page.screenshot({ type: 'png', fullPage: args.full_page !== false, captureBeyondViewport: true }),
      state.page.content(),
      state.page.evaluate(() => ({ title: document.title, headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 100).map(x => ({ level: x.tagName.toLowerCase(), text: (x.innerText || '').trim().slice(0, 300) })), links: [...document.querySelectorAll('a[href]')].slice(0, 200).map(x => ({ text: (x.innerText || '').trim().slice(0, 200), href: x.href })), buttons: [...document.querySelectorAll('button,[role="button"]')].slice(0, 100).map(x => ({ text: (x.innerText || x.getAttribute('aria-label') || '').trim().slice(0, 200), disabled: Boolean(x.disabled) })), landmarks: [...document.querySelectorAll('main,nav,header,footer,aside,[role]')].slice(0, 150).map(x => ({ tag: x.tagName.toLowerCase(), role: x.getAttribute('role'), label: x.getAttribute('aria-label') })), text: (document.body?.innerText || '').slice(0, 50000) }))
    ]);
    const png = new Uint8Array(pngRaw);
    const keys = { screenshot: `runs/${runId}/${vp.name}.png`, html: `runs/${runId}/page.html`, snapshot: `runs/${runId}/snapshot.json` };
    if (env.RECEIPTS) await Promise.all([env.RECEIPTS.put(keys.screenshot, png, { httpMetadata: { contentType: 'image/png' } }), env.RECEIPTS.put(keys.html, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }), env.RECEIPTS.put(keys.snapshot, JSON.stringify(data, null, 2), { httpMetadata: { contentType: 'application/json' } })]);
    const result = { ok: true, run_id: runId, kind: 'snapshot', target_url: redact(state.url), final_url: redact(new URL(state.page.url())), created_at: new Date().toISOString(), viewport: vp, http_status: state.response?.status() || null, artifacts: env.RECEIPTS ? keys : null, snapshot: data, html_chars: html.length, screenshot_bytes: png.byteLength, duration_ms: Date.now() - state.started };
    result.receipt_key = await receipt(env, result);
    analytics(env, 'capture_snapshot', 'ok', runId, vp.name, state.url.hostname, result.duration_ms, png.byteLength);
    return result;
  } finally { await browser?.close(); }
}
async function multi(env, args) {
  const profiles = (Array.isArray(args.viewports) && args.viewports.length ? args.viewports : ['mobile', 'desktop']).slice(0, 6);
  const results = [];
  for (const profile of profiles) { try { results.push(await capture(env, args, profile)); } catch (e) { results.push({ ok: false, viewport: viewport(profile), error: String(e.message || e) }); } }
  const out = { ok: results.every(x => x.ok), run_id: crypto.randomUUID(), kind: 'multi_viewport', target_url: redact(targetUrl(args.url)), created_at: new Date().toISOString(), viewport_count: profiles.length, results: results.map(x => ({ ok: x.ok, run_id: x.run_id, viewport: x.viewport, screenshot: x.screenshot, error: x.error })) };
  out.receipt_key = await receipt(env, out);
  return out;
}
async function enqueue(env, args) {
  if (!env.VISUAL_AUDIT_QUEUE) throw new Error('VISUAL_AUDIT_QUEUE binding is not configured');
  const job = { job_id: crypto.randomUUID(), type: String(args.type || 'multi_viewport'), url: redact(targetUrl(args.url)), viewports: args.viewports || ['mobile', 'desktop'], created_at: new Date().toISOString() };
  await env.VISUAL_AUDIT_QUEUE.send(job);
  return { ok: true, queued: true, ...job };
}
function status(env) {
  return { ok: true, worker: NAME, version: VERSION, mode: 'public_readonly', bindings: { BROWSER: !!env.BROWSER, AI: !!env.AI, DB: !!env.DB, RECEIPTS: !!env.RECEIPTS, VECTORIZE: !!env.VECTORIZE, VISUAL_AUDIT_QUEUE: !!env.VISUAL_AUDIT_QUEUE, ANALYTICS: !!env.ANALYTICS }, tools: ['visual_browser_status', 'capture_screenshot', 'capture_snapshot', 'capture_multi_viewport', 'enqueue_visual_audit'] };
}
const tools = [
  { name: 'visual_browser_status', description: 'Health check for all required Phase 1 bindings.', inputSchema: { type: 'object', properties: {} } },
  { name: 'capture_screenshot', description: 'Capture one public HTTPS page screenshot plus deterministic metadata.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, viewport: {}, full_page: { type: 'boolean' }, wait_until: { type: 'string' }, wait_for_selector: { type: 'string' }, delay_ms: { type: 'number' }, timeout_ms: { type: 'number' } }, required: ['url'] } },
  { name: 'capture_snapshot', description: 'Capture screenshot, HTML, headings, links, buttons, landmarks, and text evidence.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, viewport: {}, full_page: { type: 'boolean' }, wait_until: { type: 'string' }, wait_for_selector: { type: 'string' }, delay_ms: { type: 'number' }, timeout_ms: { type: 'number' } }, required: ['url'] } },
  { name: 'capture_multi_viewport', description: 'Capture a page across up to six viewports and store a batch receipt.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, viewports: { type: 'array', items: {} }, full_page: { type: 'boolean' }, wait_until: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['url'] } },
  { name: 'enqueue_visual_audit', description: 'Queue a screenshot, snapshot, or multi-viewport audit job.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, type: { type: 'string' }, viewports: { type: 'array', items: { type: 'string' } } }, required: ['url'] } }
];
async function call(env, name, args = {}) {
  if (name === 'visual_browser_status') return status(env);
  if (name === 'capture_screenshot') return capture(env, args, args.viewport);
  if (name === 'capture_snapshot') return snapshot(env, args);
  if (name === 'capture_multi_viewport') return multi(env, args);
  if (name === 'enqueue_visual_audit') return enqueue(env, args);
  throw new Error(`Unknown tool: ${name}`);
}
async function mcp(req, env) {
  const rpc = await body(req), id = rpc.id ?? null;
  if (rpc.method === 'initialize') return json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } } });
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204, headers: CORS });
  if (rpc.method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });
  if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools } });
  if (rpc.method === 'tools/call') { let result; try { result = await call(env, rpc.params?.name, rpc.params?.arguments || {}); } catch (e) { result = { ok: false, error: String(e.message || e) }; } return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.ok === false } }); }
  return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
async function consume(batch, env) {
  for (const message of batch.messages) {
    try { const job = message.body || {}; if (job.type === 'screenshot') await capture(env, job, job.viewports?.[0]); else if (job.type === 'snapshot') await snapshot(env, job); else await multi(env, job); message.ack(); }
    catch { message.retry(); }
  }
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/status' || url.pathname === '/health') return json(status(env));
    if (url.pathname === '/tools') return json({ ok: true, tools });
    if (url.pathname === '/mcp') return mcp(req, env);
    if (req.method === 'POST' && url.pathname === '/call') { const b = await body(req); try { return json(await call(env, b.name, b.arguments || {})); } catch (e) { return json({ ok: false, error: String(e.message || e) }); } }
    return json({ ok: false, error: 'not_found', worker: NAME }, 404);
  },
  queue: consume
};
