# AFO Visual Browser Sub-Agent MCP

Cloudflare-native visual evidence and browser-investigation service. Phase 1 is deliberately public, read-only, deterministic, and receipt-first.

## Phase 1 tools

- `visual_browser_status`
- `capture_screenshot`
- `capture_snapshot`
- `capture_multi_viewport`
- `enqueue_visual_audit`

## Required initial bindings

- Browser Rendering: `BROWSER`
- Workers AI: `AI`
- D1: `DB`
- R2: `RECEIPTS`
- Vectorize: `VECTORIZE`
- Queues: `VISUAL_AUDIT_QUEUE`
- Analytics Engine: `ANALYTICS`

Vectorize, Queues, and Analytics Engine are foundational requirements, not optional roadmap items.

## Security boundary

Phase 1 accepts public `https:` URLs only. Localhost, private IPv4 ranges, link-local ranges, and private IPv6 ranges are blocked. Query parameters that look like credentials are redacted from receipts.

## Before deployment

1. Create the D1 database, R2 bucket, Vectorize index, producer/consumer queue, dead-letter queue, and Analytics Engine dataset.
2. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to GitHub Actions or your local environment.
4. Apply D1 migrations.
5. Run `npm install`, `npm run check`, and `npm test`.
6. Deploy and verify `/status`, MCP initialization, and one screenshot against a safe public test page.

See `ROADMAP.md` for the complete build order.
