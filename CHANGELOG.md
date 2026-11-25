# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0]

### Added

- **monorepo cross-package boundaries (`checks.boundaries.workspace: "auto"`).** A second
  dependency-cruiser pass scans every workspace package and flags relative imports that
  cross a package boundary (`boundaries/workspace-cross-package`, file-level like all
  boundary results). Your own `.dependency-cruiser.cjs` is untouched and package-name entry
  imports are allowed. `init` writes `auto` when it detects a workspace plus a
  dependency-cruiser config; existing configs keep the `off` default.
- Tests (`test/workspace-boundaries.test.js`) cover the edge filter, root-package exclusion,
  config generation, `init` wiring and invalid values; the v4 verification runs a real
  dependency-cruiser over a two-package workspace (cross import caught, intra-package and
  package entry imports allowed).
- **Structured acceptance criteria.** `task_criteria` now requires `type`
  (`ui` / `interaction` / `data` / `tracking` / `compat` / `performance`) and `source` on
  every criterion, with optional `verify` (`gate` / `test` / `manual`) plus `testFile` /
  `evidenceFile`. `verify` defaults from the provided fields, conflicting combinations are
  rejected, and an all-`ui` contract returns a warning instead of blocking.
- **Human confirmation and release todos.** `npx fe-guard task confirm <id> --note "..."`
  records `criterion.confirmed` for `assumption` criteria (must be after the criterion was
  declared); `npx fe-guard task defer <id> --reason "..."` records `criterion.deferred`.
  Delivery continues but is marked `degraded`, and completion lists deferred criteria
  separately. Neither command exists as an MCP tool.
- **Evidence instead of claims.** Every gate writes
  `.fe-guard/evidence/<taskId>/<evidenceId>.json`; `task_gate` returns `evidencePath` and
  `task_status` exposes `lastEvidencePath`. `verify: manual` records `{ file, bytes, sha256 }`
  and blocks on a missing or empty file. Responses include
  `completion: { achieved, total, remaining, deferred }` and report "N done / M deferred" —
  never "all done".
- **Environment preflight.** `workflow.preflight: { command, timeoutMs }` (empty command =
  off) runs before `task_start` (failure creates no task) and before every gate (failure is
  recorded as `preflight.failed` and the check is reported as "not executed").
- **Rework diff.** Gate evidence stores violation fingerprints (capped at 100) and returns
  `trend: { previousNew, fixed, introduced }`; new violations after a failed run add a
  regression blocker.
- **Retrospectives.** The 8th MCP tool `task_lesson` (text / evidence / scope) appends to
  `.fe-guard/lessons.jsonl`; `workflow.distill` defaults to `enforce`, blocks delivery until
  a lesson is recorded after the last failed gate, and supports `warn` / `off`.
- **Workflow effect stats.** Read-only `fe-guard task stats [--json]` aggregates the current
  task plus `.fe-guard/tasks/` archives: delivered / degraded / active, gate failure rate,
  average gates per task, top blockers, lessons and deferred criteria.
- Tests cover structured criteria, confirm / defer, manual evidence and snapshots, preflight
  (pass / fail / timeout), rework diff, lessons / distill and stats; `npm test` passes 174
  and `verify-v2.mjs` reaches 135 checks (including preflight + snapshot + lesson delivery).

### Changed

- Tool count is 8: 7 `task_*` (`start` / `criteria` / `plan` / `next` / `gate` / `status` /
  `lesson`) plus `ui_lookup`.
- **AGENTS.md snippet and Trae / Cursor rules** now state the hard rules: criteria need
  `type` + `source`, assumptions need a human `task confirm`, failed gates need
  `task_lesson`, only "N done / M deferred" may be reported, and a preflight failure means
  the check did not execute. The snippet stays under the 600-token cap (~591 measured).
- Slash commands now point at blockers (regression, unconfirmed assumptions, missing manual
  evidence, required lesson) and remind the model that `confirm` / `defer` are CLI-only.
- New config fields: `workflow.preflight` and `workflow.distill`; invalid values exit with
  code 2 like the other config errors. `distill` defaults to `enforce`, so a task with a
  failed gate now needs a `task_lesson` before delivery — set it to `warn` or `off` to opt out.

### BREAKING

- **`task_criteria` requires `type` and `source`.** Any MCP client or script calling the tool
  with `{ text }` only will be rejected. Historical `task.json` events still replay — missing
  fields are shown as `unknown` / empty arrays — but new declarations are strictly validated.

### Fixed

