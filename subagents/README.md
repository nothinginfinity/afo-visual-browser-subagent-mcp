# AFO First-Wave Sub-Agents

This folder holds the first wave of AFO investigative MCP Workers.

Architecture decision:

```text
one GitHub monorepo -> many Cloudflare Workers -> shared secret names -> separate MCP endpoints
```

This keeps development simple while avoiding one giant Worker with too many tools and too much blast radius.

## Current sub-agents

| Folder | Worker name | Status | Purpose |
|---|---|---|---|
| `repo-investigator` | `afo-repo-investigator-mcp` | deployed/reference clone | GitHub repo investigation using the proven v0.5.0 pipeline |
| `visual-browser-investigator` | `afo-visual-browser-investigator-mcp` | deployed | Cloudflare Worker settings, bindings, workers.dev status, and version investigation |
| `d1-investigator` | `afo-d1-investigator-mcp` | deployed | Read-only D1 database schema, table, sample, and query investigation |
| `mcp-tool-auditor` | `afo-mcp-tool-auditor` | deployable | Read-only MCP tool-surface audit for agent usability, schema clarity, and safety wording |

## Planned first wave

| Folder | Worker name | Purpose |
|---|---|---|
| `deploy-receipt-investigator` | `afo-deploy-receipt-investigator-mcp` | inspect receipts, deployment history, and drift |
| `cairnstone-chain-investigator` | `afo-cairnstone-chain-investigator-mcp` | inspect chains, stones, HEAD state, and handoffs |

## Shared secret convention

Each Worker should use the same secret names where possible:

```text
GITHUB_TOKEN
CF_API_TOKEN
CF_ACCOUNT_ID
AFO_ADMIN_TOKEN
AFO_SHARED_SECRET
```

Each Worker may receive only the secrets it actually needs, but the names should remain consistent.
