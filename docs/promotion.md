# Start from "No Worse": fe-guard's Frontend Quality Gate and AI Workflow

> Freeze legacy debt with a baseline ratchet, and turn the AI's "done" into checkable gate evidence.

## How a frontend repo slowly degrades

Most frontend repositories are not ruined by one big rewrite. They are worn down by a chain of commits that each looks "fine".

A feature adds another dropdown that differs from an existing component by two props; a deadline introduces a second date library; a page grows from 300 to 800 lines; `any` goes from 3 to 30. Each diff is reviewable — it did solve the problem at hand. Three months later, duplicate components, two time-handling stacks and a file nobody dares to touch are all there, and the team starts talking about "cleanup".

The traditional answer is a full lint: the first run shows hundreds or thousands of issues, review says "turn it off for now, we'll clean it later". The check stops being a gate and becomes a report nobody reads. AI makes generation faster, so this arrives sooner — the faster the code is written, the more a path that automatically protects the floor is needed.

## fe-guard's answer: freeze what exists, block only what is new

fe-guard does not assume a project can pay down all legacy debt at once. It splits quality into two layers: the check layer answers "did anything get worse?", the workflow layer answers "is it actually finished?".

The first rule of the check layer is the baseline ratchet:

- Run `baseline` once on adoption to record existing violations;
- Every later `check` fails only on what goes beyond the ledger;
- Fixing legacy debt tightens the ledger automatically; widening requires an explicit `--widen` with an audit record;
- A monorepo can keep one ledger per package, so paying down A never tightens B.

This is the opposite of "everything must be clean": **it accepts history, but does not let history keep growing.** A project may not become healthy through one cleanup, but it can improve by never getting worse on any commit.

## Not another lint wrapper

fe-guard does not reimplement ESLint or ask a team to replace its tools. It orchestrates and normalizes: different tool outputs become one violation shape, then three things the tools do not provide are added:

- **Legacy ratchet**: block only what is new, keep history auditable;
- **Unified execution**: per-package monorepos, automatic `vue-tsc` for Vue, subdirectory roots, fast / full profiles;
- **Report outputs**: JSON / SARIF / single-file HTML for CI and code scanning.

## Seven checks: hand deterministic problems to tools

fe-guard orchestrates the project's own ESLint, TypeScript and dependency-cruiser, and ships four lightweight checks of its own:

| Check | What it blocks |
| --- | --- |
| ESLint / TypeScript / boundaries | Syntax, types, cycles and forbidden layer crossings |
| Dependency guard | Unregistered new dependencies, phantom packages, two libraries for the same capability |
| Component inventory | Duplicate names and components with heavily overlapping props |
| Rot metrics | File length, long functions, explicit `any`, cross-file duplicate blocks |
| Large diff | Too many files/lines in one change; split the PR |

The baseline keeps two ledgers: `(file, rule) -> allowed count` and `(file, metric) -> allowed maximum`. It only tightens, never loosens, with auditable `firstSeen` / `widenLog`. Monorepos can keep one ledger per package, so paying down package A never tightens package B by accident.

## Turning "done" into evidence: the workflow layer

The check layer answers "did anything get worse?". The workflow layer answers "is this actually finished?". fe-guard exposes the process as MCP tools:

**contract → criteria → plan → implement → gate → deliver**

The model cannot mark a stage as passed, and there is no "I'm done" tool. Every action is appended to an event stream, and the stage is derived from events:

- **Every criterion** must state `type` (UI / interaction / data / tracking / compat / performance) and `source` (requirement, design, code, or `assumption`);
- Criteria that can be tested bind a `testFile`, which the gate really runs; manual/visual checks bind an `evidenceFile`, recorded with `bytes` and `sha256`;
- Assumptions require a human `task confirm`; a condition the team explicitly drops requires a human `task defer`, and delivery is marked `degraded` with the remaining todos listed;
- Every gate writes a snapshot under `.fe-guard/evidence/...` and reports how many issues were fixed and how many were introduced;
- After a failed gate, delivery requires a `task_lesson`; `workflow.distill` defaults to `enforce`;
- `task stats` aggregates delivery rate, gate failure rate, top blockers, lessons and deferred items, read-only.

These are decisions in code, not prompt suggestions. The model may say "done", but only gate evidence can move the task into delivery.

## What a real task looks like

