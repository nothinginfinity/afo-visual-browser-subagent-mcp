const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

function normalizeLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

export function utf8ByteLength(value) {
  return encoder.encode(String(value ?? '')).byteLength;
}

export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  const limit = normalizeLimit(maxBytes);
  const encoded = encoder.encode(text);
  const originalBytes = encoded.byteLength;

  if (originalBytes <= limit) {
    return {
      text,
      original_bytes: originalBytes,
      stored_bytes: originalBytes,
      truncated: false,
    };
  }

  let end = Math.min(limit, originalBytes);
  let storedText = '';
  while (end > 0) {
    try {
      storedText = fatalDecoder.decode(encoded.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }

  return {
    text: storedText,
    original_bytes: originalBytes,
    stored_bytes: end,
    truncated: true,
  };
}

export function prepareTextArtifact(value, maxBytes) {
  return truncateUtf8(value, maxBytes);
}

export function prepareJsonArtifact(value, maxBytes, { allowTruncate = true } = {}) {
  const limit = normalizeLimit(maxBytes);
  const fullText = JSON.stringify(value, null, 2);
  const originalBytes = utf8ByteLength(fullText);

  if (originalBytes <= limit) {
    return {
      text: fullText,
      original_bytes: originalBytes,
      stored_bytes: originalBytes,
      truncated: false,
    };
  }

  if (!allowTruncate) {
    return {
      text: fullText,
      original_bytes: originalBytes,
      stored_bytes: originalBytes,
      truncated: false,
      oversized: true,
    };
  }

  const base = {
    truncated: true,
    original_bytes: originalBytes,
    preview: '',
  };
  const baseText = JSON.stringify(base, null, 2);
  const baseBytes = utf8ByteLength(baseText);
  if (baseBytes > limit) {
    return {
      text: baseText,
      original_bytes: originalBytes,
      stored_bytes: baseBytes,
      truncated: true,
      oversized: true,
    };
  }

  let previewLimit = Math.max(0, limit - baseBytes - 16);
  let prepared;
  while (previewLimit >= 0) {
    const preview = truncateUtf8(fullText, previewLimit).text;
    const text = JSON.stringify({ ...base, preview }, null, 2);
    const storedBytes = utf8ByteLength(text);
    if (storedBytes <= limit) {
      prepared = {
        text,
        original_bytes: originalBytes,
        stored_bytes: storedBytes,
        truncated: true,
      };
      break;
    }
    if (previewLimit === 0) break;
    previewLimit = Math.max(0, previewLimit - Math.max(1, storedBytes - limit));
  }

  return prepared || {
    text: baseText,
    original_bytes: originalBytes,
    stored_bytes: baseBytes,
    truncated: true,
  };
}

function valueBytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Unsupported artifact value type');
}

function valueByteLength(value) {
  return valueBytes(value).byteLength;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', valueBytes(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function artifactResult(status, key, contentType, extras = {}) {
  return {
    status,
    key: status === 'stored' || status === 'truncated' ? key : null,
    content_type: contentType,
    ...extras,
  };
}

export async function storeBinaryArtifact(env, {
  key,
  value,
  contentType,
  limit,
  required = false,
}) {
  const bytes = valueByteLength(value);
  const maxBytes = normalizeLimit(limit);
  const sha256 = await sha256Hex(value);

  if (!env?.RECEIPTS) {
    const result = artifactResult('failed', key, contentType, {
      bytes,
      sha256,
      limit_bytes: maxBytes,
      error: 'RECEIPTS binding is not configured',
    });
    if (required) {
      const error = new Error(result.error);
      error.artifact_result = result;
      throw error;
    }
    return result;
  }

  if (bytes > maxBytes) {
    const result = artifactResult('skipped_oversize', key, contentType, {
      bytes,
      sha256,
      limit_bytes: maxBytes,
      error: `Artifact ${key} exceeded ${maxBytes} byte limit`,
    });
    if (required) {
      const error = new Error(result.error);
      error.artifact_result = result;
      throw error;
    }
    return result;
  }

  try {
    await env.RECEIPTS.put(key, value, { httpMetadata: { contentType } });
    return artifactResult('stored', key, contentType, {
      bytes,
      sha256,
      limit_bytes: maxBytes,
    });
  } catch (error) {
    const result = artifactResult('failed', key, contentType, {
      bytes,
      sha256,
      limit_bytes: maxBytes,
      error: String(error?.message || error || 'artifact_write_failed').slice(0, 2000),
    });
    if (required) {
      const wrapped = new Error(result.error);
      wrapped.artifact_result = result;
      throw wrapped;
    }
    return result;
  }
}

