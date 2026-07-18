# AFO Visual Browser Sub-Agent MCP Roadmap

## Mission

Build a deterministic visual QA and controlled browser-interaction service that can capture the real AFO Link Lane 3D universe at multiple device sizes, persist and retrieve the evidence, compare visual states, and execute bounded interaction sequences without exposing arbitrary browser automation.

## Current baseline

- Live Worker: `https://afo-visual-browser-subagent-mcp.jaredtechfit.workers.dev`
- Current Worker version: `0.2.0-phase1-evidence`
- Primary implementation: `src/worker.js`
- Deployment workflow: `.github/workflows/deploy-afo-visual-browser-subagent.yml`
- Existing tests: `test/url-policy.test.mjs`
- Primary live acceptance target: `https://afo-link-lane-v235-lab.jaredtechfit.workers.dev/`
- Lightweight control target: `https://afo-link-lane-v235-lab.jaredtechfit.workers.dev/debug/node-chat`

### Verified baseline capabilities

- [x] MCP initialize, ping, tools/list, and tools/call
- [x] Screenshot generation
- [x] HTML, Markdown, accessibility, console, network, and timing evidence
- [x] Mobile, tablet, desktop, wide, and custom viewports
- [x] R2 receipt and artifact persistence
- [x] D1 run and queue records
- [x] Vectorize evidence indexing
- [x] Queue producer and consumer
- [x] Analytics Engine events
- [x] Public read-only URL policy

### Confirmed Phase 1 gaps

- `capture_screenshot` still executes the full snapshot pipeline.
- Character-count truncation can exceed the UTF-8 byte limit.
- An oversized optional artifact can fail an otherwise valid screenshot.
- Artifact tools return object keys but not inspectable image or evidence content.
- No temporary artifact-view URL exists.
- No bounded click, type, keypress, scroll, drag, or multi-step interaction surface exists.

## Non-negotiable design rules

- Keep `public_readonly` as the default mode.
- Continue blocking localhost, private IPv4, private IPv6, credentials in URLs, and non-HTTPS targets.
- Never accept unrestricted JavaScript for evaluation.
- Never expose raw R2 object keys as permanent public URLs.
- Redact sensitive query parameters in every receipt, artifact index, log, and analytics event.
- A successful screenshot must not be invalidated by failure of an optional evidence artifact.
- Every release must pass local syntax/tests, workflow validation, live MCP protocol tests, and live target verification.
- Deployment success and runtime success must be reported separately.
- After each meaningful release, re-stone changed files, link `supersedes`, update the orientation stone, and move chain HEAD only after live verification.

---

# Release order

1. `v0.2.1-capture-reliability`
2. `v0.2.2-artifact-access`
3. `v0.3.0-controlled-actions`
4. `v0.4.0-session-visual-qa`
5. Future: `v0.5.0-visual-diff-and-analysis`

---

# v0.2.1 — Capture reliability

## Objective

Capture the full Link Lane 3D root page successfully at mobile, tablet, desktop, and wide viewports even when HTML or another optional artifact exceeds its storage limit.

## Feature 1 — True screenshot-only mode

### Exact tasks

- [ ] Split the current single `pipeline()` behavior into explicit capture modes:
  - `screenshot`
  - `snapshot`
  - `multi_viewport`
- [ ] In screenshot mode, collect only:
  - PNG
  - minimal page metadata
  - navigation timing
  - console/network counts
  - manifest
- [ ] Do not call `page.content()`, accessibility snapshot, Markdown generation, AI embedding, or full console/network artifact serialization in screenshot-only mode.
- [ ] Keep optional `delay_ms`, `wait_for_selector`, `wait_until`, custom viewport, and `full_page`.
- [ ] Preserve existing MCP tool name and input compatibility.
- [ ] Add manifest field `capture_mode`.
- [ ] Add manifest field `artifact_summary`.

### File-level change targets

