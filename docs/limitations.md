# Known limitations and explicit non-goals

[← Back to README](../README.md) · [简体中文](zh/limitations.md)

## Limits of check coverage (the honest version)

- **The baseline records "file + rule" counts** (metrics record maxima), not specific lines. So within **the same file and the same rule**, "fix one, add one" is count-equivalent to no change and can't be detected; changes across rules are detectable.
- **File renames** still show up as "old entry removed + new entry added" by default. `baseline --follow-renames` (`git add` the rename first) migrates ledger keys to the new path, preserving firstSeen, the widenLog trail, and `--verify` recognition of the migration. Untracked new files can't be paired as renames by git.
- **No autofix execution** — the tool's fix possibility is only surfaced in the `fix` field.
- **`--diff-only` only filters results by path**; tsc / dependency-cruiser still run in full. Under `--staged`, tsc / dependency-cruiser / diff-size also still read the working tree (the report marks this).
- **No custom ignore rules beyond `.eslintignore` / `.gitignore` are read**; ESLint's own ignore logic still applies.
- **deps is static parsing only.** It can't see variables inside `require(name)`, package names assembled at runtime, or dependencies injected by build plugins; `import type` is treated like a regular import. It doesn't judge "is this package used correctly" — only "is it banned / undeclared / duplicated".
- **deps' "new dependency" detection relies on git.** Without git, or when the commit `diff.base` points to has no `package.json`, `deps/unregistered` won't fire (the other three rules still work).
- **deps skips `.d.ts`.** Imports in auto-generated type declarations (e.g. `components.d.ts`) don't represent runtime dependencies and don't participate in "undeclared / phantom package" detection.
- **ui is heuristic.** It infers component names from file names / `defineOptions`, and props from `defineProps` / function parameters. It misses or false-positives on: dynamically generated component names, props inherited from external type aliases (rather than a local `interface` / literal), `h()` functional components, props declared with complex expressions in `<script setup>`, and semantic duplicates that are "different names but the same business component".
- **ui's props overlap is only a clue.** Similarity ≥ `propOverlap` is recorded as `warn` only, because it can't distinguish "a copy" from "two variants of the same kind of form". The default `minProps: 2` suppresses false positives on simple components.
- **ui's `index.*` files are excluded from name and duplication detection.** Entry file names like `index.vue` / `index.tsx` are naturally duplicated; they're named after their parent directory and excluded from duplicate-block detection.
- **metrics' duplication detection is token n-gram.** Line breaks, reordered statements, or added comments all make it see "no duplication"; it also can't recognize "same logic, different wording". Enabling `duplication.normalizeIdentifiers` resists "copy-and-rename" (identifiers normalized by first-appearance order), but structurally similar yet logically different code also matches. This is the price of zero dependencies and explainability.
- **metrics estimates function length by brace matching.** Concise arrow functions, returned object literals, and braces inside template strings can skew the boundaries; the `any` count only covers explicit forms (`: any`, `as any`, `<any>`, `any[]`) — implicitly inferred `any` is not counted.
- **diff-size only looks at added/removed lines and file count.** Rewriting a 500-line file wholesale with only 20 added lines won't be reported; pure deletions won't either. It guards "change surface", not "change risk". The default thresholds of 20 files / 600 lines are empirical — tune them to your team's review capacity.
- **It can't catch "should this be reused".** Two components with different names and differently split props that are nonetheless business duplicates require human judgment. The tool can only turn deterministic signals — "same name", "high overlap", "two libraries for the same capability" — into failures or warnings.
- **boundaries has been measured on a real Vue repo (Repo A)** (depcruise 18.8.0: 19 cycles, 0 false positives in sampling, <1s); React/TSX repos and monorepo cross-package boundaries are still uncovered. Vue repos require depcruise to resolve `@vue/compiler-sfc`; otherwise the adapter reports `boundaries/not-executed` (no false pass).

## Baseline and execution-mode limits

