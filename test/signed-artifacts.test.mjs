import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ARTIFACT_TTL_SECONDS,
  createVisualArtifactUrl,
  handleSignedArtifactRequest,
  signArtifactClaim,
} from '../src/signed-artifacts.js';

const SECRET = 'test-signing-secret-with-at-least-32-bytes';
const NOW = 2_000_000_000;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const JSON_BYTES = new TextEncoder().encode('{"ok":true}');

function objectFor(bytes, contentType) {
  return {
    body: bytes,
    httpMetadata: { contentType },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
  };
}

function singleManifest() {
  return {
    run_id: 'run_123',
    kind: 'snapshot',
    viewport: { name: 'desktop' },
    receipt_key: 'runs/run_123/manifest.json',
    artifacts: {
      screenshot: 'runs/run_123/screenshot.png',
      console: 'runs/run_123/console.json',
      manifest: 'runs/run_123/manifest.json',
    },
    artifact_summary: {
      screenshot: { status: 'stored', key: 'runs/run_123/screenshot.png', content_type: 'image/png' },
      console: { status: 'stored', key: 'runs/run_123/console.json', content_type: 'application/json; charset=utf-8' },
      manifest: { status: 'stored', key: 'runs/run_123/manifest.json', content_type: 'application/json; charset=utf-8' },
    },
  };
}

function environment(overrides = {}) {
  const manifest = overrides.manifest || singleManifest();
  const objects = new Map([
    ['runs/run_123/manifest.json', objectFor(new TextEncoder().encode(JSON.stringify(manifest)), 'application/json; charset=utf-8')],
    ['runs/run_123/screenshot.png', objectFor(PNG, 'image/png')],
    ['runs/run_123/console.json', objectFor(JSON_BYTES, 'application/json; charset=utf-8')],
  ]);
  for (const [key, value] of Object.entries(overrides.objects || {})) {
    if (value === null) objects.delete(key);
    else objects.set(key, value);
  }
  return {
    ARTIFACT_SIGNING_SECRET: overrides.secret ?? SECRET,
    RECEIPTS: {
      async get(key) {
        return objects.get(key) || null;
      },
    },
  };
}

async function signedUrl(args = {}, env = environment(), nowSeconds = NOW) {
  const result = await createVisualArtifactUrl(env, {
    run_id: 'run_123',
    artifact_type: 'screenshot',
    viewport: 'desktop',
    ...args,
  }, {
    origin: 'https://worker.example',
    nowSeconds,
  });
  assert.equal(result.ok, true);
  return result;
}

function tamper(url, mutate) {
  const parsed = new URL(url);
  mutate(parsed);
  return parsed.toString();
}