- Modify `src/worker.js`
- Recommended extraction:
  - new `src/capture.js` for page launch, navigation, screenshot, and evidence collection
  - new `src/artifacts.js` for artifact persistence and size policy
- Modify `package.json` only if new test scripts or modules are introduced.
- Update `README.md` tool behavior documentation.

### Acceptance tests

- [ ] `capture_screenshot` against Link Lane root with:
  - `wait_for_selector: "#gc"`
  - `delay_ms: 5000`
  - `full_page: false`
  - iPhone `390x844`
- [ ] Repeat for tablet `820x1180`, desktop `1440x1000`, and wide `1920x1080`.
- [ ] Each run returns `ok: true`.
- [ ] Each run stores a PNG and manifest.
- [ ] Screenshot-only manifests contain no required HTML artifact key.
- [ ] Screenshot-only run remains successful when the page HTML exceeds 2 MiB.
- [ ] Existing `capture_snapshot` behavior remains available.

## Feature 2 — UTF-8 byte-safe truncation

### Exact tasks

- [ ] Replace character-count truncation for persisted text with a UTF-8 byte-aware helper.
- [ ] Ensure truncation never splits a multibyte character.
- [ ] Return truncation metadata:
  - original byte count
  - stored byte count
  - truncated boolean
- [ ] Apply the helper to HTML, Markdown, console, network, accessibility JSON, and manifest-safe error text.
- [ ] Keep screenshot size enforcement binary-safe.

### File-level change targets

- Modify `src/worker.js`, or place helpers in new `src/artifacts.js`.
- Add `test/artifact-limits.test.mjs`.

### Acceptance tests

- [ ] A string containing ASCII, emoji, accented characters, and CJK text is truncated below the exact byte limit.
- [ ] The decoded result is valid UTF-8.
- [ ] Stored content never exceeds the configured byte ceiling.
- [ ] Link Lane root snapshot no longer fails because character length differs from byte length.
- [ ] Unit test covers boundary values immediately below, at, and above the limit.

## Feature 3 — Partial-success artifact handling

### Exact tasks

- [ ] Classify screenshot and manifest as required artifacts.
- [ ] Classify HTML, Markdown, accessibility, console, and network evidence as optional artifacts.
- [ ] Persist optional artifacts independently.
- [ ] Record per-artifact states:
  - `stored`
  - `truncated`
  - `skipped_oversize`
  - `failed`
  - `not_requested`
- [ ] Return `status: "ok_with_warnings"` when required artifacts succeed but optional artifacts do not.
- [ ] Preserve the primary screenshot when later artifact work fails.
- [ ] Do not treat Vectorize failure as capture failure.
- [ ] Include warnings in D1 and receipt manifests.

### File-level change targets

- Modify `src/worker.js`
- Modify `migrations/0001_initial.sql` only if existing JSON fields cannot hold warnings; otherwise avoid schema churn.
- Prefer a new `migrations/0002_artifact_status.sql` only when normalized artifact rows are introduced.
- Add `test/capture-mode.test.mjs`.
- Add `test/partial-artifacts.test.mjs`.

### Acceptance tests

- [ ] Force an oversized optional HTML artifact and verify the PNG and manifest persist.
- [ ] Run result is `ok: true` with `status: "ok_with_warnings"`.
- [ ] Manifest identifies the exact skipped or failed artifact.
- [ ] D1 record remains queryable.
- [ ] Queue jobs acknowledge successful required capture even when optional artifacts fail.
- [ ] Vector indexing error is recorded but does not invalidate the screenshot.

## Release gate for v0.2.1

- [ ] `npm run check`
- [ ] `npm test`
- [ ] GitHub Actions workflow succeeds.
- [ ] Live `/status`, `/tools`, and MCP initialize/tools/list succeed.
- [ ] Link Lane root screenshots succeed at all four standard viewports.
- [ ] Actual PNG object sizes and dimensions are recorded.
- [ ] No code change is called successful until live receipts are read back.

---

# v0.2.2 — Artifact access

## Objective

