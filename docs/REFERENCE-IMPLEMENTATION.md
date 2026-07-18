# Reference Implementation

`worker.js` currently remains the working repo-reader implementation cloned from `afo-subagent-mcp` v0.5.0.

This is intentional. The first version of this pattern repo preserves a proven implementation before domain-specific clones are created.

When making a new sub-agent:

1. Copy `worker.js`.
2. Rename the domain tool names.
3. Replace GitHub tree/file functions with the new domain data source.
4. Keep the pipeline structure.
5. Keep stage timings and audit fields.
6. Keep broad fallback behavior.
7. Keep deterministic evidence before model synthesis.

The reference implementation is repo-specific, but the architecture is domain-neutral.
