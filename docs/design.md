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

## Directory layout

```
fe-guard/
├── bin/
│   ├── fe-guard.js              entry point (parses args, dispatches commands)
│   └── fe-guard-mcp.js          MCP server entry (the IDE mounts it)
├── src/
│   ├── cli.js                   CLI and help
│   ├── config.js                config loading, defaults, switch resolution, workflow normalization, defaults for the seven checks
│   ├── profiles.js              built-in fast / full profiles
│   ├── not-executed.js          the "check not executed" violation type (non-baselineable)
│   ├── check-core.js            check kernel shared by CLI and MCP gate; routes the count/value tracks
│   ├── baseline.js              ratchet core: count/value comparison, tightening, disk format (pure functions, unit-tested)
│   ├── workspace.js             monorepo detection, per-package planning, config and bin resolution
│   ├── timing.js                per-check and per-package timing
│   ├── feedback.js              false-positive records: append, read, summarize
│   ├── metrics.js               rot metrics: line counts, function length, any count, token n-gram duplication rate
│   ├── inventory.js             component extraction and inventory: parse props/emits, rebuild inventory, duplicate-implementation detection
│   ├── git.js                   changed-file collection
│   ├── report.js                report generation and terminal output (by default lists only new violations)
│   ├── commands/                init / check / baseline / feedback / doctor / task
│   ├── workflow/                state.js (event stream / stage derivation) / tools.js (7 MCP tools) / tests.js (criteria tests)
│   ├── mcp/server.js            minimal MCP stdio server (zero deps, newline-delimited JSON-RPC)
│   ├── ide/                     source.js (single source of truth for artifacts) / tokens.js / artifacts.js
│   └── runners/                 index.js + eslint / typescript / boundaries / deps / ui / metrics / diff-size
├── test/                        unit tests + v5/v6/v6.1/v6.2/v6.3 end-to-end
├── examples/sample-app/         sample project with legacy violations (the real trio of tools)
├── examples/husky-pre-commit    pre-commit hook example (fast profile)
├── verify.sh                    v1 one-command real verification (checks + ratchet)
├── verify-v2.mjs                v2 one-command real verification (MCP protocol + counterexamples + artifacts)
├── verify-v3.mjs                v3 one-command real verification (positive/negative cases for the four new checks + incremental adoption + per-check disable)
└── verify-v4.mjs                v4 one-command real verification (monorepo / vue-tsc / first-run view / baseline / false positives)
```

Come back after two months away and you only need four places: `src/baseline.js` (ratchet semantics), `src/workflow/state.js` (how stages are derived), `src/workflow/tools.js` (which operations get rejected), `src/runners/*` (tool adapters). Every file is kept under 500 lines (the same constraint self-check enforces).

## Verification system

```bash
npm test               # unit tests + v5/v6/v6.1/v6.2/v6.3 end-to-end
npm run verify:local   # local one-command: npm test + all v1/v2/v3/v4 verifications + self-check
npm run verify         # v1: copy the sample project into a temp dir, run full scenarios, assert exit codes
npm run verify:v2      # v2: full session over the real MCP protocol + counterexamples + artifacts
npm run verify:v3      # v3: positive/negative cases for the four new checks + incremental adoption + per-check disable
npm run verify:v4      # v4: per-package monorepo runs + planted .vue type errors + first-run view + false-positive loop
npm run self-check     # check fe-guard itself with its fast profile
```

No verification script **mocks anything**: they really spawn ESLint / tsc / dependency-cruiser / MCP subprocesses, create real files in temp git repos, install dependencies, run commands, and assert exit codes. Current measured results: v1 37 assertions, v2 92, v3 83, v4 54 — all passing; `npm test` passes 94 (including 17 from v6.1, 5 from v6.2 and 5 from v6.3).

If any step deviates from expectations, the script prints the expected value, the actual value, and the full output, then exits with code 1. See [CONTRIBUTING](../CONTRIBUTING.md) for the contribution guide.