Allow the connected assistant and authorized reviewers to retrieve, inspect, and temporarily view actual PNG and evidence artifacts.

## Feature 4 — `get_visual_artifact`

### Proposed MCP contract

Inputs:

- `investigation_id` or `run_id`
- `artifact_type`: `screenshot`, `html`, `markdown`, `accessibility`, `console`, `network`, or `manifest`
- optional `viewport`
- optional `response_mode`: `inline`, `metadata`, or `auto`

Outputs:

- run ID
- artifact type
- content type
- byte size
- SHA-256
- object key
- inline content when allowed
- `requires_url: true` when too large for safe inline return

### Exact tasks

- [ ] Add `get_visual_artifact` to MCP tools/list.
- [ ] Resolve only artifact keys already recorded in the persisted manifest.
- [ ] Reject arbitrary R2 key input.
- [ ] Return text artifacts as bounded text or structured JSON.
- [ ] Return small PNGs as MCP image content using base64 and MIME type.
- [ ] Enforce a conservative inline binary limit.
- [ ] Return metadata-only for oversized content.
- [ ] Add SHA-256 integrity metadata to new captures.
- [ ] Redact any sensitive URLs contained inside text evidence before return.

### File-level change targets

- Modify `src/worker.js`
- Recommended new `src/artifact-access.js`
- Add `test/artifact-access.test.mjs`
- Update `README.md`
- Update `.github/workflows/deploy-afo-visual-browser-subagent.yml` smoke tests to verify tools/list contains `get_visual_artifact`.

### Acceptance tests

- [ ] Retrieve the iPhone Link Lane screenshot as MCP image content when below the inline limit.
- [ ] Retrieve console and network JSON from the Node Chat audit.
- [ ] Reject a caller-supplied unregistered object key.
- [ ] Reject an unknown artifact type.
- [ ] Validate returned SHA-256 and byte size against R2.
- [ ] Confirm a missing artifact returns a typed `artifact_not_found` response.

## Feature 5 — Temporary signed artifact URLs

### Recommended design

Use a signed Worker route rather than making the R2 bucket public:

`GET /artifacts/{run_id}/{artifact_type}?expires={unix}&signature={hmac}`

The Worker validates the signature and expiry, resolves the artifact through the stored manifest, then streams the R2 object with strict headers.

### Exact tasks

- [ ] Add MCP tool `create_visual_artifact_url`.
- [ ] Add `ARTIFACT_SIGNING_SECRET` Worker secret.
- [ ] Sign run ID, artifact type, viewport, and expiry with HMAC-SHA-256.
- [ ] Default expiry to 10 minutes; enforce a maximum of 60 minutes.
- [ ] Add the signed artifact route.
- [ ] Set correct `Content-Type`.
- [ ] Set `Cache-Control: private, no-store`.
- [ ] Set `Content-Disposition: inline` for PNG and safe text.
- [ ] Prevent directory traversal and arbitrary key access.
- [ ] Do not include sensitive query values in logs or analytics.
- [ ] Return an explicit expiration timestamp.

### File-level change targets

- Modify `src/worker.js`
- Recommended new `src/signed-artifacts.js`
- Modify `wrangler.jsonc` only to document the required secret name; never commit the secret.
- Modify `.github/workflows/deploy-afo-visual-browser-subagent.yml` to verify the secret is configured and smoke-test URL generation.
- Add `test/signed-artifacts.test.mjs`
- Update `README.md`

### Acceptance tests

- [ ] Generate a temporary URL for a Link Lane PNG and load it before expiry.
- [ ] Verify it returns the exact stored bytes and content type.
- [ ] Verify expired URLs return `403`.
- [ ] Verify tampered run ID, artifact type, viewport, expiry, or signature returns `403`.
- [ ] Verify URLs cannot access an artifact not present in the run manifest.
- [ ] Verify the R2 bucket remains non-public.

## Release gate for v0.2.2

