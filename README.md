# AFO Visual Browser Sub-Agent MCP

Cloudflare-native visual evidence and browser-investigation service. The current release is deliberately public, read-only, deterministic, and receipt-first.

## Phase 1 tools

- `visual_browser_status`
- `capture_screenshot`
- `capture_snapshot`
- `capture_multi_viewport`
- `enqueue_visual_audit`
- `get_visual_receipt`
- `get_visual_artifact`

## Capture reliability behavior

`capture_screenshot` is a true screenshot-only path. It captures and stores the PNG plus a minimal manifest, navigation timing, page metadata, and cheap console/network counts. It does not call `page.content()`, generate Markdown, request an accessibility snapshot, serialize full console/network artifacts, or create embeddings.

`capture_snapshot` and `capture_multi_viewport` retain the richer evidence pipeline. Text artifacts are limited by encoded UTF-8 byte size, and optional artifact truncation or failure is recorded in `artifact_summary` and `warnings` without invalidating a successfully stored screenshot. Successful runs with optional evidence warnings report `status: "ok_with_warnings"`.

## Artifact access behavior

`get_visual_artifact` retrieves only artifacts registered in a persisted run manifest. Callers provide `run_id` or `investigation_id`, an `artifact_type`, and optional `viewport` and `response_mode`. Arbitrary `object_key`, `key`, and `r2_key` inputs are rejected.

Small PNGs can be returned as native MCP image content with base64 data and MIME type. Text and JSON evidence is returned inline only below conservative limits. Oversized artifacts return metadata, byte size, SHA-256, and `requires_url: true`; temporary signed URLs remain deferred to a later release. Sensitive URL query values are redacted before text evidence is returned.

## Required initial bindings

- Browser Rendering: `BROWSER`
- Workers AI: `AI`
- D1: `DB`
- R2: `RECEIPTS`
- Vectorize: `VECTORIZE`
- Queues: `AUDIT_QUEUE`
- Analytics Engine: `ANALYTICS`

Vectorize, Queues, and Analytics Engine are foundational requirements, not optional roadmap items.

## Security boundary

The Worker accepts public `https:` URLs only. Localhost, private IPv4 ranges, link-local ranges, and private IPv6 ranges are blocked. Query parameters that look like credentials are redacted from receipts.

## Before deployment

1. Create the D1 database, R2 bucket, Vectorize index, producer/consumer queue, dead-letter queue, and Analytics Engine dataset.
2. Confirm the D1 database ID and all binding names in `wrangler.jsonc`.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to GitHub Actions or the local environment.
4. Apply D1 migrations.
5. Run `npm install`, `npm run check`, and `npm test`.
6. Deploy and verify `/status`, `/tools`, MCP initialization, and Link Lane screenshots at the standard viewports.

See `ROADMAP.md` for the complete build order.