- **With `--staged`, only content checks read staged content.** ESLint / deps / ui / metrics run against a shadow directory exported by `git checkout-index`; TypeScript, boundaries, and diff-size still read the working tree (`tsc` / `vue-tsc` can't be reliably pointed at a shadow directory). The report's `staged` field and stdout's `--staged:` line explicitly list which is which.
- **The shadow directory only exports tracked files under the project root.** `git ls-files -- .` lists them, then `git checkout-index --stdin` exports; when the project root is a subdirectory of the git root, checks run on "shadow directory + subdirectory offset". If the file list exceeds the output cap, it refuses to export an incomplete snapshot rather than silently scanning nothing. `node_modules` is not exported — only symlinked from the root and each workspace package's copy; if the ESLint config depends on uncommitted local files you may get "plugin not found" — such failures fail with the package name, never silently pass.
- **`baseline --verify` needs a determinable base.** Precedence: `--base` > `GITHUB_BASE_SHA` / `GITHUB_BASE_REF` > local upstream; with none of them, exit code 2. A shallow clone must fetch the target branch first, otherwise merge-base can't be computed — also exit code 2.
- **Skips still don't fail.** A package without an ESLint config, or a diff with no source files, is recorded as `skipped` and visible in the report, but the exit code stays 0. This is the difference between "missing config" and "configured but broken" — the former shouldn't block commits.
- **Timeout is 120s per process.** Adjustable via `checks.eslint.timeoutMs` / `checks.typescript.timeoutMs` / `checks.boundaries.timeoutMs`; on timeout it sends SIGTERM first, then SIGKILL after 2s, producing a non-baselineable `<check>/not-executed`. Accumulated stdout is capped at 8MB — beyond that it's marked `truncated`, and a JSON parse failure is treated as an execution failure.
- **Global `enabled:false` remains an explicit emergency stop.** It exits 0 and writes `skipped: true` in the report; but it can also turn the gate green, so it should only be a temporary measure. Zero enabled checks (no global disable, but all `checks.*` off or the whole section missing) exits 2.
- **In a repo without HEAD, the full profile's `diff-size` fails.** Before the first commit in a new repo, `check --full` reports `diff-size/not-executed` (exit code 1) because it genuinely can't compute the change size; make an initial commit first, or temporarily disable `checks.diff-size`.
- **`<check>/not-executed` is non-baselineable.** Missing tools, timeouts, unavailable git, and crashed subprocesses all produce it, and `baseline` never absorbs it; but it can't stop someone from directly setting `enabled:false` — review has to backstop that.

## monorepo and Vue limits

- **monorepo detection is convention-based.** It currently recognizes `workspaces` in `package.json` (array or `{ packages }`), `packages:` in `pnpm-workspace.yaml`, and `lerna.json`; it only expands globs like `apps/*` and `packages/**`, skipping `!`-prefixed exclusions. It doesn't recognize custom topologies like `rush.json`, Nx's `project.json`, or Bazel — those repos fall back to single-repo mode.
- **In a monorepo, deps / ui / metrics / boundaries still run once at root level.** They expand the default scan root `src` into each package, but don't keep per-package ledgers; metrics can use `overrides` to give packages different thresholds by directory prefix, while deps / ui still use one repo-wide config.
- **monorepo ESLint duration is determined by the project's own config.** Repo B's 5 packages in parallel still take ~26s, because two apps enable type-aware rules and scan 180k lines; fe-guard's orchestration overhead is only ~3s — not the bottleneck.
- **Packages without an ESLint config are skipped**, and the report lists the skip roster (`--diff-only` / `--staged` also record `skipped` — a whole category never silently disappears); a package that has a config but fails execution fails with its package name.
- **Packages without a tsconfig are skipped in a monorepo**; if the root has no runnable tsconfig either, single-repo mode still reports "tsconfig not found".
- **vue-tsc version compatibility is limited.** Only common combinations are handled: Vue 3 + TS 5 uses vue-tsc 2.x; Vue 2.7 / older TS uses vue-tsc 1.8. `vue-tsc 2.x + TS 4.x` and `Vue 2 + vue-tsc 2.x` error out directly; for older combinations (Vue 2.6 and below), explicitly set `typescript.vue: false`. If `.vue` files exist but vue-tsc isn't installed, it fails with `typescript/vue-tsc-missing`, which never enters the baseline.
- **vue-tsc's check scope equals the project's own tsconfig.** `.vue` files not covered by `include` aren't checked; in a monorepo each package uses its own `tsconfig.json`.

## Local execution and workflow-layer limits

- **No enforcement, only a default path.** `git commit --no-verify` bypasses the hook; without CI there's no second gate. What the tool can do is make the default path fast enough and visible enough — it can't supply the team's discipline.
- **The fast profile doesn't rewrite the project's own ESLint config.** It only guarantees tsc / vue-tsc / boundaries / diff-size don't run; if the project's ESLint config itself enables type-aware rules, fast still gets slow. Check `doctor`'s last-run duration first, then decide whether to leave the most expensive rules to the full profile.
- **doctor's duration is "the duration in the last report"**, not a live measurement. If `check` has never run, it shows "duration unknown"; it won't run the full profile just to report a number.
- **Profiles only affect `check`.** `baseline` always records against the full set of enabled checks in config, avoiding a fast-profile ledger missing tsc/boundaries entries.
- **The tarball route requires npm on the target machine.** On a fully offline intranet, carry the tgz together with the project's `node_modules`, or stand up a read-only local registry; fe-guard itself has zero runtime dependencies, but the install step is still done by npm.
- **For one person maintaining multiple repos, the upgrade cost is in "verifying repo by repo"**, not in releasing. Run it in one repo for a full two weeks before copying the config to a second.
- **`workflow` only constrains operations "through the tools".** The AI can skip MCP entirely and edit files directly — the workflow won't know; what it blocks is "claiming completion inside the workflow". The truly unbypassable backstop remains local `fe-guard check --full` and Husky's `--staged --profile fast`.
- **Acceptance criteria have optional semantic binding**: a criterion with a `testFile` is covered only when the gate really runs the test and it passes under enforce; criteria without a test are still covered only by "gate evidence passing after the criterion was written" — no guarantee that "this pass proved this criterion". The test command comes from config; the model only supplies the path.
- **`implement` / `deliver` have no downgrade switch.** They are positions derived from events, not decision points, so config only exposes the three stages `contract` / `plan` / `verify`.
- **hooks are example files only** and don't take effect automatically; event names must be aligned with your IDE version. Neither IDE has a git pre-commit event.
- **Task state is single-repo, single-task**: only one task in progress at a time, auto-archived to `.fe-guard/tasks/` after delivery; no cross-repo aggregation, no concurrent task queue.
- **The AGENTS.md snippet is a "non-standard convention" for the model**, capped at 600 tokens (~530 measured). It doesn't replace the decisions in the tools — even if the model ignores it entirely, the tools still reject illegal operations.

## Explicitly not done (don't expect these)

- AI code review / auto-scoring; web UI / dashboards / metric trends.
- A YAML convention compiler; a rule marketplace / plugin market; multi-artifact distribution.
- Cross-repo upgrade bots; cross-repo task queues / distributed execution; multi-role permissions and ownership schemes.
- Semantic-level "should this component be reused" judgments; AST-level analysis; autofix.
- Cross-repo dependency governance (org-level "single-library allowlist" rollout); performance budgets / bundle-size checks.
- A general workspace-topology parser (no parsing of Rush / Nx / Turborepo custom project graphs).
- Automatic downgrading of false positives; web-based visual baseline review.
- monorepo cross-package dependency-graph analysis (that's `boundaries`' job, and it still needs dependency-cruiser).

If any of these are ever built, they should come after "checks + workflow" run stably and the team actually uses the baseline ledger.