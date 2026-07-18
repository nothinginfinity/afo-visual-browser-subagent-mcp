import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveArtifactOutcome,
  storeBinaryArtifact,
  storeTextArtifact,
} from '../src/artifacts.js';

function envWithPut(put) {
  return { RECEIPTS: { put } };
}

test('oversized optional UTF-8 text is truncated and stored independently', async () => {
  const writes = [];
  const result = await storeTextArtifact(envWithPut(async (key, value) => writes.push({ key, value })), {
    key: 'runs/test/page.html',
    value: '😀漢'.repeat(100),
    contentType: 'text/html; charset=utf-8',
    limit: 64,
  });
  assert.equal(result.status, 'truncated');
  assert.equal(writes.length, 1);
  assert.ok(new TextEncoder().encode(writes[0].value).byteLength <= 64);
});

test('optional binary oversize is skipped while required binary oversize fails', async () => {
  const env = envWithPut(async () => {});
  const optional = await storeBinaryArtifact(env, {
    key: 'optional.png',
    value: new Uint8Array(10),
    contentType: 'image/png',
    limit: 4,
  });
  assert.equal(optional.status, 'skipped_oversize');
  await assert.rejects(() => storeBinaryArtifact(env, {
    key: 'required.png',
    value: new Uint8Array(10),
    contentType: 'image/png',
    limit: 4,
    required: true,
  }));
});

test('optional write failure produces ok_with_warnings when required artifacts are stored', async () => {
  const failed = await storeTextArtifact(envWithPut(async () => { throw new Error('R2 temporary failure'); }), {
    key: 'page.html',
    value: '<html></html>',
    contentType: 'text/html',
    limit: 1024,
  });
  const outcome = deriveArtifactOutcome({
    screenshot: { status: 'stored' },
    manifest: { status: 'stored' },
    html: failed,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'ok_with_warnings');
  assert.equal(outcome.warnings[0].artifact, 'html');
});
