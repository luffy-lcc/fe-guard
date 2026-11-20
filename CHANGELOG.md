# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
