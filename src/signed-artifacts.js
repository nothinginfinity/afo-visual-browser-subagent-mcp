const encoder = new TextEncoder();

export const DEFAULT_ARTIFACT_TTL_SECONDS = 10 * 60;
export const MAX_ARTIFACT_TTL_SECONDS = 60 * 60;
export const SIGNED_ARTIFACT_TYPES = Object.freeze([
  'screenshot',
  'html',
  'markdown',
  'accessibility',
  'console',
  'network',
  'manifest',
]);

const ARTIFACT_TYPE_SET = new Set(SIGNED_ARTIFACT_TYPES);
const RUN_ID = /^(?!.*\.\.)(?![.-])[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VIEWPORT_ID = /^(?!.*\.\.)(?![.-])[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX_SIGNATURE = /^[a-f0-9]{64}$/;
const JSON_ARTIFACTS = new Set(['accessibility', 'console', 'network', 'manifest']);

function failure(error, status = 403) {
  return { ok: false, error, status };
}

export function normalizeSignedRunId(value) {
  const runId = String(value || '').trim();
  return RUN_ID.test(runId) ? runId : null;
}

export function normalizeSignedArtifactType(value) {
  const artifactType = String(value || '').trim().toLowerCase();
  return ARTIFACT_TYPE_SET.has(artifactType) ? artifactType : null;
}

export function normalizeSignedViewport(value) {
  const viewport = typeof value === 'string'
    ? value.trim()
    : String(value?.name || '').trim();
  if (!viewport) return '';
  return VIEWPORT_ID.test(viewport) ? viewport : null;
}

export function normalizeExpiry(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,12}$/.test(raw)) return null;
  const expiry = Number(raw);
  return Number.isSafeInteger(expiry) && expiry > 0 ? expiry : null;
}

export function normalizeTtlSeconds(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_ARTIFACT_TTL_SECONDS;
  }
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_ARTIFACT_TTL_SECONDS) return null;
  return ttl;
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function canonicalArtifactClaim({ runId, artifactType, viewport = '', expires }) {
  return [
    'afo-visual-artifact-v1',
    runId,
    artifactType,
    viewport,
    String(expires),
  ].join('\n');
}

async function hmacHex(secret, claim) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(claim)));
}

export async function signArtifactClaim(secret, components) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('artifact_signing_secret_missing');
  }
  return hmacHex(secret, canonicalArtifactClaim(components));
}

export async function verifyArtifactClaim(secret, components, signature, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  if (!HEX_SIGNATURE.test(String(signature || '').toLowerCase())) return false;
  if (!Number.isSafeInteger(components.expires) || nowSeconds >= components.expires) return false;
  const expected = await signArtifactClaim(secret, components);
  return constantTimeEqual(expected, String(signature).toLowerCase());
}

async function readManifestFromR2(env, runId) {
  const object = await env.RECEIPTS?.get(`runs/${runId}/manifest.json`);
  if (!object) return null;
  return JSON.parse(await object.text());
}

async function readManifestFromD1(env, runId) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    'SELECT run_id, status, viewport_name, artifact_keys_json, receipt_key FROM visual_runs WHERE run_id = ?',
  ).bind(runId).first();
  if (!row) return null;
  const artifacts = row.artifact_keys_json ? JSON.parse(row.artifact_keys_json) : {};
  if (row.receipt_key && !artifacts.manifest) artifacts.manifest = row.receipt_key;
  return {
    run_id: row.run_id,
    status: row.status,
    viewport: row.viewport_name ? { name: row.viewport_name } : null,
    artifacts,
    artifact_summary: {},
    source: 'd1',
  };
}

export async function loadSignedArtifactManifest(env, runId) {
  return await readManifestFromR2(env, runId) || await readManifestFromD1(env, runId);
}

function manifestArtifactKey(manifest, artifactType) {
  if (artifactType === 'manifest') {
    return manifest.receipt_key || manifest.artifacts?.manifest || null;
  }
  return manifest.artifacts?.[artifactType]
    || manifest.artifact_summary?.[artifactType]?.key
    || null;
}

async function selectManifest(env, rootManifest, viewport, artifactType) {
  if (rootManifest?.kind !== 'multi_viewport') {
    if (viewport && rootManifest?.viewport?.name && viewport !== rootManifest.viewport.name) {
      return failure('artifact_forbidden');
    }
    return {
      ok: true,
      manifest: rootManifest,
      resolvedRunId: rootManifest?.run_id,
      viewport: rootManifest?.viewport?.name || '',
    };
  }
  if (artifactType === 'manifest' && !viewport) {
    return { ok: true, manifest: rootManifest, resolvedRunId: rootManifest.run_id, viewport: '' };
  }
  if (!viewport) return failure('artifact_forbidden');
  const child = (rootManifest.results || []).find(result => result.viewport?.name === viewport);
  if (!child?.run_id) return failure('artifact_forbidden');
  const childManifest = await loadSignedArtifactManifest(env, child.run_id);
  if (!childManifest) return failure('artifact_forbidden');
  return { ok: true, manifest: childManifest, resolvedRunId: child.run_id, viewport };
}

