# Cloudflare Deploy Investigator

Read-only MCP subagent for Cloudflare Worker deployment investigation.

## Worker

`afo-cloudflare-deploy-investigator-mcp`

## Purpose

This subagent separates repo state from live deployment state. It answers:

- Is the Worker deployed in Cloudflare?
- What script/settings/bindings are currently live?
- Is workers.dev enabled and what URL should be tested?
- Are there routes or custom domains pointing to this Worker?
- What deployment or version history is visible through the Cloudflare API?
- Does GitHub source match the current deployed Worker script?
- Does the live Worker behavior match the expected status/version markers?

## Tools

- `subagent_status`
- `list_workers`
- `get_worker_settings`
- `get_deployment_history`
- `get_script_content`
- `list_worker_routes`
- `smoke_live_worker`
- `get_github_source`
- `compare_source_to_live`
- `investigate_cloudflare_deploy`

## Runtime credentials

For live Cloudflare API checks, configure a read-only Cloudflare API credential as one of:

- `CLOUDFLARE_API_TOKEN`
- `CF_API_TOKEN`
- `CLOUDFLARE_TOKEN`

Also provide the account id either as a Worker variable or per tool call:

- `CLOUDFLARE_ACCOUNT_ID`
- `CF_ACCOUNT_ID`
- `ACCOUNT_ID`

Optional GitHub source comparison can use `GITHUB_TOKEN` or `GH_TOKEN`, but public source files can be read without it.

## Safety boundary

This Worker only performs GET/read operations against Cloudflare and GitHub plus HTTP smoke checks against user-provided or inferred Worker URLs. It does not mutate Cloudflare, GitHub, or live traffic.
