# Design trade-offs and architecture

[← Back to README](../README.md) · [简体中文](zh/design.md)

## What problem it solves

Conventions written in docs rely on human memory; turn on full lint and hundreds of legacy issues make the team disable the check outright; warn without blocking is the same as nothing.

fe-guard's idea is plain:

1. **Don't rebuild checkers.** ESLint, tsc, and architecture-boundary tools are already good enough; fe-guard only orchestrates them and normalizes the output.
2. **Freeze historical debt; don't demand paying it off at once.** Legacy violations go into the baseline, the check turns green immediately, and the team's question shifts from "should we enable the check" to "how do we stop getting worse".
3. **New violations must block.** Enforced by exit code, not verbal agreement — local hooks and any pipeline can use it directly.
4. **Only allow getting better.** Fix one piece of debt and the baseline auto-tightens; quiet regression is not allowed.

It doesn't chase "conventions are everything". It does one thing: make "no worse than before" automatic.

## Design trade-off notes

- **Zero runtime dependencies**: the only external dependencies are the tools being checked. When a tool breaks, fe-guard gives a clear message instead of a stack trace.
- **One config controls everything**: `enabled`, per-check `enabled`, `level`, `autoTighten`, `workflow.enabled` are all plain fields — operable without understanding the internals.
- **Workflow as tools, not prompts**: a model "voluntarily complying" is unverifiable. Stages, criteria fulfillment, and gate results are all recorded as events, with decisions in code — only then can they be tested and audited.
- **Events, not state**: `task.json` is append-only events; the current stage is derived by `reduce()`. With no "set stage" entry point, there's no attack surface for "marking a stage as passed".
- **Generated artifacts share one source**: AGENTS.md, Trae rules, Cursor rules, commands, and hooks are all rendered from `src/ide/source.js`; change one place and nothing drifts.
- **No premature abstraction**: no plugin interface, no event bus, no task queue. The seven runners are each written standalone; what's duplicated is a dozen lines of argument assembly, and what you get is code you understand the moment you open the file.
- **New checks don't change old repos by default**: an old config without the new check's section means it's off after upgrade. Add it explicitly to use it — no "upgrade a version and suddenly everything is red".
- **Values ride a separate ratchet track**: `metrics` records "allowed maxima", not counts. Both tracks share tighten-only semantics but are stored separately.
- **Large diffs stay out of the baseline**: a large diff is "an event of this change"; recording it would permanently disable the gate. `diff-size` is explicitly listed as baseline-exempt.
- **The component inventory doesn't live in context**: it's written to disk and the AI queries it on demand via `ui_lookup`. Paying resident tokens for occasionally-used information is a bad trade, and the inventory grows with the project — any cached copy goes stale on update.
- **Failure still leaves evidence**: even when the check fails, the report, baseline tightening, and gate evidence are produced as usual, for post-mortems.

## package-level baseline design

- **Ledger layout is opt-in and additive.** `baseline.strategy` defaults to `root` (one ledger, unchanged behavior). `"package"` keeps root-level files in `baseline.path` and writes every workspace package's files to `<package>/<baseline.packageFile>`. Keys stay repo-relative, so comparison, tightening and `--verify` reuse the same core as root mode.
- **Ownership is deterministic.** A file belongs to the package with the longest matching prefix; everything else belongs to root. One file has exactly one owner, so entries cannot be counted twice across ledgers, and `combineLedgers` rejects duplicates instead of picking a winner.
- **One evaluation, per-package write-back.** `check` combines the ledgers into one view, evaluates the run once, then splits the next entries / ratchets back by owner and writes only ledgers that changed; a non-existent empty ledger is never created. `baseline` aborts before any write when a blocking entry lacks `--widen`, so no package is left half-updated.
- **Migration preserves audit fields.** `--migrate-packages` keeps `firstSeen`, appends `initial-adoption` (so a brand-new package ledger can pass `--verify`) and a `migrate-packages` event naming source and target. Conflicts exit 2 without writing, because choosing a value automatically would silently wipe one side's history.
- **Stale-root guard.** Root entries that belong to a package make `check` / `baseline` fail before evaluating anything. The alternative — ignoring them — would silently unfreeze debt, so the guard is a deliberate hard stop with a migration hint.

## Workflow evidence model

The workflow layer turns "done" into facts that can be checked:

- Every criterion must state its source and type; assumptions are confirmed by a human and cannot be delivered unconfirmed.
- Verification is `gate` / `test` / `manual`: tests really run, manual evidence must exist and be non-empty, and its sha256 is recorded.
- Every gate writes a snapshot (mode, exit code, completion, violation fingerprints, preflight result); a failed gate requires a lesson.
- `completion` splits covered / deferred / pending; deferred items and remaining criteria are always reported.
- Environment preflight is whatever command the project configures; a failure means "this check was not executed".

Deliberately not done: visual / screenshot diff, browser / dev-server / login-state preflight, spec distribution and sub-agent orchestration, mobile / real-device checks. See the [roadmap](roadmap.md) for why and what would trigger each.

## Directory layout