test('valid signature retrieves exact PNG bytes and strict headers', async () => {
  const env = environment();
  const created = await signedUrl({}, env);
  const response = await handleSignedArtifactRequest(new Request(created.url), env, { nowSeconds: NOW + 1 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-disposition'), /^inline;/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
});

test('exact expiration boundary is rejected', async () => {
  const env = environment();
  const created = await signedUrl({ ttl_seconds: 10 }, env);
  const response = await handleSignedArtifactRequest(new Request(created.url), env, {
    nowSeconds: created.expires_unix,
  });
  assert.equal(response.status, 403);
});

test('expired URL is rejected with HTTP 403', async () => {
  const env = environment();
  const created = await signedUrl({ ttl_seconds: 10 }, env);
  const response = await handleSignedArtifactRequest(new Request(created.url), env, {
    nowSeconds: created.expires_unix + 1,
  });
  assert.equal(response.status, 403);
});

for (const [name, mutate] of [
  ['run ID', url => { url.pathname = url.pathname.replace('run_123', 'run_999'); }],
  ['artifact type', url => { url.pathname = url.pathname.replace('screenshot', 'console'); }],
  ['viewport', url => { url.searchParams.set('viewport', 'mobile'); }],
  ['expiration', url => { url.searchParams.set('expires', String(Number(url.searchParams.get('expires')) + 1)); }],
  ['signature', url => { url.searchParams.set('signature', `0${url.searchParams.get('signature').slice(1)}`); }],
]) {
  test(`tampered ${name} is rejected`, async () => {
    const env = environment();
    const created = await signedUrl({}, env);
    const response = await handleSignedArtifactRequest(new Request(tamper(created.url, mutate)), env, {
      nowSeconds: NOW + 1,
    });
    assert.equal(response.status, 403);
  });
}

test('unknown run is rejected', async () => {
  const env = environment();
  const expires = NOW + 600;
  const signature = await signArtifactClaim(SECRET, {
    runId: 'unknown_run',
    artifactType: 'screenshot',
    viewport: 'desktop',
    expires,
  });
  const url = `https://worker.example/artifacts/unknown_run/screenshot?viewport=desktop&expires=${expires}&signature=${signature}`;
  const response = await handleSignedArtifactRequest(new Request(url), env, { nowSeconds: NOW });
  assert.equal(response.status, 403);
});

test('artifact absent from manifest is rejected', async () => {
  const manifest = singleManifest();
  delete manifest.artifacts.screenshot;
  delete manifest.artifact_summary.screenshot;
  const env = environment({ manifest });
  const expires = NOW + 600;
  const signature = await signArtifactClaim(SECRET, {
    runId: 'run_123',
    artifactType: 'screenshot',
    viewport: 'desktop',
    expires,
  });
  const url = `https://worker.example/artifacts/run_123/screenshot?viewport=desktop&expires=${expires}&signature=${signature}`;
  const response = await handleSignedArtifactRequest(new Request(url), env, { nowSeconds: NOW });
  assert.equal(response.status, 403);
});

test('directory traversal is rejected', async () => {
  const env = environment();
  const response = await handleSignedArtifactRequest(
    new Request(`https://worker.example/artifacts/${encodeURIComponent('../run_123')}/screenshot?expires=${NOW + 600}&signature=${'a'.repeat(64)}`),
    env,
    { nowSeconds: NOW },
  );
  assert.equal(response.status, 403);
});

test('arbitrary R2 key input is rejected', async () => {
  const result = await createVisualArtifactUrl(environment(), {
    run_id: 'run_123',
    artifact_type: 'screenshot',
    viewport: 'desktop',
    object_key: 'private/other-object',
  }, {
    origin: 'https://worker.example',
    nowSeconds: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unregistered_object_key_input');
});

test('maximum TTL is enforced', async () => {
  const accepted = await signedUrl({ ttl_seconds: MAX_ARTIFACT_TTL_SECONDS });
  assert.equal(accepted.ttl_seconds, MAX_ARTIFACT_TTL_SECONDS);
  const rejected = await createVisualArtifactUrl(environment(), {
    run_id: 'run_123',
    artifact_type: 'screenshot',
    viewport: 'desktop',
    ttl_seconds: MAX_ARTIFACT_TTL_SECONDS + 1,
  }, {
    origin: 'https://worker.example',
    nowSeconds: NOW,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'invalid_ttl_seconds');
});

test('JSON artifact has correct content type and exact bytes', async () => {
  const env = environment();
  const created = await signedUrl({ artifact_type: 'console' }, env);
  const response = await handleSignedArtifactRequest(new Request(created.url), env, { nowSeconds: NOW + 1 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), JSON_BYTES);
});

test('signing secret is never returned in tool result or error response', async () => {
  const env = environment();
  const created = await signedUrl({}, env);
  assert.equal(JSON.stringify(created).includes(SECRET), false);
  const invalid = await handleSignedArtifactRequest(
    new Request(tamper(created.url, url => url.searchParams.set('signature', 'f'.repeat(64)))),
    env,
    { nowSeconds: NOW + 1 },
  );
  assert.equal((await invalid.text()).includes(SECRET), false);
});

test('missing signing secret fails closed without exposing it', async () => {
  const result = await createVisualArtifactUrl(environment({ secret: '' }), {
    run_id: 'run_123',
    artifact_type: 'screenshot',
    viewport: 'desktop',
  }, {
    origin: 'https://worker.example',
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, error: 'artifact_signing_unavailable', status: 503 });
});
