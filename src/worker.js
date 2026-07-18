import puppeteer from '@cloudflare/puppeteer';
import {
  deriveArtifactOutcome,
  failedArtifact,
  notRequestedArtifact,
  storeBinaryArtifact,
  storeJsonArtifact,
  storeTextArtifact,
  truncateUtf8,
} from './artifacts.js';
import {
  captureEvidenceForMode,
  capturePng,
  collectPageEvidence,
} from './capture.js';

const VERSION = '0.2.1-capture-reliability';
const NAME = 'afo-visual-browser-subagent-mcp';
const LIMITS = {
  screenshot: 10 * 1024 * 1024,
  artifact: 2 * 1024 * 1024,
  text: 100000,
  logs: 500,
  redirects: 8,
};
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
};
const VIEWPORTS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 1000, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
const SECRET_QUERY = /token|key|secret|auth|password|signature|credential|session|jwt|code/i;
const RETRYABLE = /timeout|timed out|temporar|network|connection|browser.*launch|internal|429|502|503|504/i;
const OPTIONAL_CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  accessibility: 'application/json; charset=utf-8',
  console: 'application/json; charset=utf-8',
  network: 'application/json; charset=utf-8',
  embeddings: 'application/x-vectorize-records',
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json;charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function body(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function clamp(value, low, high, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
}

function truncate(value, maxBytes) {
  return truncateUtf8(value, maxBytes).text;
}

function safeError(error) {
  return truncate(error?.message || error || 'unknown_error', 2000);
}

function deterministicId(value) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `vb_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function targetUrl(raw) {
  const url = new URL(String(raw || '').trim());
  if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed in public_readonly mode');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Localhost targets are blocked');
  }
  if (/^(0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('Private IPv4 targets are blocked');
  }
  if (/^(::|::1|fc|fd|fe80:)/i.test(host)) throw new Error('Private IPv6 targets are blocked');
  url.username = '';
  url.password = '';
  return url;
}

function redact(urlLike) {
  const copy = new URL(urlLike.toString());
  copy.username = '';
  copy.password = '';
  for (const key of [...copy.searchParams.keys()]) {
    if (SECRET_QUERY.test(key)) copy.searchParams.set(key, '[REDACTED]');
  }
  copy.hash = '';
  return copy.toString();
}

function redactEvidenceUrl(raw) {
  try {
    return redact(targetUrl(raw));
  } catch {
    return '[BLOCKED_OR_INVALID_URL]';
  }
}

function viewport(input) {
  if (typeof input === 'string' && VIEWPORTS[input]) return { name: input, ...VIEWPORTS[input] };
  if (input && typeof input === 'object') {
    return {
      name: String(input.name || 'custom'),
      width: clamp(input.width, 240, 2560, 1440),
      height: clamp(input.height, 240, 2560, 1000),
      deviceScaleFactor: clamp(input.deviceScaleFactor, 1, 3, 1),
      isMobile: input.isMobile === true,
      hasTouch: input.hasTouch === true,
    };
  }
  return { name: 'desktop', ...VIEWPORTS.desktop };
}

function runId(args, vp, supplied) {
  return truncate(
    supplied || deterministicId(
      `${args.idempotency_key || crypto.randomUUID()}|${redact(targetUrl(args.url))}|${vp.name}|${vp.width}x${vp.height}`,
    ),
    128,
  );
}

function captureMode(options) {
  if (['screenshot', 'snapshot', 'multi_viewport'].includes(options.capture_mode)) return options.capture_mode;
  if (options.kind === 'screenshot') return 'screenshot';
  if (options.kind === 'multi_viewport_item') return 'multi_viewport';
  return 'snapshot';
}

function analytics(env, event) {
  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: [event.tool, event.hostname, event.viewport, event.mode, event.status, event.classification],
      doubles: [
        event.total,
        event.navigation,
        event.screenshot,
        event.evidence,
        event.consoleErrors,
        event.failedRequests,
        event.failedResponses,
      ],
      indexes: [event.runId],
    });
    return true;
  } catch {
    return false;
  }
}

async function upsert(env, manifest) {
  if (!env.DB) return;
  await env.DB.prepare(`INSERT INTO visual_runs (run_id,kind,target_url,redacted_url,final_url,hostname,created_at,completed_at,status,viewport_name,viewport_width,viewport_height,artifact_keys_json,receipt_key,console_error_count,failed_request_count,failed_response_count,navigation_duration_ms,render_duration_ms,screenshot_duration_ms,duration_ms,queue_status,vector_status,error_class,error_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET completed_at=excluded.completed_at,status=excluded.status,artifact_keys_json=excluded.artifact_keys_json,receipt_key=excluded.receipt_key,console_error_count=excluded.console_error_count,failed_request_count=excluded.failed_request_count,failed_response_count=excluded.failed_response_count,navigation_duration_ms=excluded.navigation_duration_ms,render_duration_ms=excluded.render_duration_ms,screenshot_duration_ms=excluded.screenshot_duration_ms,duration_ms=excluded.duration_ms,queue_status=excluded.queue_status,vector_status=excluded.vector_status,error_class=excluded.error_class,error_message=excluded.error_message`)
    .bind(
      manifest.run_id,
      manifest.kind,
      manifest.target_url,
      manifest.target_url,
      manifest.final_url || null,
      manifest.hostname || null,
      manifest.created_at,
      manifest.completed_at || null,
      manifest.status,
      manifest.viewport?.name || null,
      manifest.viewport?.width || null,
      manifest.viewport?.height || null,
      JSON.stringify(manifest.artifacts || {}),
      manifest.receipt_key || null,
      manifest.counts?.console_errors || 0,
      manifest.counts?.failed_requests || 0,
      manifest.counts?.failed_responses || 0,
      manifest.timings?.navigation_ms || 0,
      manifest.timings?.render_ms || 0,
      manifest.timings?.screenshot_ms || 0,
      manifest.duration_ms || 0,
      manifest.queue_status || 'synchronous',
      manifest.vector_status || 'not_started',
      manifest.error_class || null,
      manifest.error || null,
    )
    .run();
}

function recordArtifact(manifest, name, result) {
  manifest.artifact_summary[name] = result;
  if (result?.key) manifest.artifacts[name] = result.key;
}

function addWarning(manifest, warning) {
  const normalized = {
    artifact: warning.artifact || null,
    stage: warning.stage || null,
    status: warning.status || 'failed',
    error: warning.error ? safeError(warning.error) : null,
  };
  const key = JSON.stringify(normalized);
  if (!manifest.warnings.some(item => JSON.stringify(item) === key)) manifest.warnings.push(normalized);
}

function refreshOutcome(manifest) {
  const artifactOutcome = deriveArtifactOutcome(manifest.artifact_summary);
  for (const warning of artifactOutcome.warnings) addWarning(manifest, warning);
  manifest.ok = artifactOutcome.ok;
  manifest.status = artifactOutcome.ok
    ? manifest.warnings.length ? 'ok_with_warnings' : 'ok'
    : 'error';
  return manifest;
}

async function persist(env, manifest) {
  const key = `runs/${manifest.run_id}/manifest.json`;
  manifest.receipt_key = key;
  recordArtifact(manifest, 'manifest', {
    status: 'stored',
    key,
    content_type: 'application/json; charset=utf-8',
    required: true,
  });
  refreshOutcome(manifest);
  await storeJsonArtifact(env, {
    key,
    value: manifest,
    limit: LIMITS.artifact,
    required: true,
    allowTruncate: false,
  });
  await upsert(env, manifest);
  return key;
}

function sanitizeEvidence(evidence) {
  return {
    console: evidence.console,
    page_errors: evidence.page_errors,
    failed_requests: evidence.failed_requests.map(item => ({
      ...item,
      url: redactEvidenceUrl(item.url),
    })),
    failed_responses: evidence.failed_responses.map(item => ({
      ...item,
      url: redactEvidenceUrl(item.url),
    })),
    redirects: evidence.redirects,
  };
}

async function openPage(env, args, vp, mode) {
  if (!env.BROWSER) throw new Error('BROWSER binding is not configured');
  const initial = targetUrl(args.url);
  const timeout = clamp(args.timeout_ms, 5000, 60000, 30000);
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    const evidence = collectPageEvidence(page, {
      detailed: mode !== 'screenshot',
      logLimit: LIMITS.logs,
    });
    await page.setViewport(vp);
    page.setDefaultNavigationTimeout(timeout);
    page.setDefaultTimeout(timeout);

    const started = Date.now();
    const response = await page.goto(initial.toString(), {
      waitUntil: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'].includes(args.wait_until)
        ? args.wait_until
        : 'networkidle2',
      timeout,
    });
    const navigationMs = Date.now() - started;
    const chain = response?.request()?.redirectChain?.() || [];
    if (chain.length > LIMITS.redirects) throw new Error(`Redirect limit exceeded (${LIMITS.redirects})`);
    for (const request of chain) evidence.redirects.push(redact(targetUrl(request.url())));

    const finalUrl = targetUrl(page.url());
    if (args.wait_for_selector) {
      await page.waitForSelector(truncate(args.wait_for_selector, 500), { timeout });
    }
    const delay = clamp(args.delay_ms, 0, 10000, 0);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));

    return {
      browser,
      page,
      evidence,
      response,
      finalUrl,
      navigationMs,
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

function markdown(dom) {
  if (!dom) return '';
  const lines = dom.title ? [`# ${dom.title}`] : [];
  for (const heading of dom.headings || []) {
    lines.push(`${'#'.repeat(Number(heading.level.slice(1)) || 2)} ${heading.text}`);
  }
  if (dom.text) lines.push(dom.text);
  return lines.join('\n\n');
}

async function index(env, manifest, docs) {
  if (!env.VECTORIZE) return 'binding_missing';
  if (!env.AI) return 'ai_binding_missing';
  const records = [];

  for (const doc of docs) {
    const text = truncate(doc.text, 12000).trim();
    if (!text) continue;
    const response = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
    const vector = response?.data?.[0];
    if (!Array.isArray(vector)) throw new Error('Workers AI embedding response did not contain a vector');
    records.push({
      id: `${manifest.run_id}:${doc.type}`,
      values: vector,
      metadata: {
        investigation_id: manifest.run_id,
        evidence_type: doc.type,
        url: manifest.target_url,
        hostname: manifest.hostname,
        viewport: manifest.viewport?.name || 'none',
        captured_at: manifest.created_at,
        artifact_key: doc.key || manifest.receipt_key || '',
      },
    });
  }

  if (records.length) await env.VECTORIZE.upsert(records);
  return records.length ? `indexed:${records.length}` : 'no_text';
}

function extractionErrorMap(capture) {
  return new Map((capture.errors || []).map(result => [result.name, result.error]));
}

async function persistOptionalArtifacts(env, manifest, base, capture, evidence) {
  const errors = extractionErrorMap(capture);
  let md = null;

  const attempt = async (name, contentType, task) => {
    try {
      recordArtifact(manifest, name, await task());
    } catch (error) {
      recordArtifact(manifest, name, failedArtifact(contentType, error));
      addWarning(manifest, {
        artifact: name,
        status: 'failed',
        error,
      });
    }
  };

  if (capture.html === null) {
    recordArtifact(manifest, 'html', failedArtifact(OPTIONAL_CONTENT_TYPES.html, errors.get('html') || 'HTML extraction unavailable'));
  } else {
    await attempt('html', OPTIONAL_CONTENT_TYPES.html, () => storeTextArtifact(env, {
      key: `${base}/page.html`,
      value: capture.html,
      contentType: OPTIONAL_CONTENT_TYPES.html,
      limit: LIMITS.artifact,
    }));
  }

  if (capture.dom === null) {
    recordArtifact(manifest, 'markdown', failedArtifact(OPTIONAL_CONTENT_TYPES.markdown, errors.get('dom') || 'DOM extraction unavailable'));
  } else {
    try {
      md = markdown(capture.dom);
      await attempt('markdown', OPTIONAL_CONTENT_TYPES.markdown, () => storeTextArtifact(env, {
        key: `${base}/page.md`,
        value: md,
        contentType: OPTIONAL_CONTENT_TYPES.markdown,
        limit: LIMITS.artifact,
      }));
    } catch (error) {
      md = null;
      recordArtifact(manifest, 'markdown', failedArtifact(OPTIONAL_CONTENT_TYPES.markdown, error));
      addWarning(manifest, {
        artifact: 'markdown',
        status: 'failed',
        error,
      });
    }
  }

  if (capture.accessibility === null) {
    recordArtifact(manifest, 'accessibility', failedArtifact(OPTIONAL_CONTENT_TYPES.accessibility, errors.get('accessibility') || 'Accessibility extraction unavailable'));
  } else {
    await attempt('accessibility', OPTIONAL_CONTENT_TYPES.accessibility, () => storeJsonArtifact(env, {
      key: `${base}/accessibility.json`,
      value: capture.accessibility,
      contentType: OPTIONAL_CONTENT_TYPES.accessibility,
      limit: LIMITS.artifact,
    }));
  }

  await attempt('console', OPTIONAL_CONTENT_TYPES.console, () => storeJsonArtifact(env, {
    key: `${base}/console.json`,
    value: {
      console: evidence.console,
      page_errors: evidence.page_errors,
    },
    contentType: OPTIONAL_CONTENT_TYPES.console,
    limit: LIMITS.artifact,
  }));

  await attempt('network', OPTIONAL_CONTENT_TYPES.network, () => storeJsonArtifact(env, {
    key: `${base}/network.json`,
    value: {
      failed_requests: evidence.failed_requests,
      failed_responses: evidence.failed_responses,
      redirects: evidence.redirects,
    },
    contentType: OPTIONAL_CONTENT_TYPES.network,
    limit: LIMITS.artifact,
  }));

  return md;
}

function markScreenshotOnlyArtifacts(manifest) {
  for (const [name, contentType] of Object.entries(OPTIONAL_CONTENT_TYPES)) {
    recordArtifact(manifest, name, notRequestedArtifact(contentType));
  }
}

function countFields(evidence, capture) {
  return {
    console_entries: evidence.counts.console_entries,
    console_errors: evidence.counts.console_errors,
    page_errors: evidence.counts.page_errors,
    failed_requests: evidence.counts.failed_requests,
    failed_responses: evidence.counts.failed_responses,
    headings: capture.dom?.headings?.length || 0,
    links: capture.dom?.links?.length || 0,
    controls: capture.dom?.controls?.length || 0,
  };
}

async function pipeline(env, args, profile, options = {}) {
  const vp = viewport(profile ?? args.viewport);
  const id = runId(args, vp, options.run_id);
  const created = new Date().toISOString();
  const started = Date.now();
  const mode = captureMode(options);
  let browser;
  let manifest = {
    ok: false,
    run_id: id,
    kind: options.kind || 'snapshot',
    capture_mode: mode,
    target_url: redact(targetUrl(args.url)),
    created_at: created,
    status: 'running',
    viewport: vp,
    queue_status: options.queued ? 'processing' : 'synchronous',
    vector_status: mode === 'screenshot' ? 'not_requested' : 'not_started',
    artifacts: {},
    artifact_summary: {},
    warnings: [],
    counts: {},
    timings: {},
  };

  try {
    await upsert(env, manifest);
    const state = await openPage(env, args, vp, mode);
    browser = state.browser;

    const screenshot = await capturePng(state.page, { fullPage: args.full_page !== false });
    const base = `runs/${id}`;
    let screenshotResult;
    try {
      screenshotResult = await storeBinaryArtifact(env, {
        key: `${base}/${vp.name}.png`,
        value: screenshot.bytes,
        contentType: 'image/png',
        limit: LIMITS.screenshot,
        required: true,
      });
      recordArtifact(manifest, 'screenshot', { ...screenshotResult, required: true });
    } catch (error) {
      if (error.artifact_result) recordArtifact(manifest, 'screenshot', { ...error.artifact_result, required: true });
      throw error;
    }

    const capture = await captureEvidenceForMode(state.page, {
      mode,
      textLimit: LIMITS.text,
    });
    const evidence = sanitizeEvidence(state.evidence);
    for (const extractionError of capture.errors || []) {
      addWarning(manifest, {
        stage: extractionError.name,
        status: 'failed',
        error: extractionError.error,
      });
    }

    let md = null;
    if (mode === 'screenshot') {
      markScreenshotOnlyArtifacts(manifest);
    } else {
      md = await persistOptionalArtifacts(env, manifest, base, capture, evidence);
      recordArtifact(manifest, 'embeddings', notRequestedArtifact(OPTIONAL_CONTENT_TYPES.embeddings));
    }

    manifest = {
      ...manifest,
      completed_at: new Date().toISOString(),
      final_url: redact(state.finalUrl),
      hostname: state.finalUrl.hostname,
      http_status: state.response?.status() || null,
      title: capture.metadata?.title || capture.dom?.title || null,
      screenshot: {
        bytes: screenshot.bytes.byteLength,
        width: vp.width,
        height: vp.height,
        full_page: args.full_page !== false,
      },
      page: capture.metadata ? {
        title: capture.metadata.title,
        lang: capture.metadata.lang,
        ready_state: capture.metadata.ready_state,
        dimensions: capture.metadata.dimensions,
      } : null,
      navigation: {
        redirect_count: state.evidence.redirects.length,
        redirects: state.evidence.redirects,
        performance: capture.performance,
      },
      counts: countFields(state.evidence, capture),
      timings: {
        navigation_ms: state.navigationMs,
        render_ms: capture.duration_ms,
        screenshot_ms: screenshot.duration_ms,
      },
      duration_ms: Date.now() - started,
    };

    recordArtifact(manifest, 'manifest', {
      status: 'stored',
      key: `${base}/manifest.json`,
      content_type: 'application/json; charset=utf-8',
      required: true,
    });
    refreshOutcome(manifest);
    await persist(env, manifest);

    if (mode !== 'screenshot') {
      try {
        manifest.vector_status = await index(env, manifest, [
          { type: 'page_markdown', text: md || '', key: manifest.artifacts.markdown },
          { type: 'accessibility', text: JSON.stringify(capture.accessibility || {}), key: manifest.artifacts.accessibility },
          {
            type: 'console_errors',
            text: JSON.stringify(evidence.console.filter(item => item.type === 'error').concat(evidence.page_errors)),
            key: manifest.artifacts.console,
          },
          {
            type: 'network_errors',
            text: JSON.stringify(evidence.failed_requests.concat(evidence.failed_responses)),
            key: manifest.artifacts.network,
          },
          {
            type: 'manifest_summary',
            text: JSON.stringify({ title: manifest.title, hostname: manifest.hostname, counts: manifest.counts, timings: manifest.timings }),
            key: manifest.receipt_key,
          },
        ]);
        if (['binding_missing', 'ai_binding_missing'].includes(manifest.vector_status)) {
          recordArtifact(manifest, 'embeddings', failedArtifact(OPTIONAL_CONTENT_TYPES.embeddings, manifest.vector_status));
          addWarning(manifest, {
            artifact: 'embeddings',
            status: 'failed',
            error: manifest.vector_status,
          });
        } else {
          recordArtifact(manifest, 'embeddings', {
            status: 'stored',
            key: null,
            content_type: OPTIONAL_CONTENT_TYPES.embeddings,
            vector_status: manifest.vector_status,
          });
        }
      } catch (error) {
        manifest.vector_status = `error:${safeError(error)}`;
        recordArtifact(manifest, 'embeddings', failedArtifact(OPTIONAL_CONTENT_TYPES.embeddings, error));
        addWarning(manifest, {
          artifact: 'embeddings',
          status: 'failed',
          error,
        });
      }
    }

    if (options.queued) manifest.queue_status = 'completed';
    manifest.duration_ms = Date.now() - started;
    refreshOutcome(manifest);
    await persist(env, manifest);

    analytics(env, {
      tool: options.tool || 'capture_snapshot',
      hostname: manifest.hostname,
      viewport: vp.name,
      mode: options.queued ? 'queued' : 'synchronous',
      status: manifest.status,
      classification: manifest.status === 'ok' ? 'success' : 'success_with_warnings',
      runId: id,
      total: manifest.duration_ms,
      navigation: manifest.timings.navigation_ms,
      screenshot: manifest.timings.screenshot_ms,
      evidence: Object.keys(manifest.artifacts).length,
      consoleErrors: manifest.counts.console_errors,
      failedRequests: manifest.counts.failed_requests,
      failedResponses: manifest.counts.failed_responses,
    });
    return manifest;
  } catch (error) {
    manifest = {
      ...manifest,
      ok: false,
      status: 'error',
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      queue_status: options.queued ? 'failed' : 'synchronous',
      error_class: RETRYABLE.test(safeError(error)) ? 'retryable' : 'permanent',
      error: safeError(error),
    };
    try {
      await persist(env, manifest);
    } catch {
      try {
        await upsert(env, manifest);
      } catch {
        // Best-effort failure receipt only.
      }
    }
    analytics(env, {
      tool: options.tool || 'capture_snapshot',
      hostname: new URL(manifest.target_url).hostname,
      viewport: vp.name,
      mode: options.queued ? 'queued' : 'synchronous',
      status: 'error',
      classification: manifest.error_class,
      runId: id,
      total: manifest.duration_ms,
      navigation: manifest.timings.navigation_ms || 0,
      screenshot: manifest.timings.screenshot_ms || 0,
      evidence: Object.keys(manifest.artifacts).length,
      consoleErrors: manifest.counts.console_errors || 0,
      failedRequests: manifest.counts.failed_requests || 0,
      failedResponses: manifest.counts.failed_responses || 0,
    });
    const wrapped = new Error(manifest.error);
    wrapped.retryable = manifest.error_class === 'retryable';
    wrapped.manifest = manifest;
    throw wrapped;
  } finally {
    await browser?.close();
  }
}

async function multi(env, args, options = {}) {
  const profiles = (
    Array.isArray(args.viewports) && args.viewports.length ? args.viewports : ['mobile', 'desktop']
  ).slice(0, 6);
  const batchId = options.run_id || deterministicId(
    `${args.idempotency_key || crypto.randomUUID()}|multi|${redact(targetUrl(args.url))}`,
  );
  const results = [];

  for (let index = 0; index < profiles.length; index += 1) {
    try {
      results.push(await pipeline(env, args, profiles[index], {
        kind: 'multi_viewport_item',
        capture_mode: 'multi_viewport',
        tool: 'capture_multi_viewport',
        queued: options.queued,
        run_id: `${batchId}_${index}`,
      }));
    } catch (error) {
      results.push(error.manifest || {
        ok: false,
        viewport: viewport(profiles[index]),
        error: safeError(error),
      });
    }
  }

  const allOk = results.every(result => result.ok);
  const hasWarnings = results.some(result => result.status === 'ok_with_warnings');
  const manifest = {
    ok: allOk,
    run_id: batchId,
    kind: 'multi_viewport',
    capture_mode: 'multi_viewport',
    target_url: redact(targetUrl(args.url)),
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    status: allOk ? hasWarnings ? 'ok_with_warnings' : 'ok' : 'partial',
    viewport_count: profiles.length,
    queue_status: options.queued ? 'completed' : 'synchronous',
    vector_status: 'child_records',
    artifacts: {},
    artifact_summary: {},
    warnings: results.flatMap(result => result.warnings || []),
    results: results.map(result => ({
      ok: result.ok,
      status: result.status,
      run_id: result.run_id,
      viewport: result.viewport,
      receipt_key: result.receipt_key,
      artifacts: result.artifacts,
      artifact_summary: result.artifact_summary,
      error: result.error,
    })),
    duration_ms: results.reduce((sum, result) => sum + (result.duration_ms || 0), 0),
  };
  await persist(env, manifest);
  return manifest;
}

async function enqueue(env, args) {
  if (!env.AUDIT_QUEUE) throw new Error('AUDIT_QUEUE binding is not configured');
  const type = ['screenshot', 'snapshot', 'multi_viewport'].includes(args.type)
    ? args.type
    : 'multi_viewport';
  const vp = viewport(args.viewports?.[0] || args.viewport);
  const id = runId(args, vp, args.investigation_id);
  const job = {
    job_id: id,
    investigation_id: id,
    type,
    url: redact(targetUrl(args.url)),
    viewports: args.viewports || ['mobile', 'desktop'],
    viewport: args.viewport,
    full_page: args.full_page !== false,
    wait_until: args.wait_until,
    wait_for_selector: args.wait_for_selector,
    delay_ms: clamp(args.delay_ms, 0, 10000, 0),
    timeout_ms: clamp(args.timeout_ms, 5000, 60000, 30000),
    attempts: 0,
    created_at: new Date().toISOString(),
  };
  await env.AUDIT_QUEUE.send(job);
  if (env.DB) {
    await env.DB.prepare('INSERT INTO audit_jobs (job_id,investigation_id,type,target_url,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING')
      .bind(id, id, type, job.url, 'queued', 0, job.created_at, job.created_at)
      .run();
  }
  return { ok: true, queued: true, ...job };
}

async function getReceipt(env, args) {
  const id = truncate(args.investigation_id || args.run_id, 128);
  if (!id) throw new Error('investigation_id is required');
  const object = await env.RECEIPTS?.get(`runs/${id}/manifest.json`);
  if (object) return JSON.parse(await object.text());
  if (env.DB) {
    const row = await env.DB.prepare('SELECT * FROM visual_runs WHERE run_id = ?').bind(id).first();
    if (row) {
      return {
        ok: ['ok', 'ok_with_warnings'].includes(row.status),
        source: 'd1',
        ...row,
        artifact_keys: row.artifact_keys_json ? JSON.parse(row.artifact_keys_json) : {},
      };
    }
  }
  return { ok: false, error: 'receipt_not_found', investigation_id: id };
}

function status(env) {
  return {
    ok: true,
    worker: NAME,
    version: VERSION,
    mode: 'public_readonly',
    limits: LIMITS,
    bindings: {
      BROWSER: !!env.BROWSER,
      AI: !!env.AI,
      DB: !!env.DB,
      RECEIPTS: !!env.RECEIPTS,
      VECTORIZE: !!env.VECTORIZE,
      AUDIT_QUEUE: !!env.AUDIT_QUEUE,
      ANALYTICS: !!env.ANALYTICS,
    },
    tools: [
      'visual_browser_status',
      'capture_screenshot',
      'capture_snapshot',
      'capture_multi_viewport',
      'enqueue_visual_audit',
      'get_visual_receipt',
    ],
  };
}

const captureInputProperties = {
  url: { type: 'string' },
  viewport: {},
  full_page: { type: 'boolean' },
  wait_until: { type: 'string' },
  wait_for_selector: { type: 'string' },
  delay_ms: { type: 'number' },
  timeout_ms: { type: 'number' },
  idempotency_key: { type: 'string' },
};

const tools = [
  {
    name: 'visual_browser_status',
    description: 'Health check for all required Phase 1 bindings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'capture_screenshot',
    description: 'Capture and persist only a PNG, minimal page metadata, cheap counts, and a deterministic manifest.',
    inputSchema: { type: 'object', properties: captureInputProperties, required: ['url'] },
  },
  {
    name: 'capture_snapshot',
    description: 'Capture screenshot, HTML, Markdown, accessibility, console, network, timing, and DOM evidence.',
    inputSchema: { type: 'object', properties: captureInputProperties, required: ['url'] },
  },
  {
    name: 'capture_multi_viewport',
    description: 'Run deterministic evidence across up to six viewports.',
    inputSchema: {
      type: 'object',
      properties: {
        ...captureInputProperties,
        viewports: { type: 'array', items: {} },
      },
      required: ['url'],
    },
  },
  {
    name: 'enqueue_visual_audit',
    description: 'Queue an idempotent visual audit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...captureInputProperties,
        type: { type: 'string' },
        viewports: { type: 'array', items: {} },
        investigation_id: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_visual_receipt',
    description: 'Read a persisted investigation manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        investigation_id: { type: 'string' },
        run_id: { type: 'string' },
      },
    },
  },
];