export async function storeTextArtifact(env, {
  key,
  value,
  contentType,
  limit,
  required = false,
}) {
  const prepared = prepareTextArtifact(value, limit);
  const stored = await storeBinaryArtifact(env, {
    key,
    value: prepared.text,
    contentType,
    limit,
    required,
  });
  if (stored.status === 'stored' && prepared.truncated) {
    return {
      ...stored,
      status: 'truncated',
      original_bytes: prepared.original_bytes,
      stored_bytes: prepared.stored_bytes,
    };
  }
  return {
    ...stored,
    original_bytes: prepared.original_bytes,
    stored_bytes: stored.bytes ?? prepared.stored_bytes,
  };
}

export async function storeJsonArtifact(env, {
  key,
  value,
  contentType = 'application/json; charset=utf-8',
  limit,
  required = false,
  allowTruncate = true,
}) {
  const prepared = prepareJsonArtifact(value, limit, { allowTruncate });
  if (prepared.oversized) {
    const result = artifactResult('skipped_oversize', key, contentType, {
      bytes: prepared.original_bytes,
      original_bytes: prepared.original_bytes,
      stored_bytes: prepared.stored_bytes,
      limit_bytes: normalizeLimit(limit),
      error: `Artifact ${key} exceeded ${normalizeLimit(limit)} byte limit`,
    });
    if (required) {
      const error = new Error(result.error);
      error.artifact_result = result;
      throw error;
    }
    return result;
  }

  const stored = await storeBinaryArtifact(env, {
    key,
    value: prepared.text,
    contentType,
    limit,
    required,
  });
  if (stored.status === 'stored' && prepared.truncated) {
    return {
      ...stored,
      status: 'truncated',
      original_bytes: prepared.original_bytes,
      stored_bytes: prepared.stored_bytes,
    };
  }
  return {
    ...stored,
    original_bytes: prepared.original_bytes,
    stored_bytes: stored.bytes ?? prepared.stored_bytes,
  };
}

export function notRequestedArtifact(contentType) {
  return {
    status: 'not_requested',
    key: null,
    content_type: contentType,
  };
}

export function failedArtifact(contentType, error) {
  return {
    status: 'failed',
    key: null,
    content_type: contentType,
    error: truncateUtf8(error?.message || error || 'artifact_failed', 2000).text,
  };
}

export function deriveArtifactOutcome(artifactSummary, requiredNames = ['screenshot', 'manifest']) {
  const requiredFailures = [];
  const warnings = [];

  for (const [name, result] of Object.entries(artifactSummary || {})) {
    const status = result?.status || 'failed';
    if (requiredNames.includes(name)) {
      if (status !== 'stored') requiredFailures.push({ artifact: name, status, error: result?.error || null });
      continue;
    }
    if (['truncated', 'skipped_oversize', 'failed'].includes(status)) {
      warnings.push({ artifact: name, status, error: result?.error || null });
    }
  }

  return {
    ok: requiredFailures.length === 0,
    status: requiredFailures.length ? 'error' : warnings.length ? 'ok_with_warnings' : 'ok',
    warnings,
    required_failures: requiredFailures,
  };
}
