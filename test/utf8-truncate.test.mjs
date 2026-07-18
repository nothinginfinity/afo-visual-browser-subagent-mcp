import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareJsonArtifact,
  truncateUtf8,
  utf8ByteLength,
} from '../src/artifacts.js';

const encoder = new TextEncoder();

test('truncateUtf8 respects every byte boundary without splitting Unicode', () => {
  const value = 'ASCII 😀 café 漢字 🚀';
  const total = utf8ByteLength(value);
  for (let limit = 0; limit <= total; limit += 1) {
    const result = truncateUtf8(value, limit);
    assert.ok(result.stored_bytes <= limit);
    assert.equal(result.stored_bytes, encoder.encode(result.text).byteLength);
    assert.equal(value.startsWith(result.text), true);
  }
});

test('truncateUtf8 reports exact below, at, and above-limit metadata', () => {
  const value = 'ab😀漢';
  const bytes = utf8ByteLength(value);
  assert.equal(truncateUtf8(value, bytes).truncated, false);
  assert.equal(truncateUtf8(value, bytes + 1).truncated, false);
  const below = truncateUtf8(value, bytes - 1);
  assert.equal(below.truncated, true);
  assert.ok(below.stored_bytes <= bytes - 1);
});

test('prepareJsonArtifact keeps oversized JSON valid and within the byte ceiling', () => {
  const result = prepareJsonArtifact({ html: '😀漢é'.repeat(200) }, 220);
  assert.equal(result.truncated, true);
  assert.ok(result.stored_bytes <= 220);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.original_bytes > result.stored_bytes);
});