async function call(env, name, args = {}) {
  if (name === 'visual_browser_status') return status(env);
  if (name === 'capture_screenshot') {
    return pipeline(env, args, args.viewport, {
      kind: 'screenshot',
      capture_mode: 'screenshot',
      tool: 'capture_screenshot',
    });
  }
  if (name === 'capture_snapshot') {
    return pipeline(env, args, args.viewport, {
      kind: 'snapshot',
      capture_mode: 'snapshot',
      tool: 'capture_snapshot',
    });
  }
  if (name === 'capture_multi_viewport') return multi(env, args);
  if (name === 'enqueue_visual_audit') return enqueue(env, args);
  if (name === 'get_visual_receipt') return getReceipt(env, args);
  throw new Error(`Unknown tool: ${name}`);
}

async function mcp(req, env) {
  const rpc = await body(req);
  const id = rpc.id ?? null;
  if (rpc.method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      },
    });
  }
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204, headers: CORS });
  if (rpc.method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });
  if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools } });
  if (rpc.method === 'tools/call') {
    let result;
    try {
      result = await call(env, rpc.params?.name, rpc.params?.arguments || {});
    } catch (error) {
      result = error.manifest || { ok: false, error: safeError(error) };
    }
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result.ok === false,
      },
    });
  }
  return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

