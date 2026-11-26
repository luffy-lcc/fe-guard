# Roadmap

[← Back to README](../README.md) · [简体中文](zh/roadmap.md)

fe-guard has one job: make "no worse than before" automatic. This page records what has shipped, what is being prepared, and what is deliberately out of scope.

## Shipped

- **0.1.x** — check layer (seven checks), baseline ratchet, MCP workflow, fast / full profiles, `doctor`, monorepo and Vue support, `not-executed`.
- **0.2.0** — `init` project probing, presets (`js` / `vue` / `legacy` / `monorepo`), `--dry-run`, project-level MCP configs for five clients.
- **0.3.0** — SARIF output, single-file HTML report, `baseline --trend`, `task events --summary`.
- **0.4.0 (completed)** — React/TSX verification on a real repository (four real issues found and fixed); monorepo cross-package boundaries; structured acceptance criteria, `task confirm` / `task defer`, manual evidence and gate snapshots, environment preflight, rework diff, `task_lesson` + `workflow.distill`, read-only `task stats`.

## 0.5.0 (completed)

Theme: **per-package legacy debt accounting**, so a monorepo baseline stops mixing packages.

Delivered:

- `baseline.strategy: "root" | "package"` plus `baseline.packageFile`. Root stays the default and existing behavior is unchanged.
- Root files (`package.json`, `scripts/`, repo-level configs) stay in `baseline.path`; each workspace package gets `<package>/<packageFile>`; ownership is the longest package prefix.
- `baseline --migrate-packages [--dry-run]`: split an existing root ledger by ownership, keep `firstSeen`, record `initial-adoption` / `migrate-packages`, and exit 2 without writing on conflicts.
- `baseline --show` / `--verify` / `--trend --package <name|rel>`; deleting a package ledger fails `--verify` instead of silently unfreezing debt.
- `doctor` prints `baseline.strategy` and, per package, ledger path, file / entry / ratchet counts and the latest git change.
- `check` report gains `strategy` and `ledgers`; write-back reports "N package ledgers".
- Tests: `npm test` passes 184; `verify-v4.mjs` reaches 69 assertions (v1 37 / v2 135 / v3 83 unchanged).

Not in 0.5.0: `--follow-renames` in package mode, automatic conflict resolution; deps / ui / metrics / boundaries still run once at the root (metrics ratchets do follow file ownership into package ledgers).

## 0.6.0 (completed, current release)

Theme: **external integration for verification environments and visual evidence**.

Delivered:

1. `workflow.preflight` accepts multi-step named checks via `steps[]`, mutually exclusive with the single `command`; steps run in order, stop on the first failure, and name the failed step.
2. Criteria add `evidenceKind` (`screenshot` / `diff` / `log`); manual evidence infers the kind from the extension, and gate only accepts `diff`.
3. `workflow.visualDiff.command` only runs the project's command; stdout / exit code / hash become evidence; no runtime dependency is added.
4. A visual criterion is covered only when `visualDiff.ok` is true; a missing command, timeout or non-zero exit is never a pass.
5. Bilingual docs and the `verify-v4` scenario are updated.

Acceptance results:

- The existing single-command preflight still works; a `steps[]` failure names the step.
- `evidenceKind` is recorded and readable via `task status` / `task status --json` without new runtime dependencies.
- `visualDiff.command` never starts a browser or installs a package; a missing command is "not executed", never a pass.
- Tests: `npm test` passes 191; `verify-v4.mjs` reaches 80 assertions (v1 37 / v2 135 / v3 83 / v4 80).

Not included: built-in browser automation, a pixel-diff implementation, mobile / real-device checks, per-criterion mapping to multiple visual commands.

Maintenance and distribution: 0.5.x receives regression fixes only; 0.6.0 is released; npm publishing is reassessed once there is clear external demand.

## Next candidates

| Candidate | Why | Trigger |
| --- | --- | --- |
| Visual diff / browser preflight refinement | 0.6.0 first integrates external commands; built-in automation and pixel comparison need a dedicated owner | A repo has stable visual baselines and the team wants more than an external command |
| Spec distribution / sub-agent orchestration | Large tasks need instructions scoped per sub-agent | Multi-agent usage becomes common enough to justify it |
| Test page / mobile real device | Component and interaction checks are still manual | Teams ask for it; it needs external tooling |
| Cross-repo aggregate dashboard | `task stats` is single-repo | Several repos use the workflow for a quarter |

## Explicitly not doing

- Auto-fix / automatic remediation.
- Semantic-level "should this be reused" judgements.
- A general workspace-topology parser (Rush / Nx / Turborepo).
- Multi-role permissions / ownership schemes.
- Cross-repo task queues or distributed execution.

These may be revisited only after checks + workflow have run stably and the baseline ledger is actually used.