- [ ] All v0.2.1 gates remain green.
- [ ] Actual Link Lane mobile and desktop PNGs are inspectable in chat or through temporary URLs.
- [ ] Console and network evidence can be read, not merely counted.
- [ ] Signed URLs expire and fail closed.
- [ ] No permanent public artifact exposure is introduced.

---

# v0.3.0 — Controlled browser actions

## Objective

Interact with a page in one bounded browser run and capture before/after evidence without allowing arbitrary JavaScript.

## Feature 6A — Core action sequence

### Proposed MCP tool

`run_interaction_sequence`

Inputs:

- URL
- viewport
- wait options
- ordered `steps`
- capture policy: `before`, `after_each`, `final`, or combinations

Supported initial steps:

- `click`
- `type`
- `press_key`
- `scroll`
- `wait_for_selector`
- `wait_for_timeout`
- `capture`

Selector policy:

- CSS selectors only
- selector length limit
- no XPath initially
- optional coordinate clicks allowed only within viewport bounds
- no arbitrary JavaScript expressions

### Exact tasks

- [ ] Add an action schema validator.
- [ ] Limit step count, total timeout, text length, scroll distance, and capture count.
- [ ] Execute all steps inside one browser instance and one page.
- [ ] Record each step's start, finish, status, selector, and bounded error.
- [ ] Persist screenshots before/after selected steps.
- [ ] Persist a session manifest linking all step artifacts.
- [ ] Stop on failure by default; add explicit `continue_on_error`.
- [ ] Redact typed values when a selector or field name appears sensitive.
- [ ] Block file uploads, downloads, permission prompts, clipboard access, popups, and new-window navigation by default.
- [ ] Keep public mode read-only in intent: interactions may change in-page state but must not be used for authenticated or destructive workflows.

### File-level change targets

- Modify `src/worker.js`
- Add `src/actions.js`
- Add `src/action-policy.js`
- Add `test/action-validation.test.mjs`
- Add `test/action-redaction.test.mjs`
- Add `test/interaction-sequence.test.mjs`
- Update `migrations/0002_interaction_sessions.sql` or create `0003` if `0002` was used earlier.
- Update `README.md`

### Acceptance tests

- [ ] Open Link Lane root, wait for `#gc`, wait 5 seconds, and capture the initial 3D universe.
- [ ] Click `#magnetBtn`, capture after the click, and record the changed element state.
- [ ] Press `Escape` and capture the final state.
- [ ] On Node Chat, type non-sensitive test text into an allowed text control without submitting a destructive request.
- [ ] Invalid selectors fail with a typed validation error.
- [ ] More than the maximum step count is rejected before browser launch.
- [ ] A password/token-like field is redacted from receipts and logs.
- [ ] No action accepts raw JavaScript.

## Feature 6B — Extended bounded actions

### Exact tasks

- [ ] Add `hover`.
- [ ] Add `focus`.
- [ ] Add `select_option`.
- [ ] Add bounded `drag`.
- [ ] Add touch-compatible `tap` and `swipe`.
- [ ] Add element-state evidence:
  - visible
  - enabled
  - bounding box
  - role
  - accessible name
  - selected/checked/expanded state
- [ ] Add optional screenshot clipping to an element bounding box.

### Acceptance tests

- [ ] Drag on Link Lane's `#gc` canvas within a fixed bounded path.
- [ ] Swipe on the mobile viewport and capture the resulting state.
- [ ] Hover a stable control and capture.
- [ ] Element-state evidence matches the rendered control.
- [ ] Out-of-bounds coordinates and excessive drag distance are rejected.

## Release gate for v0.3.0

- [ ] All previous gates remain green.
- [ ] A repeatable Link Lane interaction sequence produces before/after PNGs.
- [ ] Every action is represented in the persisted session manifest.
- [ ] No unrestricted code execution is exposed.
- [ ] Failed actions produce inspectable evidence and do not silently pass.

---

# v0.4.0 — Session visual QA and responsive comparison

## Objective

Run reusable visual journeys across several viewports, compare results, and preserve a coherent investigation receipt.

