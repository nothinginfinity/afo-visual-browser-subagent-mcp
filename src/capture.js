import { truncateUtf8 } from './artifacts.js';

function truncateText(value, maxBytes) {
  return truncateUtf8(value, maxBytes).text;
}

export function collectPageEvidence(page, { detailed = true, logLimit = 500 } = {}) {
  const evidence = {
    console: [],
    page_errors: [],
    failed_requests: [],
    failed_responses: [],
    redirects: [],
    counts: {
      console_entries: 0,
      console_errors: 0,
      page_errors: 0,
      failed_requests: 0,
      failed_responses: 0,
    },
  };

  page.on('console', event => {
    const type = event.type();
    evidence.counts.console_entries += 1;
    if (type === 'error') evidence.counts.console_errors += 1;
    if (detailed && evidence.console.length < logLimit) {
      evidence.console.push({
        type,
        text: truncateText(event.text(), 2000),
        at: new Date().toISOString(),
      });
    }
  });

  page.on('pageerror', event => {
    evidence.counts.page_errors += 1;
    evidence.counts.console_errors += 1;
    if (detailed && evidence.page_errors.length < logLimit) {
      evidence.page_errors.push({
        message: truncateText(event?.message || event || 'unknown_error', 2000),
        at: new Date().toISOString(),
      });
    }
  });

  page.on('requestfailed', request => {
    evidence.counts.failed_requests += 1;
    if (detailed && evidence.failed_requests.length < logLimit) {
      evidence.failed_requests.push({
        url: request.url(),
        method: request.method(),
        resource_type: request.resourceType(),
        failure: truncateText(request.failure()?.errorText || 'unknown', 1000),
      });
    }
  });

  page.on('response', response => {
    if (response.status() < 400) return;
    evidence.counts.failed_responses += 1;
    if (detailed && evidence.failed_responses.length < logLimit) {
      evidence.failed_responses.push({
        url: response.url(),
        status: response.status(),
        status_text: truncateText(response.statusText(), 300),
      });
    }
  });

  return evidence;
}

async function pageMetadata(page) {
  return page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang || null,
    ready_state: document.readyState,
    dimensions: {
      scroll_width: document.documentElement.scrollWidth,
      scroll_height: document.documentElement.scrollHeight,
      viewport_width: innerWidth,
      viewport_height: innerHeight,
    },
  }));
}

async function pagePerformance(page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    return navigation ? {
      duration: navigation.duration,
      dom_content_loaded_ms: navigation.domContentLoadedEventEnd,
      load_event_ms: navigation.loadEventEnd,
      response_start_ms: navigation.responseStart,
      response_end_ms: navigation.responseEnd,
      transfer_size: navigation.transferSize,
      encoded_body_size: navigation.encodedBodySize,
      decoded_body_size: navigation.decodedBodySize,
    } : null;
  });
}

async function domSnapshot(page, textLimit) {
  return page.evaluate(max => {
    const text = (document.body?.innerText || '').replace(/\u0000/g, '').slice(0, max);
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .slice(0, 200)
      .map(node => ({
        level: node.tagName.toLowerCase(),
        text: (node.innerText || '').trim().slice(0, 500),
      }));
    const links = [...document.querySelectorAll('a[href]')]
      .slice(0, 500)
      .map(node => ({
        text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 300),
        href: node.href,
      }));
    const controls = [...document.querySelectorAll('button,input,select,textarea,[role="button"],[role="link"]')]
      .slice(0, 300)
      .map(node => ({
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role'),
        label: (node.getAttribute('aria-label') || node.innerText || node.getAttribute('placeholder') || '').trim().slice(0, 300),
        disabled: Boolean(node.disabled),
      }));
    return {
      title: document.title,
      lang: document.documentElement.lang || null,
      ready_state: document.readyState,
      text,
      headings,
      links,
      controls,
      dimensions: {
        scroll_width: document.documentElement.scrollWidth,
        scroll_height: document.documentElement.scrollHeight,
        viewport_width: innerWidth,
        viewport_height: innerHeight,
      },
    };
  }, textLimit);
}

async function settled(name, task) {
  try {
    return { name, ok: true, value: await task() };
  } catch (error) {
    return {
      name,
      ok: false,
      error: truncateText(error?.message || error || `${name}_failed`, 2000),
    };
  }
}

export async function capturePng(page, { fullPage = true } = {}) {
  const started = Date.now();
  const bytes = new Uint8Array(await page.screenshot({
    type: 'png',
    fullPage,
    captureBeyondViewport: true,
  }));
  return {
    bytes,
    duration_ms: Date.now() - started,
  };
}

export async function captureEvidenceForMode(page, {
  mode,
  textLimit = 100000,
} = {}) {
  const started = Date.now();
  if (mode === 'screenshot') {
    const [metadata, performance] = await Promise.all([
      settled('metadata', () => pageMetadata(page)),
      settled('performance', () => pagePerformance(page)),
    ]);
    return {
      mode,
      duration_ms: Date.now() - started,
      metadata: metadata.ok ? metadata.value : null,
      performance: performance.ok ? performance.value : null,
      html: null,
      dom: null,
      accessibility: null,
      errors: [metadata, performance].filter(result => !result.ok),
    };
  }

  const [metadata, performance, html, dom, accessibility] = await Promise.all([
    settled('metadata', () => pageMetadata(page)),
    settled('performance', () => pagePerformance(page)),
    settled('html', () => page.content()),
    settled('dom', () => domSnapshot(page, textLimit)),
    settled('accessibility', () => page.accessibility.snapshot({ interestingOnly: false })),
  ]);

  return {
    mode,
    duration_ms: Date.now() - started,
    metadata: metadata.ok ? metadata.value : dom.ok ? dom.value : null,
    performance: performance.ok ? performance.value : null,
    html: html.ok ? html.value : null,
    dom: dom.ok ? dom.value : null,
    accessibility: accessibility.ok ? accessibility.value : null,
    errors: [metadata, performance, html, dom, accessibility].filter(result => !result.ok),
  };
}
