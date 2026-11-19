# Core concepts: checks, the baseline ratchet, and profiles

[← Back to README](../README.md) · [简体中文](zh/baseline.md)

## Checks (seven adapters)

Three checks wrap external tools; the other four are fe-guard's own lightweight implementations that read source code without running a compiler. All seven share the same `enabled` / `level` switches and produce the same violation shape.

| Check | Default tool | Normalized `ruleId` form |
| --- | --- | --- |
| `eslint` | `eslint --format json` | `eslint/no-unused-vars` |
| `typescript` | `tsc --noEmit --pretty false` (auto `vue-tsc` for Vue) | `typescript/TS2322` |
| `boundaries` | `depcruise src --output-type json` | `boundaries/services-no-ui` |
| `deps` | Built-in (reads imports + package.json) | `deps/capability-conflict`, `deps/phantom`, `deps/unregistered`, `deps/capability-duplicate` |
| `ui` | Built-in (scans `.vue` / `.tsx` / `.jsx`) | `ui/duplicate-name` (error), `ui/duplicate-props` (warn) |
| `metrics` | Built-in (token statistics, no external dependencies) | `metrics/file-lines`, `metrics/function-lines`, `metrics/any`, `metrics/duplication` |
| `diff-size` | Built-in (`git diff --numstat`) | `diff-size/files`, `diff-size/lines` |

Whatever the tool, everything ends up in the same shape:

```json
{
  "ruleId": "eslint/eqeqeq",
  "file": "src/utils/math.ts",
  "line": 11,
  "severity": "error",
  "message": "Expected '===' and instead saw '=='.",
  "fix": "可自动修复：eslint --fix"
}
```

Fields:

- `ruleId`: `tool-name/rule-name`. The baseline keys on it, and reports can trace which tool raised the violation.
- `file`: posix path relative to the repo root; it doesn't drift across machines.
- `line`: used when the tool provides a line number; dependency-cruiser doesn't, so it's `null` there.
- `severity`: `error` / `warn`. If you set a check's `level` to `warn` in config, everything from it is reported as `warn` and won't fail the gate.
- `fix`: filled when the tool offers a fix suggestion, otherwise `null` (fe-guard doesn't edit code for you).

## The baseline ratchet (core mechanism)

The baseline stores **(file path, ruleId) → allowed violation count** — not a repo-wide total, and not a per-file total.

Why not just record totals? Consider this example:

```
src/utils/math.ts existing violations: 1 eqeqeq
The developer does two things:
  1. Changes `a == b` to `a === b`   → eqeqeq down by 1
  2. Writes a new `: any`            → no-explicit-any up by 1
```

If the baseline only recorded "this file is allowed 2 violations", the total would still be 2 after the change, the check would pass, and the new problem would slip in quietly. With `(file, ruleId)` accounting, `no-explicit-any` is a brand-new key with an allowance of 0, so it fails immediately — and **at the same time** the allowance for the old rule `eqeqeq` is tightened.

Three rules:

| Situation | Result | Baseline change |
| --- | --- | --- |
| A (file, rule) exceeds its allowance | Fail (exit code 1) | Unchanged, never widened |
| Below the allowance (legacy violations fixed) | Pass | Auto-tightened to the current count; entry removed at 0 |
| A (file, rule) not in the baseline appears | Fail | Unchanged |

So to "accept new debt" you must explicitly run `npx fe-guard baseline --widen`, and you should state the reason in the commit message. `check` only ever tightens, never widens.

### Two ledgers: counts and values

`metrics` doesn't fit count accounting — a file that has historically been 820 lines isn't "allowed 1 over-length violation", it's "allowed up to 820 lines". So the baseline has an extra `ratchets` section, with the same **tighten-only** semantics:

| Situation | Result | Baseline change |
| --- | --- | --- |
| Current value > the ledger's allowed maximum | Fail (exit code 1) | Unchanged, never widened |
| Current value < the ledger value (refactored smaller) | Pass | Auto-tightened to the current value |
| The metric no longer exists in the file | Pass | Entry removed |
| New file, not in the ledger | Fail | Unchanged; requires an explicit `baseline` run to record it |

`diff-size` is the only check that **does not participate in the baseline**: a large diff is "an event of this change", not historical debt — recording it would permanently disable the gate. It only looks at the current change, and `check` never writes it into the ledger.

Why not record line numbers? Lines drift with formatting and inserted code, producing lots of false failures. We chose "same file + same rule" counting instead: low enough maintenance cost to block the vast majority of new violations. The trade-offs are documented in [known limitations](limitations.md).

## Exit codes and reports

| Exit code | Meaning |
| --- | --- |
| `0` | Pass (including: explicit emergency stop via global `enabled:false`; no checkable files in this change) |
| `1` | New violations exist (error-level among those beyond the baseline), or a check produced a "not-executed" violation |
| `2` | Config or environment error: missing/invalid config, nothing enabled, unparseable ESLint output, baseline refuses to widen, `--verify` can't determine a base, etc. |

Every `check` writes a machine-readable report to `.fe-guard/report.json` (path configurable), containing `ok`, `exitCode`, `mode`, `profile`, `scope`, `summary`, `checks[]` (each with `status: "ran" | "skipped" | "unavailable"`), `staged` (with `--staged`, marks which checks read the staged snapshot), per-item `violations` (with `status: "new" | "known"`), and this run's `baseline.tightened` / `removed`. With `--json`, stdout contains only this JSON, ready for `jq` or other scripts.

**"Check not executed" is a non-baselineable error**: missing tools, timeouts, unavailable git, and crashed subprocesses all produce `<check>/not-executed`. Its `severity` is always error and `isBaselineExempt` is always true — `baseline` never absorbs it.

## Two profiles: fast and full

Profiles are built-in constants in code (`src/profiles.js`), not two copies of `enabled` maintained in config — two configs would inevitably drift.

| Profile | Checks included | Use case | Target |
| --- | --- | --- | --- |
| `fast` | ESLint, dependency guard, component inventory, rot metrics | git hooks, inside AI sessions | Under 3 seconds |
| `full` | Plus TypeScript / vue-tsc, architecture boundaries, large-diff | Before merge, periodic manual runs | Scales with project size |

The default is `full`, so a plain `fe-guard check` behaves like older versions. Use `--profile fast` in hooks, and `--full` when you need everything.

**Profile skips are stated explicitly**, not "looks like everything passed": the report's `profile` field and stdout's `profile:` line both list the checks this profile skips, and suggest `check --full`.

The real boundary of fast: fe-guard doesn't rewrite the project's own ESLint config, so if that config enables type-aware rules, fast still pays for type information. Run `fe-guard doctor` first to see the last run's duration; if it exceeds 3 seconds, leave the most expensive ESLint rules to the full profile, or narrow `checks.eslint.targets`.

### Config path overrides

```sh
fe-guard check --config ./configs/fe-guard.frontend.json
FE_GUARD_CONFIG=./configs/fe-guard.frontend.json fe-guard check
```

Precedence: `--config` > `FE_GUARD_CONFIG` > `fe-guard.config.json` at the repo root. Relative paths resolve against the current working directory; baseline and report paths still use the config's relative values, based at the repo root.