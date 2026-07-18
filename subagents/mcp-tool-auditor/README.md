# AFO MCP Tool Auditor

Read-only MCP tool-surface auditor built from the AFO Visual Browser Sub-Agent MCP.

Worker name:

```text
afo-mcp-tool-auditor
```

Primary one-call tool:

```text
investigate_mcp_tool
```

## Purpose

Audit MCP tools for agent usability, mobile readiness, schema clarity, and safety wording.

The internal flow is:

```text
endpoint/tools -> tools/list -> schema audit -> score/issue summary -> optional AI synthesis -> audit trail
```

## Tools

- `subagent_status`
- `fetch_mcp_tools`
- `audit_tool_schema`
- `audit_tool_list`
- `audit_mcp_endpoint`
- `investigate_mcp_tool`

## Runtime bindings

Required:

```text
AI
WORKER_NAME
```

No Cloudflare API token is required for this Worker because it audits MCP tool surfaces over public/connected MCP endpoints.

## Endpoint allowlist

By default, endpoint fetching is limited to:

```text
*.workers.dev
agentfeedoptimization.com
*.agentfeedoptimization.com
```

This keeps endpoint audit useful for AFO Workers while avoiding arbitrary internal network fetch behavior.

## Read-only behavior

This Worker only calls MCP lifecycle/tool-list methods:

```text
initialize
tools/list
```

It does not call target MCP tools.
