# Shared Investigation Layer

This folder is the future home for reusable logic shared by all first-wave AFO investigative sub-agents.

The initial repo keeps the full working logic inside each Worker for deployment simplicity. As the first wave grows, extract common pieces here.

Recommended shared modules:

```text
probe-extraction.js
stage-tracker.js
evidence-windows.js
model-synthesis.js
mcp-response.js
limits.js
```

## Extraction rule

Only move code into `shared/` after at least two sub-agents need it. Until then, keep each Worker self-contained so mobile MCP deploys stay simple.

## Core reusable contract

All sub-agents should preserve:

```text
question -> probes -> plan -> deterministic search -> evidence windows -> selected context -> synthesis -> audit trail
```