export async function resolveRegisteredArtifact(env, { runId, artifactType, viewport = '' }) {
  if (!env?.RECEIPTS) return failure('artifact_service_unavailable', 503);
  const rootManifest = await loadSignedArtifactManifest(env, runId);
  if (!rootManifest) return failure('artifact_forbidden');
  const selection = await selectManifest(env, rootManifest, viewport, artifactType);
  if (!selection.ok) return selection;
  const summary = selection.manifest.artifact_summary?.[artifactType];
  const key = manifestArtifactKey(selection.manifest, artifactType);
  if (!key || ['failed', 'skipped_oversize', 'not_requested'].includes(summary?.status)) {
    return failure('artifact_forbidden');
  }
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) {
    return failure('artifact_forbidden');
  }
  return {
    ok: true,
    key,
    manifest: selection.manifest,
    resolvedRunId: selection.resolvedRunId,
    viewport: selection.viewport,
  };
}

function contentTypeFor(manifest, artifactType, object) {
  return manifest.artifact_summary?.[artifactType]?.content_type
    || object?.httpMetadata?.contentType
    || object?.httpMetadata?.content_type
    || (artifactType === 'screenshot'
      ? 'image/png'
      : JSON_ARTIFACTS.has(artifactType)
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8');
}

function safeFilename(artifactType) {
  const extension = artifactType === 'screenshot'
    ? 'png'
    : artifactType === 'html'
      ? 'html'
      : artifactType === 'markdown'
        ? 'md'
        : artifactType === 'manifest' || JSON_ARTIFACTS.has(artifactType)
          ? 'json'
          : 'txt';
  return `visual-artifact-${artifactType}.${extension}`;
}

export async function createVisualArtifactUrl(env, args = {}, options = {}) {
  if (args.object_key || args.key || args.r2_key) return failure('unregistered_object_key_input', 400);
  const runId = normalizeSignedRunId(args.investigation_id || args.run_id);
  const artifactType = normalizeSignedArtifactType(args.artifact_type);
  const viewport = normalizeSignedViewport(args.viewport);
  const ttlSeconds = normalizeTtlSeconds(args.ttl_seconds);
  if (!runId) return failure('invalid_investigation_id', 400);
  if (!artifactType) return failure('invalid_artifact_type', 400);
  if (viewport === null) return failure('invalid_viewport', 400);
  if (ttlSeconds === null) return failure('invalid_ttl_seconds', 400);
  if (typeof env?.ARTIFACT_SIGNING_SECRET !== 'string' || env.ARTIFACT_SIGNING_SECRET.length < 32) {
    return failure('artifact_signing_unavailable', 503);
  }

  const resolved = await resolveRegisteredArtifact(env, { runId, artifactType, viewport });
  if (!resolved.ok) return resolved;

  const nowSeconds = Number.isSafeInteger(options.nowSeconds)
    ? options.nowSeconds
    : Math.floor(Date.now() / 1000);
  const expires = nowSeconds + ttlSeconds;
  const signature = await signArtifactClaim(env.ARTIFACT_SIGNING_SECRET, {
    runId,
    artifactType,
    viewport,
    expires,
  });
  const origin = String(options.origin || args.origin || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/?#]+$/i.test(origin)) return failure('invalid_worker_origin', 500);
  const url = new URL(`${origin}/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(artifactType)}`);
  if (viewport) url.searchParams.set('viewport', viewport);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('signature', signature);

  return {
    ok: true,
    run_id: runId,
    artifact_type: artifactType,
    viewport: viewport || null,
    url: url.toString(),
    expires_at: new Date(expires * 1000).toISOString(),
    expires_unix: expires,
    ttl_seconds: ttlSeconds,
  };
}

function forbiddenResponse() {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function handleSignedArtifactRequest(request, env, options = {}) {
  if (request.method !== 'GET') return forbiddenResponse();
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/artifacts\/([^/]+)\/([^/]+)$/);
  if (!match) return forbiddenResponse();

  let rawRunId;
  let rawArtifactType;
  try {
    rawRunId = decodeURIComponent(match[1]);
    rawArtifactType = decodeURIComponent(match[2]);
  } catch {
    return forbiddenResponse();
  }
  const runId = normalizeSignedRunId(rawRunId);
  const artifactType = normalizeSignedArtifactType(rawArtifactType);
  const viewport = normalizeSignedViewport(url.searchParams.get('viewport') || '');
  const expires = normalizeExpiry(url.searchParams.get('expires'));
  const signature = String(url.searchParams.get('signature') || '').toLowerCase();
  if (!runId || !artifactType || viewport === null || !expires) return forbiddenResponse();
  if ([...url.searchParams.keys()].some(key => !['viewport', 'expires', 'signature'].includes(key))) {
    return forbiddenResponse();
  }

  const nowSeconds = Number.isSafeInteger(options.nowSeconds)
    ? options.nowSeconds
    : Math.floor(Date.now() / 1000);
  const valid = await verifyArtifactClaim(
    env?.ARTIFACT_SIGNING_SECRET,
    { runId, artifactType, viewport, expires },
    signature,
    nowSeconds,
  );
  if (!valid) return forbiddenResponse();

  const resolved = await resolveRegisteredArtifact(env, { runId, artifactType, viewport });
  if (!resolved.ok) return forbiddenResponse();
  const object = await env.RECEIPTS.get(resolved.key);
  if (!object) return forbiddenResponse();

  const contentType = contentTypeFor(resolved.manifest, artifactType, object);
  const body = object.body ?? await object.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="${safeFilename(artifactType)}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