- **Storybook stories and test files are no longer treated as components.** Repeated
  `Default` story exports produced dozens of phantom `ui/duplicate-name` errors on real
  React repos (56 in Bulletproof React). `*.stories.*` / `*.story.*` / `*.test.*` /
  `*.spec.*` and `__tests__` / `__mocks__` / `e2e` directories are excluded from the
  component inventory.
- **Subdirectory projects compare the right `package.json`.** New-dependency detection
  read the git-root manifest, so every app dependency looked unregistered (30 in
  Bulletproof React). It now uses `git show <base>:./<path>` relative to the analysed
  project root.
- **A workspace package fully ignored by ESLint is skipped instead of aborting the gate.**
  ESLint exits 2 when every file is ignored (common when the root flat config excludes a
  docs/site package). That package is recorded as `skipped` in timings; a restored real
  lint range still catches violations.
- **`pnpm-workspace.yaml` listing `"."` runs the root package once.** The root entry is
  deduplicated instead of executed twice (ESLint + TypeScript).

## [0.3.0]

### Added

- **`check --format sarif`** emits SARIF 2.1.0 for GitHub Code Scanning. It contains only
  new violations plus `not-executed` results (legacy debt stays in the baseline, so the
  alerts page matches what the gate fails on). Boundaries results are file-level — no line
  numbers are fabricated. `not-executed` keeps `level: error` and also sets
  `executionSuccessful: false` with a tool notification. `--json` remains an alias for
  `--format json`; the report object and `.fe-guard/report.json` are unchanged.
- Tests (`test/sarif.test.js`) cover the mapping, known filtering, the `not-executed`
  representation, URI prefix/encoding, a real `tsc` run and argument validation; the v2
  verification adds a real-ESLint SARIF scenario.
- **`check --format html`** writes a single self-contained report next to `report.path`
  (`.fe-guard/report.html`), prints only its path and keeps the exit code. CSS and the
  filter script are inlined — no external assets, and the full table renders without
  JavaScript. It shows every violation (new / known / `not-executed`), each check's status,
  the baseline trail and timings.
- Tests (`test/html.test.js`) cover escaping, zero external references, no-JS readability,
  path derivation and a real `tsc` end-to-end run.
- **`baseline --trend [--limit <n>]`** reads the committed history of the baseline file and
  prints per-commit totals, deltas, ratchet-key counts and explicit widens; `--json` returns
  the series. It writes nothing and adds no second source of truth. Missing git, an untracked
  baseline or a shallow clone degrade with a clear message instead of failing the gate.
- **`task events --summary`** aggregates the event stream read-only: counts by type, gate
  outcomes and modes, worst single-run new-violation count, rejected calls by tool and
  reason, criteria coverage and delivery state. `--json` exposes the same digest.
- Tests (`test/trend.test.js`, `test/task-summary.test.js`) cover deltas, widen counting,
  `--limit` truncation, no-git / not-tracked degradation, argument conflicts and the
  summary dimensions.

### Fixed

- **Files ignored by ESLint no longer produce phantom violations.** ESLint emits a
  `ruleId: null` warning for explicitly listed files matched by `ignores` (or with no
  matching flat-config block); the adapter mapped it to `eslint/parse-error` and counted it
  as a new violation on every `--staged` / `--diff-only` run. Those notices are now
  dropped — the file is outside the project's lint scope, same as a non-source extension.
  Real parse errors stay `eslint/parse-error`, unused `eslint-disable` directives become
  `eslint/unused-disable-directive`, and any other rule-less ESLint message is preserved
  as `eslint/no-rule` instead of masquerading as a parse error. No `--no-ignore` override
  is used.
- Regression tests (`test/eslint-classify.test.js`) plus a real-ESLint verify-v2 scenario
  (staged + full) cover the classification and prove real lint errors are still caught.

## [0.2.0]

### Added

- **`init` probes the project before writing the config.** Checks whose prerequisites are
  missing are written as `enabled: false` and printed, instead of aborting the first `check`:
  no `tsconfig.json` (root or any workspace package) disables `typescript`, no ESLint config
  disables `eslint`, and no `.dependency-cruiser.{cjs,js,json}` disables `boundaries` while
  pointing `args` at the file that actually exists. `.vue` files and the detected workspace
  topology are reported. A plain JavaScript project now passes its first `check`.
  Existing configs are never re-probed unless `--force` is passed.
- Regression tests (`test/init-detect.test.js`) cover plain-JS, fully configured, monorepo,
  `--force`, and Vue projects.
