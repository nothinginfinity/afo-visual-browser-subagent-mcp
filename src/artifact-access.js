import { sha256Hex } from './artifacts.js';

const decoder = new TextDecoder('utf-8');

export const ARTIFACT_TYPES = Object.freeze([
  'screenshot',
  'html',
  'markdown',
  'accessibility',
  'console',
  'network',
  'manifest',
]);

export const RESPONSE_MODES = Object.freeze(['auto', 'inline', 'metadata']);

export const INLINE_LIMITS = Object.freeze({
  binary: 512 * 1024,
  text: 128 * 1024,
});

const ARTIFACT_TYPE_SET = new Set(ARTIFACT_TYPES);
const RESPONSE_MODE_SET = new Set(RESPONSE_MODES);
const JSON_ARTIFACTS = new Set(['accessibility', 'console', 'network', 'manifest']);
const SECRET_QUERY = /token|key|secret|auth|password|signature|credential|session|jwt|code/i;
const RUN_ID = /^(?!.*\.\.)(?![.-])[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL_PATTERN = /https:\/\/[^\s<>"']+/gi;

function resultError(error, extras = {}) {
  return { ok: false, error, ...extras };
}

export function normalizeRunId(value) {
  const id = String(value || '').trim();
  if (!RUN_ID.test(id)) return null;
  return id;
}

export function normalizeArtifactType(value) {
  const artifactType = String(value || '').trim().toLowerCase();
  return ARTIFACT_TYPE_SET.has(artifactType) ? artifactType : null;
}

export function normalizeResponseMode(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  return RESPONSE_MODE_SET.has(mode) ? mode : null;
}

function viewportName(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.name || '').trim();
  return '';
}

function stripTrailingUrlPunctuation(value) {
  const match = value.match(/^(.*?)([),.;!?]*)$/);
  return { url: match?.[1] || value, suffix: match?.[2] || '' };
}

export function redactSensitiveUrl(value) {
  const { url: raw, suffix } = stripTrailingUrlPunctuation(String(value || ''));
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return value;
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    parsed.hash = '';
    return `${parsed.toString()}${suffix}`;
  } catch {
    return value;
  }
}

export function redactSensitiveText(value) {
  return String(value ?? '').replace(URL_PATTERN, match => redactSensitiveUrl(match));
}

export { sha256Hex };

function binaryBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Unsupported binary artifact value');
}