## Exact tasks

- [ ] Add named visual recipes stored as validated JSON.
- [ ] Add `run_visual_recipe`.
- [ ] Support one recipe across up to six viewports.
- [ ] Add a parent investigation manifest linking every viewport and step.
- [ ] Add deterministic idempotency keys per recipe, target, viewport, and release.
- [ ] Add comparison metadata:
  - viewport dimensions
  - screenshot dimensions
  - page dimensions
  - control counts
  - console/network error deltas
  - element bounding-box deltas
- [ ] Add `compare_visual_receipts` for metadata comparison first.
- [ ] Add pixel/image difference only after artifact retrieval is stable.
- [ ] Add queued recipe execution for post-deploy audits.
- [ ] Add retention and deletion policy fields.

### File-level change targets

- Add `src/recipes.js`
- Add `src/comparison.js`
- Modify `src/worker.js`
- Add `test/recipe-validation.test.mjs`
- Add `test/comparison.test.mjs`
- Add migration for recipe/session metadata if needed.
- Update deployment workflow with a queued Link Lane smoke recipe.
- Update `README.md`

### Initial Link Lane recipes

#### `link_lane_initial_render`

- Navigate to Link Lane root.
- Wait for `#gc`.
- Wait 5 seconds.
- Capture viewport-only screenshot.
- Collect console/network evidence.
- Run on mobile, tablet, desktop, and wide.

#### `link_lane_magnet_toggle`

- Navigate to Link Lane root.
- Wait for `#gc`.
- Capture before.
- Click `#magnetBtn`.
- Capture after.
- Verify the control state changed.

#### `node_chat_responsive_smoke`

- Navigate to `/debug/node-chat`.
- Capture mobile and desktop.
- Record control count, overflow, console, and failed responses.
- Retrieve the actual screenshots and error evidence.

### Acceptance tests

- [ ] A single call executes `link_lane_initial_render` across four standard viewports.
- [ ] The parent receipt links all child receipts and screenshots.
- [ ] The assistant can retrieve and inspect all four images.
- [ ] Comparison reports viewport-specific overflow and control-position changes.
- [ ] A queued post-deploy run completes and is retrievable by investigation ID.
- [ ] Repeating an idempotent recipe does not create duplicate work unintentionally.

## Release gate for v0.4.0

- [ ] Real 3D Link Lane screenshots are captured, retrieved, and inspected across all standard viewports.
- [ ] At least one controlled interaction flow works on Link Lane.
- [ ] Layout and evidence differences can be summarized from one parent investigation.
- [ ] Queued visual QA can run after deployment.
- [ ] Retention behavior is documented and verified.

---

# Future v0.5.0 — Visual diff and AI analysis

Do not begin until the six core features above are live and stable.

- Pixel and perceptual screenshot comparison
- Configurable visual-difference thresholds
- Element-level layout regression detection
- Workers AI vision analysis
- Evidence-grounded findings with confidence and artifact references
- Similar-regression search through Vectorize
- Baseline promotion and explicit approval flow
- Historical visual time travel

---

# File map

## Existing files to modify

- `src/worker.js`
  - MCP registration
  - capture routing
  - receipts
  - queue consumer
  - status/version
- `test/url-policy.test.mjs`
  - preserve all URL safety behavior
- `package.json`
  - version and test scripts
- `README.md`
  - public tool contracts and examples
- `ROADMAP.md`
  - canonical implementation order and completion status
- `wrangler.jsonc`
  - bindings and documented secret names
- `.github/workflows/deploy-afo-visual-browser-subagent.yml`
  - deterministic checks, deploy, protocol smoke tests, live Link Lane audits
- `migrations/`
  - only when new normalized session/artifact state cannot fit existing JSON fields

## Recommended new modules

- `src/capture.js`
- `src/artifacts.js`
- `src/artifact-access.js`
- `src/signed-artifacts.js`
- `src/action-policy.js`
- `src/actions.js`
- `src/recipes.js`
- `src/comparison.js`