- **`init --preset js|vue|legacy|monorepo`** sets the starting tone of the generated config
  before probing runs. `js` disables `typescript`/`ui`; `vue` writes the `vue-tsc` auto-switch
  explicitly; `legacy` loosens rot thresholds (800 lines/file, 150-line functions, 50 `any`,
  duplication 0.6) and large-diff budgets (40 files / 1200 lines); `monorepo` writes
  per-package `workspace: "auto"` and a 40-file / 1000-line budget. A preset never re-enables
  a check the probe disabled, and the probe never changes a preset threshold.
- **`init --dry-run`** prints every file it would create or update, with its content, and
  writes nothing — useful for previewing a preset on an existing repo. Mismatched presets
  (e.g. `--preset js` on a repo with `.vue` files) are reported, and a `--preset` without
  `--force` on an existing config is ignored with an explicit notice.
- Regression tests (`test/init-preset.test.js`) cover the four presets, preset ↔ probe
  ordering, unknown presets, and `--dry-run` (nothing on disk, preview shows the content).
- **Project-level MCP configs for five clients.** `init` now also writes `.mcp.json`
  (Claude Code), `.vscode/mcp.json` (VS Code: `servers` + `"type": "stdio"`) and
  `.gemini/settings.json` (Gemini CLI), alongside the existing Trae / Cursor files.
  Each file merges only its own `fe-guard` entry — other servers and unrelated settings
  keys are preserved, invalid JSON is rejected instead of overwritten, and user-home
  configs are never touched. `--dry-run` previews all of them.
- Regression tests (`test/init-clients.test.js`) and the v2 verification cover the five
  clients, the VS Code schema difference, merge/idempotency, invalid JSON and `--dry-run`.

## [0.1.1]

### Fixed

- **Vue projects no longer silently skip `.vue` type checking.** `init` used to write
  `"bin": "tsc"` for the `typescript` check, which overrode the auto-switch and made
  `.vue` diagnostics disappear (a real type error in a `.vue` file could pass the gate).
  The default config now leaves `bin` unset, so Vue projects really run `vue-tsc`.
  Configs that explicitly set `"bin": "tsc"` keep their behavior but now print a warning
  that `.vue` files are not type-checked.
- **Vue + TypeScript 7 fails fast with a clear message** instead of a vue-tsc crash reported
  as "check not executed": TypeScript 7 (the Go-native compiler) no longer exports
  `typescript/lib/tsc`, which every vue-tsc release resolves at startup.

### Changed

- `vue-tsc` 3.x is verified and supported (with TypeScript 5.x); devDependency bumped to 3.3.14.
- Non-Vue projects can use TypeScript 7 directly — the `tsc` diagnostic format is unchanged.
- New regression tests (`test/v63.test.js`) cover the default-config auto-switch, the
  TypeScript 7 guard, and the explicit-`bin` warning.

## [0.1.0]

First public release — consolidates the full feature set built during internal iterations.

### Added

- Check layer: orchestration of ESLint / TypeScript / dependency-cruiser plus four built-in
  checks (`deps`, `ui`, `metrics`, `diff-size`), normalized into one violation shape.
- Dual-track baseline ratchet: per-(file, rule) counts and per-(file, metric) maxima;
  only tightens, never loosens; `firstSeen` / `widenLog` audit fields; `baseline --verify`
  blocks unregistered widening against merge-base; `--follow-renames` migrates ledger keys.
- MCP workflow layer: contract → criteria → plan → implement → verify → deliver, with stages
  derived from append-only events (no "set stage" entry point); acceptance criteria can bind
  a `testFile` that the gate really runs.
- `fast` / `full` profiles, `doctor`, `baseline --show --by-rule`, false-positive recording
  and suggestions, tarball distribution, config/baseline schema validation.
- monorepo support: per-package ESLint / TypeScript runs with each package's own config;
  `metrics.overrides` per-directory thresholds; `metrics.duplication.normalizeIdentifiers`
  (opt-in) resists copy-and-rename duplication.
- Vue support: automatic `vue-tsc` switching; `boundaries` detects an incomplete Vue
  dependency graph and reports a non-baselineable `boundaries/not-executed` instead of a
  false pass.
- Subdirectory root support: when the project root is not the git root, `--staged`,
  `diff-size`, rename migration and `--verify` all use correct path semantics.
- Honest engineering: `not-executed` violations are non-baselineable; skipped ≠ passed;
  staged snapshot; subprocess timeout ceiling.

### Pre-release history

Internal iterations v1–v6.2 progressively built the capabilities above (external-check
orchestration, the MCP workflow, the four built-in checks, monorepo/Vue support,
subdirectory roots, and the "no false pass" fixes). 0.1.0 is the first public release and
includes all of them; the public version counter restarts here.
