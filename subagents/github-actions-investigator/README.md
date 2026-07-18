# GitHub Actions Investigator

Read-only MCP subagent for GitHub Actions and CI/CD investigation.

## Worker

`afo-github-actions-investigator-mcp`

## Scope

This subagent answers the recurring investigation question:

Did the workflow run, did it fail, and where?

It reads:

- workflow inventory
- recent workflow runs
- run status, conclusion, branch, event, and head SHA
- job and step status
- failed job log excerpts
- workflow YAML trigger context
- runs associated with a commit SHA

It does not mutate GitHub, dispatch workflows, rerun jobs, edit files, or deploy anything.

## Tools

- `subagent_status`
- `list_workflows`
- `list_workflow_runs`
- `inspect_workflow_run`
- `read_job_log`
- `read_workflow_file`
- `find_runs_for_sha`
- `investigate_actions_failure`

## Defaults

- owner: `nothinginfinity`
- repo: `afo-visual-browser-subagent-mcp`

`GITHUB_TOKEN` or `GH_TOKEN` may be configured as a Worker secret for private repositories or higher API limits.
