# Template Mapping Guide

The current Worker is the repo-reader reference implementation. Use this mapping when cloning it into another domain.

| Reference repo tool | Generic role | New sub-agent examples |
|---|---|---|
| `subagent_status` | Health/status | same name |
| `list_repo_files` | Enumerate scope | `list_workers`, `list_tables`, `list_objects`, `list_chain_stones` |
| `grep_repo_plan` | Estimate search coverage | `plan_worker_search`, `plan_schema_search`, `plan_object_search` |
| `grep_repo` | Deterministic search | `search_worker_source`, `search_schema`, `search_receipts` |
| `read_file_range` | Pull evidence window | `read_worker_range`, `sample_rows`, `read_receipt`, `expand_stone` |
| `ask_repo_light` | Broad orientation | `ask_worker_light`, `ask_database_light`, `ask_chain_light` |
| `ask_files` | Synthesis over selected evidence | `ask_worker_evidence`, `ask_database_evidence`, `ask_chain_evidence` |
| `ask_repo` | Deep synthesis | `ask_worker`, `ask_database`, `ask_chain` |
| `investigate_repo` | One-call pipeline | `investigate_worker`, `investigate_database`, `investigate_chain` |

## Tool description rule

The tool descriptions are part of the agent interface. Write them as instructions to future agents.

Good description pattern:

```text
Use this first for broad orientation. For specific symbols/features, prefer investigate_*.
```

Good one-call investigation description:

```text
One-call auto flow for questions about a specific feature, symbol, table, route, object, or implementation status. Internally plans, searches, reads evidence, and synthesizes. Reports probes, scanned candidates, hits, and timings.
```
