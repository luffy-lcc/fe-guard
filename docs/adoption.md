# Progressive adoption and common concerns

[← Back to README](../README.md) · [简体中文](zh/adoption.md)

Adoption is only the starting point. This page answers two things: how to grow into the full capability set step by step according to your project's reality (instead of enabling everything up front), and the common concerns before and after adoption.

## Adoption advice: signal-driven, one item at a time

The goal is "cover exactly the current pain points", not "all seven checks on". A small project may only ever need the basic six — that is fine too. Decisions are not guesswork; they rely on three observation tools fe-guard ships with:

- `doctor`: which checks are running, coverage, and per-check timing.
- `baseline --show --by-rule`: which rule and which directory the legacy debt concentrates in.
- `check` reports + the `.fe-guard/` event stream: which violation types recur, false-positive frequency, and records of AI bypasses.

Each capability has a clear "pain-point signal"; enable it when the signal appears:

| Capability | When to enable | How you observe it |
| --- | --- | --- |
| The basic six + commit hook | On at adoption (default) | Included by `init` |
| boundaries | Layering gets complex / circular imports appear / multiple people need architecture constraints | You run into circular imports; module count rises in `doctor` |
| Workflow layer (MCP task) | AI becomes the main author and often "claims done" but gets reworked | High delivery rework rate; you want real-run evidence via `testFile` |
| Real-time edit hooks | Commit blocking comes too late; the AI has already changed a large area | Hooks frequently block large numbers of violations |
| Tighten thresholds / pay down legacy | Legacy concentrates in one rule and the team has spare capacity | Top rules dominate in `baseline --by-rule` |
| A second gate in CI | Multi-person collaboration / worry about `--no-verify` bypasses | Bypass records appear |
| Per-package thresholds via `overrides` | Old and new packages in a monorepo need different standards | Violation density varies widely across directories |

Cadence: run `doctor` once a week and watch the baseline trend; enable whichever item's pain point surfaces; **add only one item at a time, observe its false-positive rate and timing, then decide on the next**. This avoids premature complexity without missing capabilities you should add.

## Common concerns, clarified

**Are the default thresholds too strict? Many open-source files run over a thousand lines.**
Thresholds are configuration, not iron law; the defaults target business projects. Thousand-line files in open source are mostly "the sediment of many review rounds"; thousand-line files in business projects are mostly "a process nobody split" — the tool blocks the latter. The ratchet blocks "worse than the baseline", not "must be under X". For complex modules, raise `maxFileLines` / `maxFunctionLines`, differentiate per directory with `overrides`, or turn `metrics` off. The test: are these 1000 lines "genuinely needs to be this long" or "nobody split it" — raise the threshold for the former, fix the latter.

**Can the tool judge whether a file "should" be this long? Would leaving it to the AI be more accurate?**
No. Semantic judgments (should this be reused, should it be this long) are outside the tool's capability — a deliberate trade-off of the zero-dependency design. The tool only turns deterministic signals (line counts, same names, high overlap, duplicate libraries) into failures or warnings. "Should" is left to humans or the AI: when responding to blockers, the AI reads the file and judges; if justified, it leaves evidence with `false-positive --reason`; if not, it refactors. There is no need to build AI judgment into the tool — the existing workflow already forces the AI to respond to blockers. The tool's job is "the judgment cannot be skipped", not "replace the judgment".

**Must dependency-cruiser / `@vue/compiler-sfc` be installed?**
Not required. boundaries can be disabled; `@vue/compiler-sfc` is needed by depcruise to parse `.vue`, not by fe-guard (fe-guard has zero runtime dependencies).

| Project type | boundaries | Needs `@vue/compiler-sfc` |
| --- | --- | --- |
| Pure JS/TS (no `.vue`) | on | not needed |
| Vue | off | not needed |
| Vue | on | needed (Vue 2 uses `vue-template-compiler`) |

When a Vue project enables boundaries but lacks the compiler, depcruise silently skips `.vue`, causing a false pass; fe-guard compares "`.vue` count on disk vs `.vue` count in the graph" and reports `boundaries/not-executed` (non-baselineable) when incomplete. pnpm does not hoist transitive dependencies, so run `pnpm add -D @vue/compiler-sfc` explicitly for depcruise to resolve. Small projects should leave boundaries off at first and enable it when layering gets complex or circular imports appear.

**When does it count as "fully adopted"?**
There is no "everything must be on" moment. A reference state: all seven checks on + workflow enforcement + commit/CI double gate + a continuously tightening baseline + an evidence chain for false positives. But whether you reach that state depends on the project — follow the pain-point signals; do not enable everything for its own sake.

**Does AI programming need real-time edit triggers?**
Three trigger layers, in decreasing reliability: the commit hook (hard gate, always runs) → the MCP workflow (`task_gate` really verifies, guidance level) → real-time edits (optional). The first two are enough by default: the commit backstop cannot be bypassed (except `--no-verify`), and `task_gate` really runs checks and tests when the AI "claims done". Real-time triggers (`afterToolCall`) make intermediate states error frequently and add latency; most scenarios do not need them. They are only worth adding when "commit blocking comes too late and the AI has already changed a large area". The hooks are example files only — they take effect once you align the event names in your IDE settings.

**Can it take effect only on my machine, without polluting the repository?**
Yes. Localize all adoption artifacts: install fe-guard into an ignored standalone tools directory (e.g. `.fe-guard-tools/`), ignore the config / ledger / state directories via `.git/info/exclude` (local-only, never committed), and point the hooks and MCP at that directory. The cost: a local ledger means a new machine / clone needs `init` + `baseline` again — suitable for solo local use. For team sharing, commit `fe-guard.config.json` + `fe-guard.baseline.json`.
