# Roadmap

[← Back to README](../README.md) · [简体中文](zh/roadmap.md)

fe-guard has one job: make "no worse than before" automatic. This page records what has shipped, what is being prepared, and what is deliberately out of scope.

## Shipped

- **0.1.x** — check layer (seven checks), baseline ratchet, MCP workflow, fast / full profiles, `doctor`, monorepo and Vue support, `not-executed`.
- **0.2.0** — `init` project probing, presets (`js` / `vue` / `legacy` / `monorepo`), `--dry-run`, project-level MCP configs for five clients.
- **0.3.0** — SARIF output, single-file HTML report, `baseline --trend`, `task events --summary`.
- **0.4.0** — React/TSX verification on a real repository (four real issues found and fixed); monorepo cross-package boundaries; structured acceptance criteria, `task confirm` / `task defer`, manual evidence and gate snapshots, environment preflight, rework diff, `task_lesson` + `workflow.distill`, read-only `task stats`.

## Next candidates

| Candidate | Why | Trigger |
| --- | --- | --- |
| Visual / screenshot diff | Manual evidence proves a file exists, not that the UI matches the design | A repo has stable visual baselines and someone can own the review |
| Browser / dev-server / login-state preflight | The current preflight only runs a command; most UI verification needs a working app | The same environment failures keep repeating across tasks |
| Spec distribution / sub-agent orchestration | Large tasks need instructions scoped per sub-agent | Multi-agent usage becomes common enough to justify it |
| Test page / mobile real device | Component and interaction checks are still manual | Teams ask for it; it needs external tooling |
| Cross-repo aggregate dashboard | `task stats` is single-repo | Several repos use the workflow for a quarter |
| Per-package baseline | Monorepo ledgers are repo-wide | A package needs its own debt budget |

## Explicitly not doing

- Auto-fix / automatic remediation.
- Semantic-level "should this be reused" judgements.
- A general workspace-topology parser (Rush / Nx / Turborepo).
- Multi-role permissions / ownership schemes.
- Cross-repo task queues or distributed execution.

These may be revisited only after checks + workflow have run stably and the baseline ledger is actually used.
