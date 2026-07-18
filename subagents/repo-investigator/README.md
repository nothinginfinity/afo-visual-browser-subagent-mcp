# AFO Repo Investigator MCP

Reference first-wave sub-agent copied from the proven `afo-subagent-mcp` v0.5.0 implementation.

Worker name:

```text
afo-repo-investigator-mcp
```

Primary one-call tool:

```text
investigate_repo
```

## Purpose

Investigate GitHub repositories with an evidence-first pipeline:

```text
question -> probes -> plan -> grep -> evidence windows -> selected files -> synthesis -> audit trail
```

## Key tools

- `subagent_status`
- `list_repo_files`
- `grep_repo_plan`
- `grep_repo`
- `read_file_range`
- `ask_repo_light`
- `ask_files`
- `ask_repo`
- `investigate_repo`

## Required bindings

- `AI`
- `GITHUB_TOKEN`
- `DEFAULT_OWNER`
- `WORKER_NAME`

## Notes

This sub-agent remains repo-specific. Future first-wave agents should keep the investigation pipeline but swap the domain data source.
