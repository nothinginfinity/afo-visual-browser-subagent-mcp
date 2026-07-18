# AFO Visual Browser Sub-Agent MCP

Reusable MCP template for building AFO sub-agents that answer from gathered context instead of guessing.

This repo was cloned from `nothinginfinity/afo-subagent-mcp` and keeps the working repo-reader implementation as the first reference pattern.

## Pattern

```text
question -> probes -> plan -> search -> evidence windows -> selected context -> synthesis -> audit trail
```

## Reference tools in this clone

- `subagent_status`
- `list_repo_files`
- `grep_repo_plan`
- `grep_repo`
- `read_file_range`
- `ask_repo_light`
- `ask_files`
- `ask_repo`
- `investigate_repo`

## How to clone this for a new sub-agent

Keep the same internal flow, then swap the domain layer.

Examples:

- repo files become Worker source, D1 tables, R2 objects, CairnStone chain records, messages, receipts, or site artifacts
- grep becomes the domain search method
- file ranges become source ranges, SQL rows, object metadata, event slices, or chain stone expansions
- `investigate_repo` becomes `investigate_worker`, `investigate_database`, `investigate_chain`, or another domain-specific investigation tool

## Build guide

See `docs/PATTERN.md` for the full template contract and clone checklist.