You say: "Add a `formatDuration` helper — 1000ms should show as 1s."

The AI:

1. `task_start` writes the goal and what is out of scope;
2. `task_criteria` declares "returns 1s for 1000ms" (data, requirement#duration, `testFile`);
3. `task_plan` writes the implementation steps;
4. changes code and writes the test;
5. `task_gate` runs the real gate.

If the gate fails, the response is a list of blockers: which violation is new, which criterion has no evidence, which assumption is still unconfirmed. It fixes them and runs the gate again. Only when evidence is complete does the task enter `deliver`.

You do not need to click through every page. You read "N done / M deferred" and the evidence paths.

## Honest engineering: no false green

fe-guard cares less about feature count than about **never producing a fake result**:

- Missing tool, timeout or crash → `<check>/not-executed`, which can never enter the baseline;
- A package with no ESLint config → recorded as `skipped`, not passed;
- depcruise parsing only some `.vue` files → "dependency graph incomplete", never a fake zero;
- Environment preflight fails → the check did not execute and cannot cover criteria;
- A deleted package ledger → `baseline --verify` fails instead of silently unfreezing debt.

Skipped is not passed. Not executed is not fine. That is the difference between this and "run lint and call it a quality gate".

## Numbers from real repositories

Measured on copies of three real Vue repositories:

- A 109k-line single repo: `--profile fast` **2.0s**, full profile **2.5s** — the 3-second hook target holds;
- First adoption recorded 956 / 11424 violations, after which `check` exits 0 and only new violations are shown by default;
- Error-level false positives: **0 / 1092**;
- boundaries (depcruise 18.8.0) found **19 real cycles**, with 3 manually traced samples and **0 false positives**, under 1s.

React / TSX was also run against two open-source repositories and uncovered real issues: Storybook stories treated as components, subdirectory projects reading the git-root `package.json`, a fully ignored ESLint package aborting the gate, and `"."` in `pnpm-workspace.yaml` running the root package twice.

These numbers do not mean fe-guard can replace architecture review. They mean: **deterministic problems can be handed to deterministic tools.**

## Monorepos, Vue and React

- **Monorepos**: detects `package.json` workspaces, `pnpm-workspace.yaml` and `lerna.json`; ESLint / TypeScript run per package with each package's own config, in parallel; since 0.5 the baseline can also be kept per package;
- **Vue**: switches to `vue-tsc` automatically when `.vue` files exist; if `.vue` exists but `vue-tsc` is unavailable, it fails clearly instead of silently skipping;
- **React / TSX**: verified on real open-source repositories; stories and test files are no longer treated as components;
- **Subdirectory projects**: when backend and frontend share a repo, mount with `--root frontend` and git-related paths stay correct.

Zero runtime dependencies, Node 18+, installation size is just the source files.

## Who it is for, and who it is not

**Good fit**:

- Frontend repos with legacy debt that do not want to turn all checks off after the first full lint;
- Teams with multiple people/packages and AI-assisted development, where human review no longer catches duplicate components, dependency sprawl and file rot;
- Teams that want evidence behind "the AI says it's done" instead of clicking through pages.

**Not a fit**:

- One-line copy changes that need no process at all;
- Teams expecting semantic architecture judgement, automatic refactoring, or automatic fixes for everything;
- Teams that will not review baseline changes — the ledger needs an owner.

## Five-minute setup

```bash
npm i -D github:luffy-lcc/fe-guard#v0.5.0   # or the tarball from Releases
npx fe-guard init      # probe the project; write config, ledger, AGENTS.md and MCP configs
npx fe-guard baseline  # record existing debt
npx fe-guard check     # block only what is new
```

Hook:

```bash
npx fe-guard check --staged --profile fast
```

Before merging:

```bash
npx fe-guard check --full
```

Reports can be emitted as JSON, SARIF or a single-file HTML:

```bash
npx fe-guard check --full --format sarif > fe-guard.sarif
npx fe-guard check --full --format html
```

## Final thought

AI writing speed is no longer the bottleneck. The bottleneck is who verifies the result. fe-guard's answer is simple:

> Do not trust what it says; trust what it can show. Do not let one "done" make the project worse.

If that resonates, start with one repo, one `baseline`, and one pre-commit hook. It will not make the codebase clean overnight, but the next commit will not make it worse.