```
fe-guard/
├── bin/
│   ├── fe-guard.js              entry point (parses args, dispatches commands)
│   └── fe-guard-mcp.js          MCP server entry (the IDE mounts it)
├── src/
│   ├── cli.js                   CLI and help
│   ├── config.js                config loading, defaults, switch resolution, workflow normalization, defaults for the seven checks
│   ├── detect.js                project probing for init (tsconfig / ESLint / dependency-cruiser / .vue / workspaces)
│   ├── presets.js               init presets (js / vue / legacy / monorepo): knob defaults before probing
│   ├── profiles.js              built-in fast / full profiles
│   ├── not-executed.js          the "check not executed" violation type (non-baselineable)
│   ├── check-core.js            check kernel shared by CLI and MCP gate; routes the count/value tracks
│   ├── baseline.js              ratchet core: count/value comparison, tightening, disk format (pure functions, unit-tested)
│   ├── baseline-packages.js     package-mode ledgers: layout, owner split, migrate plan, stale-root guard
│   ├── workspace.js             monorepo detection, per-package planning, config and bin resolution
│   ├── workspace-boundaries.js  monorepo cross-package rules (generated depcruise config + edge filter)
│   ├── timing.js                per-check and per-package timing
│   ├── feedback.js              false-positive records: append, read, summarize
│   ├── metrics.js               rot metrics: line counts, function length, any count, token n-gram duplication rate
│   ├── inventory.js             component extraction and inventory: parse props/emits, rebuild inventory, duplicate-implementation detection
│   ├── git.js                   changed-file collection
│   ├── report.js                report generation and terminal output (by default lists only new violations)
│   ├── trend.js                 read-only baseline history from git (no second source of truth)
│   ├── sarif.js                 report → SARIF 2.1.0 (new violations + not-executed only)
│   ├── html.js                  single-file HTML report (inline CSS/JS, zero external assets)
│   ├── version.js               tool version shared by SARIF / HTML / --version
│   ├── commands/                init / check / baseline (+ baseline-shared.js core) / feedback / doctor / task
│   ├── workflow/                workflow core: state.js (events / stages) / definitions.js (tool schemas) /
│   │                            criteria.js (type / source / verify) / evidence.js (snapshots + fingerprints) /
│   │                            gate.js / preflight.js / lessons.js / statistics.js / settings.js /
│   │                            errors.js / tools.js (handler registry) / tests.js (criteria tests)
│   ├── mcp/server.js            minimal MCP stdio server (zero deps, newline-delimited JSON-RPC)
│   ├── ide/                     source.js (single source of truth for artifacts) / tokens.js / artifacts.js (managed files + 5 MCP client configs)
│   └── runners/                 index.js + eslint / typescript / boundaries / deps / ui / metrics / diff-size
├── test/                        unit tests + v5/v6/v6.1/v6.2/v6.3 end-to-end + init detection / presets / MCP clients / SARIF / HTML / ESLint classification / trend / task summary / React-TSX / workspace boundaries / workflow contract / gate evidence / confirm & defer / preflight / lessons / stats
├── examples/sample-app/         sample project with legacy violations (the real trio of tools)
├── examples/husky-pre-commit    pre-commit hook example (fast profile)
├── verify.sh                    v1 one-command real verification (checks + ratchet)
├── verify-v2.mjs                v2 one-command real verification (MCP protocol + counterexamples + artifacts + SARIF + ESLint ignore)
├── verify-v3.mjs                v3 one-command real verification (positive/negative cases for the four new checks + incremental adoption + per-check disable)
├── verify-v4.mjs                v4 one-command real verification (monorepo / vue-tsc / first-run view / baseline / false positives / cross-package boundaries)
└── verify-ts7.mjs               TypeScript 7 smoke test (non-Vue: real tsc 7 diagnostics still parse)
```

Come back after two months away and you only need four places: `src/baseline.js` (ratchet semantics), `src/workflow/state.js` (how stages are derived), `src/workflow/gate.js` (which operations get rejected), `src/runners/*` (tool adapters). Every file is kept under 500 lines (the same constraint self-check enforces).

## Verification system

```bash
npm test               # unit tests + v5/v6/v6.1/v6.2/v6.3 end-to-end + init detection
npm run verify:local   # local one-command: npm test + all v1/v2/v3/v4 verifications + self-check
npm run verify         # v1: copy the sample project into a temp dir, run full scenarios, assert exit codes
npm run verify:v2      # v2: full session over the real MCP protocol + counterexamples + artifacts
npm run verify:v3      # v3: positive/negative cases for the four new checks + incremental adoption + per-check disable
npm run verify:v4      # v4: per-package monorepo runs + planted .vue type errors + first-run view + false-positive loop
npm run verify:ts7     # TS 7 smoke test: real typescript@7 diagnostics still parse (needs network)
npm run self-check     # check fe-guard itself with its fast profile
```

No verification script **mocks anything**: they really spawn ESLint / tsc / dependency-cruiser / MCP subprocesses, create real files in temp git repos, install dependencies, run commands, and assert exit codes. Current measured results: v1 37 assertions, v2 135, v3 83, v4 69 — all passing; `npm test` passes 184, including the workflow contract (structured criteria, confirm / defer), manual evidence and gate snapshots, preflight, rework diff, lessons / distill, `task stats`, and package-level baseline (split, migration, `--show` / `--verify` / `--trend --package`, stale-root guard).

If any step deviates from expectations, the script prints the expected value, the actual value, and the full output, then exits with code 1. See [CONTRIBUTING](../CONTRIBUTING.md) for the contribution guide.