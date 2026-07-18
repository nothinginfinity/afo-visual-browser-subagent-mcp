# AFO Worker Investigator MCP

Cloudflare Worker investigator built from the AFO Visual Browser Sub-Agent MCP.

Worker name:

```text
afo-visual-browser-investigator-mcp
```

Primary one-call tool:

```text
investigate_worker
```

## Purpose

Inspect Cloudflare Workers from mobile or any MCP client using a one-call evidence-first workflow.

The internal flow is:

```text
script name -> settings -> bindings -> workers.dev status -> versions if available -> synthesis -> audit trail
```

## Tools

- `subagent_status`
- `list_workers`
- `get_worker_settings`
- `get_worker_subdomain`
- `list_worker_versions`
- `investigate_worker`

## Runtime bindings/secrets

Required:

```text
AI
CF_API_TOKEN
CF_ACCOUNT_ID
WORKER_NAME
```

The GitHub Actions workflow deploys the Worker and writes `CF_API_TOKEN` and `CF_ACCOUNT_ID` into the Worker runtime from the existing GitHub repo secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

## Safety note

This Worker returns binding names and binding types, but never secret values. Cloudflare does not return secret values through Worker settings.
