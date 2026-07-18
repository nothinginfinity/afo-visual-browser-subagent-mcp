import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

test('worker declares all required initial bindings', () => {
  for (const binding of ['BROWSER', 'AI', 'DB', 'RECEIPTS', 'VECTORIZE', 'VISUAL_AUDIT_QUEUE', 'ANALYTICS']) {
    assert.match(source, new RegExp(`\\b${binding}\\b`));
  }
});

test('worker exposes all Phase 1 tools', () => {
  for (const tool of ['visual_browser_status', 'capture_screenshot', 'capture_snapshot', 'capture_multi_viewport', 'enqueue_visual_audit']) {
    assert.match(source, new RegExp(tool));
  }
});

test('worker enforces public https-only mode', () => {
  assert.match(source, /Only https URLs are allowed/);
  assert.match(source, /Private IPv4 targets are blocked/);
  assert.match(source, /Localhost targets are blocked/);
});