## Recommended new tests

- `test/artifact-limits.test.mjs`
- `test/capture-mode.test.mjs`
- `test/partial-artifacts.test.mjs`
- `test/artifact-access.test.mjs`
- `test/signed-artifacts.test.mjs`
- `test/action-validation.test.mjs`
- `test/action-redaction.test.mjs`
- `test/interaction-sequence.test.mjs`
- `test/recipe-validation.test.mjs`
- `test/comparison.test.mjs`

---

# Definition of done for every release

1. Inspect the current CairnStone chain manifest and HEAD.
2. Read current repo files and workflow before editing.
3. Implement only the scoped release.
4. Run `npm run check`.
5. Run `npm test`.
6. Validate workflow YAML and deployment assumptions.
7. Commit and push.
8. Inspect the actual Actions run and job steps.
9. Test live `/status`, `/tools`, and `/mcp`.
10. Execute the release-specific Link Lane acceptance test.
11. Retrieve persisted receipts and actual artifacts.
12. Separate deployment success from runtime success.
13. Re-stone changed source, tests, workflow, README, and roadmap.
14. Link new revisions with `supersedes`.
15. Create a verification/orientation stone.
16. Move chain HEAD only after live behavior is verified.
17. Record unresolved infrastructure limitations separately from code findings.

---

# New-chat handoff prompt

```text
@CairnStone v5 ⛰️🪨⛰️🪨⛰️🪨
@AFO GitHub API MCP 👾 👾
@AFO-gitZip
@🖥️ afo-visual-browser-subagent-mcp

Continue the afo-visual-browser-subagent-mcp project.

Start by opening the CairnStone chain:

afo-visual-browser-subagent-mcp

First call:

cairnstone_get_chain_manifest(chain="afo-visual-browser-subagent-mcp")

Use the graph and HEAD, not timestamps.

Repo:

nothinginfinity/afo-visual-browser-subagent-mcp

Branch:

main

Primary Worker:

src/worker.js

Roadmap:

ROADMAP.md

Deployment workflow:

.github/workflows/deploy-afo-visual-browser-subagent.yml

Live Worker:

https://afo-visual-browser-subagent-mcp.jaredtechfit.workers.dev

Primary live acceptance target:

https://afo-link-lane-v235-lab.jaredtechfit.workers.dev/

Lightweight control target:

https://afo-link-lane-v235-lab.jaredtechfit.workers.dev/debug/node-chat

Known current Worker version before this roadmap is implemented:

0.2.0-phase1-evidence

Known current source stone:

642481155e43158d9a78b551fb7597bd5a08f2e3be174aaaf0a85a40cd104e1e

Known current orientation HEAD before this roadmap update:

dfd20f79d599fcce31a723c2011f5e51acdceec9492c28d24601f441cec9a620

Live Link Lane compatibility review stone:

24502ad0971d5aefaa87997a9582319b5d47a65b63b4b39e77ca86c4bd5321ef

Task:

1. Confirm the current chain HEAD and current repo commit.
2. Read ROADMAP.md and inspect the current src/worker.js, tests, package.json, wrangler.jsonc, and deployment workflow.
3. Begin only the next incomplete release in the roadmap.
4. The first intended release is v0.2.1-capture-reliability:
   - true screenshot-only mode
   - UTF-8 byte-safe truncation
   - partial-success optional artifact handling
5. Do not implement interaction tools before capture reliability and artifact retrieval are verified.
6. Add exact tests from the roadmap.
7. Run local syntax/tests.
8. Push through gitZip.
9. Inspect the real Actions run and logs.
10. Test the live MCP protocol and Link Lane root at mobile, tablet, desktop, and wide.
11. Retrieve receipts and verify actual PNG persistence.
12. Do not claim success from deployment status alone.
13. Re-stone changed files, link supersedes/documents/reviews edges, update orientation, and move HEAD only after live verification.
14. Surface infrastructure issues separately and do not silently work around them.
```
