# AFO Visual Browser Sub-Agent MCP

This repo is the reusable template for AFO sub-agent MCPs.

The core pattern is:

1. Extract probes from the user question.
2. Plan the searchable scope before reading heavy content.
3. Search deterministically across ranked candidates.
4. Pull narrow evidence windows from actual hits.
5. Read only the files or records that matter.
6. Synthesize an answer from evidence.
7. Return an audit trail with flow, probes, candidates, scanned items, evidence windows, files read, timings, and limits.

## Standard tool shape

Every clone should keep a similar surface:

- `subagent_status`
- `list_scope`
- `plan_scope_search`
- `search_scope`
- `read_evidence_range`
- `ask_evidence`
- `ask_scope_light`
- `investigate_scope`

Repo-specialized names may stay domain specific, such as `list_repo_files`, `grep_repo_plan`, `grep_repo`, `read_file_range`, `ask_files`, and `investigate_repo`.

## Domain blanks to fill

When cloning this template, define:

- scope type: repo, Worker, D1, R2, message thread, deploy chain, CairnStone chain, customer site, etc.
- list function: how the agent enumerates candidates.
- plan function: how the agent estimates coverage and budget.
- deterministic search: exact match, SQL search, metadata search, log search, vector search, or hybrid.
- evidence window: line range, row sample, object metadata, event receipt, or API response slice.
- synthesis prompt: answer only from gathered evidence and state missing evidence clearly.

## Response contract

The highest-value response shape is:

```json
{
  "ok": true,
  "answer": "...",
  "flow": "grep_first | light_fallback | evidence_first | schema_first",
  "evidence": {
    "probes": [],
    "windows": []
  },
  "plan": {
    "candidates": 0,
    "scanned": 0,
    "files_with_hits": []
  },
  "stats": {},
  "timings": {}
}
```

## Clone targets

Good next clones:

- Cloudflare Worker investigator
- D1 schema/data investigator
- R2 object investigator
- MCP tool auditor
- deployment receipt investigator
- CairnStone chain investigator
- Message OS thread investigator

The goal is that ChatGPT, Claude, or a mobile client can call one `investigate_*` tool and get evidence-grounded help without manual grep/read/ask sequencing.
