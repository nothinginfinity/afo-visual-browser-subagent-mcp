import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVisualArtifact,
  INLINE_LIMITS,
  redactSensitiveText,
  sha256Hex,
} from '../src/artifact-access.js';

function object(value, contentType) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return {
    httpMetadata: { contentType },
    size: bytes.byteLength,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async text() { return new TextDecoder().decode(bytes); },
  };
}

function envWith(objects) {
  return {
    RECEIPTS: {
      async get(key) { return objects.get(key) || null; },
    },
  };
}

function manifest(runId, artifacts, artifactSummary = {}, extras = {}) {
  return JSON.stringify({
    ok: true,
    run_id: runId,
    kind: 'snapshot',
    receipt_key: `runs/${runId}/manifest.json`,
    artifacts: { ...artifacts, manifest: `runs/${runId}/manifest.json` },
    artifact_summary: artifactSummary,
    ...extras,
  });
}

test('retrieves a registered small PNG as MCP image content with integrity metadata', async () => {
  const runId = 'vb_small_png';
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const objects = new Map();
  objects.set(`runs/${runId}/manifest.json`, object(manifest(runId, { screenshot: `runs/${runId}/mobile.png` }, {
    screenshot: { status: 'stored', key: `runs/${runId}/mobile.png`, content_type: 'image/png' },
  }), 'application/json; charset=utf-8'));
  objects.set(`runs/${runId}/mobile.png`, object(png, 'image/png'));

  const result = await getVisualArtifact(envWith(objects), {
    run_id: runId,
    artifact_type: 'screenshot',
    response_mode: 'auto',
  });

  assert.equal(result.ok, true);
  assert.equal(result.inline, true);
  assert.equal(result.bytes, png.byteLength);
  assert.equal(result.sha256, await sha256Hex(png));
  assert.equal(result.mcp_content[1].type, 'image');
  assert.equal(result.mcp_content[1].mimeType, 'image/png');
});

test('returns metadata only when a PNG exceeds the conservative inline limit', async () => {
  const runId = 'vb_large_png';
  const png = new Uint8Array(INLINE_LIMITS.binary + 1);
  const objects = new Map();
  objects.set(`runs/${runId}/manifest.json`, object(manifest(runId, { screenshot: `runs/${runId}/desktop.png` }), 'application/json'));
  objects.set(`runs/${runId}/desktop.png`, object(png, 'image/png'));

  const result = await getVisualArtifact(envWith(objects), {
    investigation_id: runId,
    artifact_type: 'screenshot',
    response_mode: 'inline',
  });

  assert.equal(result.ok, true);
  assert.equal(result.inline, false);
  assert.equal(result.requires_url, true);
  assert.equal('image' in result, false);
});

test('redacts sensitive URL query values in returned JSON evidence', async () => {
  const runId = 'vb_console';
  const objects = new Map();
  const consoleKey = `runs/${runId}/console.json`;
  objects.set(`runs/${runId}/manifest.json`, object(manifest(runId, { console: consoleKey }), 'application/json'));
  objects.set(consoleKey, object(JSON.stringify({ url: 'https://example.com/path?token=abc&safe=yes#fragment' }), 'application/json'));

  const result = await getVisualArtifact(envWith(objects), {
    run_id: runId,
    artifact_type: 'console',
  });

  assert.equal(result.ok, true);
  assert.equal(result.content_json.url.includes('abc'), false);
  assert.equal(result.content_json.url.includes('%5BREDACTED%5D') || result.content_json.url.includes('[REDACTED]'), true);
  assert.equal(result.content_json.url.includes('#fragment'), false);
});

test('rejects unknown types, caller-supplied keys, invalid IDs, and missing artifacts', async () => {
  const runId = 'vb_missing';
  const objects = new Map();
  objects.set(`runs/${runId}/manifest.json`, object(manifest(runId, {}), 'application/json'));
  const env = envWith(objects);

  assert.equal((await getVisualArtifact(env, { run_id: runId, artifact_type: 'video' })).error, 'invalid_artifact_type');
  assert.equal((await getVisualArtifact(env, { run_id: runId, artifact_type: 'manifest', object_key: 'other/key' })).error, 'unregistered_object_key_input');
  assert.equal((await getVisualArtifact(env, { run_id: '../secret', artifact_type: 'manifest' })).error, 'invalid_investigation_id');
  assert.equal((await getVisualArtifact(env, { run_id: runId, artifact_type: 'network' })).error, 'artifact_not_found');
});

test('resolves an artifact through a registered multi-viewport child receipt', async () => {
  const parentId = 'vb_parent';
  const childId = 'vb_child_mobile';
  const screenshotKey = `runs/${childId}/mobile.png`;
  const parent = JSON.stringify({
    run_id: parentId,
    kind: 'multi_viewport',
    artifacts: { manifest: `runs/${parentId}/manifest.json` },
    results: [{ run_id: childId, viewport: { name: 'mobile' } }],
  });
  const objects = new Map();
  objects.set(`runs/${parentId}/manifest.json`, object(parent, 'application/json'));
  objects.set(`runs/${childId}/manifest.json`, object(manifest(childId, { screenshot: screenshotKey }), 'application/json'));
  objects.set(screenshotKey, object(new Uint8Array([1, 2, 3]), 'image/png'));

  const result = await getVisualArtifact(envWith(objects), {
    run_id: parentId,
    artifact_type: 'screenshot',
    viewport: 'mobile',
  });

  assert.equal(result.ok, true);
  assert.equal(result.run_id, childId);
  assert.equal(result.viewport, 'mobile');
});

test('redactSensitiveText leaves ordinary HTTPS URLs readable', () => {
  const text = redactSensitiveText('See https://example.com/path?safe=yes and continue.');
  assert.equal(text.includes('safe=yes'), true);
});
