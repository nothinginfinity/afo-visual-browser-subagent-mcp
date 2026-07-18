# AFO D1 Investigator MCP

Read-only Cloudflare D1 database investigator built from the AFO Visual Browser Sub-Agent MCP.

Worker name:

```text
afo-d1-investigator-mcp
```

Primary one-call tool:

```text
investigate_database
```

## Purpose

Inspect D1 databases from mobile or any MCP client using a read-only evidence-first workflow.

The internal flow is:

```text
database name/id -> resolve uuid -> sqlite_master schema -> optional table samples -> synthesis -> audit trail
```

## Tools

- `subagent_status`
- `list_d1_databases`
- `resolve_d1_database`
- `list_d1_tables`
- `get_d1_schema`
- `query_d1_read`
- `sample_d1_table`
- `investigate_database`

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

## Read-only guardrails

`query_d1_read` allows only:

```text
SELECT
WITH
PRAGMA
```

It blocks write and DDL keywords such as:

```text
INSERT
UPDATE
DELETE
DROP
ALTER
CREATE
REPLACE
ATTACH
DETACH
VACUUM
REINDEX
```

This Worker does not require a direct D1 binding. It uses the Cloudflare API so it can inspect multiple D1 databases from one MCP endpoint.