function base64(value) {
  const bytes = binaryBytes(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function readManifestFromR2(env, runId) {
  const object = await env.RECEIPTS?.get(`runs/${runId}/manifest.json`);
  if (!object) return null;
  return JSON.parse(await object.text());
}

async function readManifestFromD1(env, runId) {
  if (!env.DB) return null;
  const row = await env.DB.prepare('SELECT run_id, status, viewport_name, artifact_keys_json, receipt_key FROM visual_runs WHERE run_id = ?')
    .bind(runId)
    .first();
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

export async function loadVisualManifest(env, runId) {
  return await readManifestFromR2(env, runId) || await readManifestFromD1(env, runId);
}

async function selectManifest(env, manifest, requestedViewport, artifactType) {
  if (manifest?.kind !== 'multi_viewport') {
    return { manifest, runId: manifest?.run_id, viewport: manifest?.viewport?.name || null };
  }
  if (artifactType === 'manifest' && !requestedViewport) {
    return { manifest, runId: manifest.run_id, viewport: null };
  }
  if (!requestedViewport) {
    return resultError('viewport_required', { run_id: manifest.run_id, artifact_type: artifactType });
  }
  const child = (manifest.results || []).find(result => result.viewport?.name === requestedViewport);
  if (!child?.run_id) {
    return resultError('viewport_not_found', {
      run_id: manifest.run_id,
      artifact_type: artifactType,
      viewport: requestedViewport,
    });
  }
  const childManifest = await loadVisualManifest(env, child.run_id);
  if (!childManifest) {
    return resultError('receipt_not_found', {
      run_id: child.run_id,
      parent_run_id: manifest.run_id,
      viewport: requestedViewport,
    });
  }
  return { manifest: childManifest, runId: child.run_id, viewport: requestedViewport };
}

function artifactKey(manifest, artifactType) {
  if (artifactType === 'manifest') return manifest.receipt_key || manifest.artifacts?.manifest || null;
  return manifest.artifacts?.[artifactType] || manifest.artifact_summary?.[artifactType]?.key || null;
}

function artifactContentType(manifest, artifactType, object) {
  return manifest.artifact_summary?.[artifactType]?.content_type
    || object?.httpMetadata?.contentType
    || object?.httpMetadata?.content_type
    || (artifactType === 'screenshot' ? 'image/png' : 'application/octet-stream');
}

function inlineLimit(artifactType) {
  return artifactType === 'screenshot' ? INLINE_LIMITS.binary : INLINE_LIMITS.text;
}

function publicMetadata({ runId, artifactType, viewport, contentType, bytes, sha256, key, responseMode, inline }) {
  return {
    ok: true,
    run_id: runId,
    artifact_type: artifactType,
    viewport: viewport || null,
    content_type: contentType,
    bytes,
    sha256,
    object_key: key,
    response_mode: responseMode,
    inline,
    requires_url: !inline && bytes > inlineLimit(artifactType),
  };
}

function jsonContent(text) {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value: text };
  }
}

export async function getVisualArtifact(env, args = {}) {
  if (args.object_key || args.key || args.r2_key) {
    return resultError('unregistered_object_key_input');
  }
  if (!env?.RECEIPTS) return resultError('receipts_binding_missing');

  const runId = normalizeRunId(args.investigation_id || args.run_id);
  if (!runId) return resultError('invalid_investigation_id');
  const artifactType = normalizeArtifactType(args.artifact_type);
  if (!artifactType) {
    return resultError('invalid_artifact_type', { allowed_artifact_types: ARTIFACT_TYPES });
  }
  const responseMode = normalizeResponseMode(args.response_mode);
  if (!responseMode) {
    return resultError('invalid_response_mode', { allowed_response_modes: RESPONSE_MODES });
  }

  const rootManifest = await loadVisualManifest(env, runId);
  if (!rootManifest) return resultError('receipt_not_found', { investigation_id: runId });

  const requestedViewport = viewportName(args.viewport);
  const selection = await selectManifest(env, rootManifest, requestedViewport, artifactType);
  if (selection.ok === false) return selection;

  const selectedManifest = selection.manifest;
  const key = artifactKey(selectedManifest, artifactType);
  const summary = selectedManifest.artifact_summary?.[artifactType];
  if (!key || ['failed', 'skipped_oversize', 'not_requested'].includes(summary?.status)) {
    return resultError('artifact_not_found', {
      run_id: selection.runId,
      artifact_type: artifactType,
      viewport: selection.viewport,
      artifact_status: summary?.status || null,
    });
  }

  const object = await env.RECEIPTS.get(key);
  if (!object) {
    return resultError('artifact_not_found', {
      run_id: selection.runId,
      artifact_type: artifactType,
      viewport: selection.viewport,
    });
  }

  const buffer = await object.arrayBuffer();
  const bytes = buffer.byteLength;
  const contentType = artifactContentType(selectedManifest, artifactType, object);
  const sha256 = await sha256Hex(buffer);
  const shouldInline = responseMode !== 'metadata' && bytes <= inlineLimit(artifactType);
  const metadata = publicMetadata({
    runId: selection.runId,
    artifactType,
    viewport: selection.viewport,
    contentType,
    bytes,
    sha256,
    key,
    responseMode,
    inline: shouldInline,
  });

  if (!shouldInline) return metadata;

  if (artifactType === 'screenshot') {
    const image = {
      type: 'image',
      data: base64(buffer),
      mimeType: contentType,
    };
    return {
      ...metadata,
      image: {
        data: image.data,
        mime_type: contentType,
      },
      mcp_content: [
        { type: 'text', text: JSON.stringify(metadata, null, 2) },
        image,
      ],
    };
  }

  const redacted = redactSensitiveText(decoder.decode(buffer));
  const content = JSON_ARTIFACTS.has(artifactType) || contentType.includes('json')
    ? jsonContent(redacted)
    : { parsed: false, value: redacted };
  const result = content.parsed
    ? { ...metadata, content_json: content.value }
    : { ...metadata, content_text: content.value };
  return {
    ...result,
    mcp_content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}
