import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEvidenceForMode, capturePng } from '../src/capture.js';

function screenshotOnlyPage() {
  let evaluateCalls = 0;
  return {
    contentCalls: 0,
    accessibilityCalls: 0,
    screenshotCalls: 0,
    async screenshot() {
      this.screenshotCalls += 1;
      return new Uint8Array([137, 80, 78, 71]).buffer;
    },
    async content() {
      this.contentCalls += 1;
      throw new Error('page.content must not run');
    },
    accessibility: {
      snapshot: async () => {
        throw new Error('accessibility must not run');
      },
    },
    async evaluate() {
      evaluateCalls += 1;
      if (evaluateCalls === 1) return { title: 'Page', lang: 'en', ready_state: 'complete', dimensions: {} };
      return { duration: 10 };
    },
  };
}

test('screenshot mode captures PNG and never calls heavyweight snapshot APIs', async () => {
  const page = screenshotOnlyPage();
  const png = await capturePng(page, { fullPage: false });
  const evidence = await captureEvidenceForMode(page, { mode: 'screenshot' });
  assert.equal(png.bytes.byteLength, 4);
  assert.equal(page.screenshotCalls, 1);
  assert.equal(page.contentCalls, 0);
  assert.equal(page.accessibilityCalls, 0);
  assert.equal(evidence.html, null);
  assert.equal(evidence.accessibility, null);
  assert.equal(evidence.errors.length, 0);
});

test('snapshot mode isolates optional extraction failures', async () => {
  let evaluateCalls = 0;
  const page = {
    async content() { throw new Error('HTML too large upstream'); },
    accessibility: { async snapshot() { return { role: 'RootWebArea' }; } },
    async evaluate() {
      evaluateCalls += 1;
      if (evaluateCalls === 1) return { title: 'Page', dimensions: {} };
      if (evaluateCalls === 2) return { duration: 10 };
      return { title: 'Page', text: 'body', headings: [], links: [], controls: [], dimensions: {} };
    },
  };
  const evidence = await captureEvidenceForMode(page, { mode: 'snapshot' });
  assert.equal(evidence.html, null);
  assert.equal(evidence.dom.text, 'body');
  assert.equal(evidence.accessibility.role, 'RootWebArea');
  assert.equal(evidence.errors.some(error => error.name === 'html'), true);
});
