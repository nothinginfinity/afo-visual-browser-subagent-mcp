# Sub-Agent Clone Checklist

Use this when creating a new AFO sub-agent MCP from this template.

## 1. Name the domain

Choose the investigation scope:

- GitHub repo
- Cloudflare Worker
- D1 database
- R2 bucket
- MCP tool surface
- deploy receipts
- CairnStone chain
- message thread
- customer site

## 2. Rename the public tool surface

Keep the shape, change the domain words.

Example:

```text
investigate_repo -> investigate_worker
list_repo_files -> list_workers
read_file_range -> read_worker_range
grep_repo_plan -> plan_worker_search
grep_repo -> search_worker_source
ask_files -> ask_worker_evidence
```

## 3. Keep the internal pipeline

Every clone should preserve:

```text
question -> probe extraction -> plan -> deterministic search -> evidence windows -> selected context -> model synthesis -> audit trail
```

## 4. Preserve audit fields

Return:

- flow
- probes
- candidates
- scanned
- hits
- selected evidence
- files or records read
- timings
- stats

## 5. Make broad questions safe

If the question has no useful probes, use a light orientation flow and say so.

## 6. Make specific questions evidence-first

If the question names a symbol, route, feature, table, version, Worker, tool, or file, search deterministically before calling the model.

## 7. Clone only after the one-call tool works

The sub-agent is ready when the main `investigate_*` call can handle both:

- a broad orientation question
- a specific implementation question with exact evidence
