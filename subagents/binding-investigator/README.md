# Binding Investigator

Read-only MCP subagent for auditing Cloudflare Worker binding drift.

## Worker

`afo-binding-investigator-mcp`

## Purpose

Most AFO breakages are binding drift rather than code bugs. This subagent compares repo configuration against live Cloudflare settings and reports missing, extra, or changed bindings.

It audits:

- D1 bindings
- KV namespace bindings
- R2 bucket bindings
- Workers AI binding
- service bindings
- plain text environment variables
- secret binding name presence, without reading secret values
- wrong binding names
- wrong resource IDs or bucket/database/service targets

## Tools

- `subagent_status`
- `read_repo_wrangler`
- `get_live_worker_bindings`
- `list_live_worker_secrets`
- `compare_bindings`
- `investigate_binding_drift`

## Runtime credentials

Live Cloudflare inspection requires a read-only Cloudflare API credential exposed to the Worker as one of:

- `CLOUDFLARE_API_TOKEN`
- `CF_API_TOKEN`
- `CLOUDFLARE_TOKEN`

Also provide the account id either as a Worker variable or per tool call:

- `CLOUDFLARE_ACCOUNT_ID`
- `CF_ACCOUNT_ID`
- `ACCOUNT_ID`

GitHub source config reads can use `GITHUB_TOKEN` or `GH_TOKEN`, but public files can be read without it.

Secrets are compared by binding name only. The Worker never reads secret values. Use `expected_secret_names` or `EXPECTED_SECRET_NAMES` for secrets that should exist but are not represented in wrangler config.

## Safety boundary

This Worker only performs GitHub GET, Cloudflare GET, and local comparison logic. It does not create, update, delete, deploy, rerun, or mutate anything.
