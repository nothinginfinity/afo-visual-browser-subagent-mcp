import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicId, redact, targetUrl, viewport } from '../src/worker.js';

const blocked = ['http://example.com','https://localhost','https://service.local','https://127.0.0.1','https://10.0.0.1','https://172.16.0.1','https://172.31.255.255','https://192.168.1.1','https://169.254.169.254','https://[::1]','https://[fd00::1]','https://[fe80::1]'];
for (const url of blocked) test(`blocks ${url}`, () => assert.throws(() => targetUrl(url)));
test('allows a public HTTPS URL and strips credentials', () => assert.equal(targetUrl('https://user:pass@example.com/path?q=1').toString(), 'https://example.com/path?q=1'));
test('redacts sensitive query parameters and fragments', () => assert.equal(redact(new URL('https://example.com/path?token=abc&view=full&signature=xyz#secret')), 'https://example.com/path?token=%5BREDACTED%5D&view=full&signature=%5BREDACTED%5D'));
test('viewport dimensions are bounded', () => assert.deepEqual(viewport({ name: 'x', width: 99999, height: 1, deviceScaleFactor: 8 }), { name: 'x', width: 2560, height: 240, deviceScaleFactor: 3, isMobile: false, hasTouch: false }));
test('deterministic IDs are stable and input-sensitive', () => { assert.equal(deterministicId('same'), deterministicId('same')); assert.notEqual(deterministicId('same'), deterministicId('different')); });