async function consume(batch, env) {
  for (const message of batch.messages) {
    const job = message.body || {};
    try {
      if (env.DB) {
        await env.DB.prepare('UPDATE audit_jobs SET status = ?, attempts = attempts + 1, updated_at = ? WHERE job_id = ?')
          .bind('processing', new Date().toISOString(), job.job_id)
          .run();
      }
      if (job.type === 'screenshot') {
        await pipeline(env, job, job.viewport || job.viewports?.[0], {
          kind: 'screenshot',
          capture_mode: 'screenshot',
          tool: 'capture_screenshot',
          queued: true,
          run_id: job.investigation_id,
        });
      } else if (job.type === 'snapshot') {
        await pipeline(env, job, job.viewport, {
          kind: 'snapshot',
          capture_mode: 'snapshot',
          tool: 'capture_snapshot',
          queued: true,
          run_id: job.investigation_id,
        });
      } else {
        await multi(env, job, { queued: true, run_id: job.investigation_id });
      }
      if (env.DB) {
        await env.DB.prepare('UPDATE audit_jobs SET status = ?, updated_at = ? WHERE job_id = ?')
          .bind('completed', new Date().toISOString(), job.job_id)
          .run();
      }
      message.ack();
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const retryable = error.retryable === true && attempts < 3;
      if (env.DB) {
        await env.DB.prepare('UPDATE audit_jobs SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE job_id = ?')
          .bind(
            retryable ? 'retrying' : 'failed',
            attempts,
            safeError(error),
            new Date().toISOString(),
            job.job_id,
          )
          .run();
      }
      if (retryable) message.retry({ delaySeconds: Math.min(300, 30 * attempts) });
      else message.ack();
    }
  }
}

export { deterministicId, redact, targetUrl, viewport };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/status' || url.pathname === '/health') return json(status(env));
    if (url.pathname === '/tools') return json({ ok: true, tools });
    if (url.pathname === '/mcp') return mcp(req, env);
    if (req.method === 'POST' && url.pathname === '/call') {
      const requestBody = await body(req);
      try {
        return json(await call(env, requestBody.name, requestBody.arguments || {}));
      } catch (error) {
        return json(error.manifest || { ok: false, error: safeError(error) }, 400);
      }
    }
    return json({ ok: false, error: 'not_found', worker: NAME }, 404);
  },
  queue: consume,
};
