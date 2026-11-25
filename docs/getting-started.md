# Getting started and daily use

[← Back to README](../README.md) · [简体中文](zh/getting-started.md)

Prerequisites: Node 18+, the project is a git repository, and ESLint / TypeScript / dependency-cruiser are installed locally (missing ones are fine — the corresponding check explicitly reports `not-executed`, or can be disabled).

## 1. Install

```bash
npm i -D fe-guard
npx fe-guard --version
```

When the intranet has no public npm, use a tarball or a private registry — see [Intranet distribution](#intranet-distribution-two-paths-pick-one).

Before the package is published to npm, install from GitHub: `npm i -D github:luffy-lcc/fe-guard`.

## 2. Initialize

```bash
npx fe-guard init
```

It generates these files:

| File | Purpose |
| --- | --- |
| `fe-guard.config.json` | The single config entry point: check toggles, severity levels, baseline and report paths, workflow-layer toggle |
| `fe-guard.baseline.json` | The ledger of historical debt, initially empty |
| `AGENTS.md` | Appends a managed snippet (with `<!-- fe-guard:begin -->` markers), the single source of truth across tools |
| `.trae/mcp.json`, `.cursor/mcp.json`, `.mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json` | Wires the fe-guard MCP server into Trae / Cursor / Claude Code / VS Code / Gemini CLI (each file only takes over its own `fe-guard` entry, never overwrites your servers or other settings; home configs are not touched) |
| `.trae/rules/fe-guard.md`, `.cursor/rules/fe-guard.mdc` | The same workflow instructions, generated in each IDE's format |
| `.trae/commands/fe-guard-*.md` | Two slash commands: see the next step, run the gate |
| `.trae/hooks.example.json`, `.cursor/hooks.example.json` | Hook examples (not activated automatically) |

`init` is safe to re-run: files are only written when content changes, and AGENTS.md only replaces the snippet between the markers — it never appends duplicates.

Before writing the config, `init` probes the project: if there is no `tsconfig.json` (root or any workspace package) it disables `typescript`; without an ESLint config it disables `eslint`; without a `.dependency-cruiser.{cjs,js,json}` it disables `boundaries` and picks the file that does exist. The disabled checks are printed and written as `enabled: false`, so a plain JavaScript project passes its first `check` instead of aborting. Flip a check back on once its prerequisite is in place — an existing config is never re-probed unless you pass `--force`.

### Presets and `--dry-run`

`init --preset <name>` picks a starting point for the generated config. The preset is applied first (it sets the tone: which checks are on, how wide the thresholds are), then the project probe applies on top and only ever disables checks whose prerequisites are missing — it never re-enables a check the preset turned off, nor changes a threshold.

| Preset | What it changes |
| --- | --- |
| `js` | Plain JavaScript: disables `typescript` and `ui` |
| `vue` | Explicitly writes the `vue-tsc` auto-switch (`typescript.vue: "auto"`); the defaults are already Vue-oriented |
| `legacy` | Looser rot thresholds: 800 lines/file, 150-line functions, 50 `any`, duplication ratio 0.6; large diff 40 files / 1200 lines |
| `monorepo` | Explicit per-package `workspace: "auto"` plus a 40-file / 1000-line large-diff budget |

`init --dry-run` prints every file it would create or update together with its content, and writes nothing:

```bash
npx fe-guard init --preset legacy --dry-run   # preview only
npx fe-guard init --preset legacy             # write it
```

A `--preset` is ignored when a config already exists (without `--force`), and `init` says so instead of silently changing your settings.

## 3. Record existing violations into the baseline

```bash
npx fe-guard baseline
```

Output looks like:

```
fe-guard baseline 已更新: fe-guard.baseline.json
  当前条数型违规: 8，涉及 5 个文件
  当前指标型条目: 4
  新增条目: 12，收紧: 0，删除: 0
  首次记录存量: 12
```

*CLI output is currently in Chinese; commands and exit codes are what matter.*

At this point `fe-guard.baseline.json` contains:

```json
{
  "version": 3,
  "note": "由 fe-guard 生成。entries 是「文件 + 规则 -> 允许的违规条数」；ratchets 是「文件 + 指标 -> 允许的最大值」（单文件行数、重复率等）。两者都只会自动收紧，不会自动放宽。firstSeen 是首次入账日期；widenLog 记录每次显式放宽，供 CI 审计。",
  "entries": {
    "src/services/user.ts": { "boundaries/services-no-ui": 1 },
    "src/utils/legacy.ts": { "typescript/TS2322": 1 },
    "src/utils/math.ts": {
      "eslint/@typescript-eslint/no-unused-vars": 1,
      "eslint/eqeqeq": 1
    }
  },
  "ratchets": {
    "src/pages/home.ts": {
      "metrics/file-lines": 820,
      "metrics/function-lines": 134,
      "metrics/any": 3,
      "metrics/duplication": 0.11
    }
  },
  "firstSeen": {
    "src/services/user.ts::boundaries/services-no-ui": "2026-11-13",
    "src/utils/math.ts::eslint/eqeqeq": "2026-11-13"
  },
  "widenLog": [
    { "at": "2026-11-13T08:00:00.000Z", "type": "initial-adoption", "entries": 4, "ratchets": 4 }
  ]
}
```

Read it in three parts:

- `entries`: for the file `src/utils/math.ts`, historically 1 `eqeqeq` violation and 1 `no-unused-vars` violation are allowed. This is the **count** ledger.
- `ratchets`: `src/pages/home.ts` historically peaked at 820 lines, longest function 134 lines, 3 `any`s, duplication rate 0.11. This is the **value** ledger, recording "allowed maxima".
- `firstSeen`: the date each rule was first recorded. Written once; later tightening or re-runs never change it, so you can answer "why is this entry here".
- `widenLog`: the source of every widening. First adoption is recorded as `initial-adoption`; explicit widening is recorded as `widen` with per-entry details. `baseline --verify` uses it to detect whether anyone widened without `--widen`.

Both ledgers share the same ratchet semantics: values can only go down, never up. A check fails only when the `value` reported by metrics exceeds the ledger. See [baseline ratchet](baseline.md) for the ratchet mechanism.

If you're unsure why an entry is in the ledger, don't edit the JSON directly — inspect it with `baseline --show` / `--by-rule` / `--verify`.

### Per-package ledgers in a monorepo

By default the ledger is one repository-wide file. For a monorepo you can keep one ledger per workspace package, so a cleanup in one app doesn't blur another app's debt:

```json
{ "baseline": { "strategy": "package", "packageFile": "fe-guard.baseline.json" } }
```

`baseline.strategy: "package"` requires a detected workspace. Package files go to `<package>/<packageFile>`; the root `package.json`, `scripts/` and repo-level files stay in `baseline.path`.

```bash
npx fe-guard baseline                               # run once, split by file ownership
npx fe-guard baseline --migrate-packages --dry-run  # existing root ledger: preview
npx fe-guard baseline --migrate-packages            # then apply and commit the result
npx fe-guard baseline --show --package apps/web
npx fe-guard baseline --verify --package apps/web --base origin/main
```

Common errors:

- `根账本 ... 里仍有 N 条 package 文件条目` — the root ledger is stale; run `baseline --migrate-packages` before `check`.
- `账本被删除，历史欠债被静默解冻` — `--verify` found a package ledger that existed in the base; restore it or migrate its entries explicitly instead of deleting the file.

Full behavior and limits: [monorepo: per-package ledgers](baseline.md).

## 4. Run the checks

```bash
npx fe-guard check
```

```
fe-guard  mode=full
checks: ESLint=error, TypeScript (tsc)=error, 架构边界 (dependency-cruiser)=error, 依赖守卫=error, 组件清单 / 重复实现=error, 腐化指标棘轮=error, 大 diff 拦截=error
profile: full
存量违规 12 条（baseline 允许），新增 0 条（error 0 / warn 0）
报告: .fe-guard/report.json
结果：通过（退出码 0）
```

`mode` is the check scope (`full` / `diff-only` / `staged`); `profile` is the profile (`fast` / `full`). The two are independent.

## 5. Try creating a new violation

Add a line `const unused = 1` to any source file, then run again:

```
存量违规 12 条（baseline 允许），新增 1 条（error 1 / warn 0）
  [new] src/pages/home.ts:9  eslint/@typescript-eslint/no-unused-vars (error)
        'unused' is assigned a value but never used.
报告: .fe-guard/report.json
结果：失败（退出码 1，存在新增违规）
```

Remove the line and you're back to exit code 0. That closes the loop.

## 6. What you'll see on first adoption

On a legacy project's first `check`, every existing issue counts as "new" — hundreds or thousands can appear at once. The tool isn't broken, and the project didn't just rot. How it's handled today:

- The default output **lists only new violations one by one**; legacy violations collapse into a single line: `存量违规 956 条（baseline 允许，默认不逐条展示；--all 看全部，fe-guard baseline --show 按文件看）`.
- Before anything is recorded, it also prints a guidance block telling you the next step is `npx fe-guard baseline`.
- To see legacy violations one by one: `npx fe-guard check --all`; to see the ledger grouped: `npx fe-guard baseline --show`.
- `init` prints the same guidance at the end, so a first adoption isn't scared off by hundreds of entries.

Only **new violations** actually block a commit. Legacy violations are explicitly accepted the moment you run `baseline`, with the first-recorded date logged; from then on they can only tighten.

## 7. When you think a finding is a false positive

Don't disable the check outright. Record your judgment first, so rules can be corrected in bulk later:

```bash
npx fe-guard false-positive --file src/x.ts --line 42 \
  --rule eslint/eqeqeq --reason "this compares a user-input form string"

npx fe-guard false-positive --summary   # which rules / check types are flagged most
npx fe-guard false-positive --list      # all records (time, file, reason)
npx fe-guard false-positive --suggest   # per-rule suggestions to downgrade/disable
```

Records are written to `.fe-guard/false-positives.jsonl` — append-only, never rewritten, auditable. The boundary must be clear: **marking a false positive does not make `check` ignore the violation**; it is only evidence. To downgrade, change `level`; to disable, change `enabled` — and go through review.

## 8. Acceptance criteria and evidence

When you drive a task through the MCP workflow, each criterion is structured:

```json
{ "text": "empty state shows 0 items", "type": "ui", "source": "design/spec-v3#empty" }
```

- `type` is one of `ui` / `interaction` / `data` / `tracking` / `compat` / `performance`; `source` records where it came from. A guess becomes `source: "assumption: <reason>"`.
- An `assumption` criterion needs a human: `npx fe-guard task confirm C2 --note "..." --yes`. Unconfirmed assumptions block delivery.
- Prefer `testFile` when the criterion can be tested. Otherwise `verify: "manual"` needs an `evidenceFile` (screenshot notes, reconciliation record); the gate checks it exists and is non-empty and records bytes + sha256.
- After a failed gate, record a retrospective with `task_lesson` (text + evidence + scope). `workflow.distill` defaults to `enforce`, so delivery waits for it; use `warn` / `off` only deliberately.
- Progress is reported as "N done / M deferred" (plus remaining). Deferred criteria mark the delivery `degraded`; the tools never say "all done".

`npx fe-guard task stats` gives a read-only view of delivery / degraded tasks, gate failure rate, average gates, top blockers, lessons and deferred criteria across the current task and archives.

## Common commands

```bash
npx fe-guard init                 # generate config / baseline / AGENTS.md snippet / IDE artifacts
npx fe-guard init --force         # overwrite existing config and baseline (use with care)

npx fe-guard baseline             # record current violations as the baseline (refuses widening)
npx fe-guard baseline --widen     # explicitly accept new debt
npx fe-guard baseline --follow-renames  # migrate ledger entries for renamed files (git add first; keeps an audit trail)
npx fe-guard baseline --show      # ledger grouped by file: rules, counts, first-recorded dates
npx fe-guard baseline --show --by-rule # aggregate by rule, sorted by cleanable count (which three to fix first)
npx fe-guard baseline --show --all # expand all when there are many files
npx fe-guard baseline --verify    # compare against merge-base; widening not registered in the baseline fails outright
npx fe-guard baseline --verify --base origin/main  # specify the base explicitly

npx fe-guard doctor               # current profile, per-check coverage, skips, last durations, baseline size
npx fe-guard doctor --profile fast --json # same content, machine-readable (includes emptyChecks)

npx fe-guard check                # full check (default profile full; only new violations listed individually)
npx fe-guard check --full         # explicitly run the full profile (equivalent to --profile full)
npx fe-guard check --profile fast # fast profile: ESLint/deps/ui/metrics, for hooks
npx fe-guard check --all          # list legacy violations individually too
npx fe-guard check --diff-only    # only source files touched by this change (working tree + staged + untracked)
npx fe-guard check --staged       # check staged content (for the pre-commit hook)
npx fe-guard check --json         # stdout emits only the JSON report
npx fe-guard check --config ./configs/fe-guard.alt.json  # use a different config
FE_GUARD_CONFIG=./configs/fe-guard.alt.json npx fe-guard check  # via environment variable
npx fe-guard --version            # print fe-guard's own version

npx fe-guard false-positive --file src/x.ts --line 42 --rule eslint/eqeqeq --reason "..."
npx fe-guard false-positive --list / --summary / --suggest

npx fe-guard task                 # current task, acceptance criteria and gate evidence
npx fe-guard task events          # event stream (audit what the AI did and tried to bypass)
npx fe-guard task reset --yes     # archive the current task and clear it (archived to .fe-guard/tasks/)
npx fe-guard task stats           # read-only delivery / gate / lesson stats across the current task and archives
npx fe-guard task confirm C2 --note "..." --yes   # confirm an assumption criterion
npx fe-guard task defer C3 --reason "..." --yes   # turn a criterion into a release todo
npx fe-guard mcp                  # start as an MCP stdio server (what the IDE mounts)

npx fe-guard check --root ../app  # specify the project root (defaults to the current directory)
```

The difference between `--diff-only` and `--staged`:

- `--diff-only`: working-tree changes relative to `diff.base` (default `HEAD`) + staged changes + untracked new files.
- `--staged`: checks **the content of the staging area** (exported to a temporary shadow directory), ideal for pre-commit. If you edit a file after staging without re-adding it, it won't be mistakenly treated as passing. ESLint / deps / ui / metrics read the shadow directory; TypeScript / boundaries / diff-size still read the working tree, and the report marks this explicitly. It also works when the project root is a subdirectory of the git root (frontend and backend in one repo): the snapshot only exports files under the project root, and checks automatically shift to that subdirectory.

In both modes, the baseline only tightens entries for files within the current scope — it never accidentally drops other files' entries.

## doctor: one command answers "what's still missing here"

When there's no CI and nobody reads the README, `doctor` is the main adoption entry point. It only does read-only probing, never runs checks, and can be run at any time:

```sh
npx fe-guard doctor
npx fe-guard doctor --profile fast --json
```

Real output (from a copy of a real repository):

```
fe-guard doctor  (profile: full)
配置: fe-guard.config.json
档位: full — 全量核对用：包含类型检查、架构边界与大 diff
workspace: 单仓库（未检测到 workspaces / pnpm-workspace.yaml / lerna.json）

检查覆盖:
  ESLint      覆盖 1 个仓库  上次 1.7s
  TypeScript  覆盖 1 个 package  耗时未知（跑一次 check 后显示）
      （Vue 项目，全档会用 vue-tsc）
  架构边界        已关闭（配置里已关闭）
  依赖守卫        覆盖 402 个文件  上次 1.4s
  组件清单        覆盖 225 个文件  上次 1.3s
  腐化指标        覆盖 402 个文件  上次 1.2s
  大 diff      覆盖 1 个仓库  耗时未知（跑一次 check 后显示）
      只在全档执行

baseline: 1276 行 / 136 文件 / 771 条规则型（17 条规则）+ 185 条指标型
```

It answers four things: what the current profile runs; which packages each check covers and which are skipped; each check's last duration; the baseline size. `--json` also provides `emptyChecks` (checks with zero coverage), so scripts can tell which checks are empty.

## Adoption: local hooks + manual full profile

fe-guard does not assume the **target project** has CI — its use cases include "code lives on the intranet, with no shared remote pipeline". The only execution point can be the developer's own machine:

- **Before commit**: `npx fe-guard check --staged --profile fast` — staged content only, target under 3 seconds.
- **Before merge / periodically**: `npx fe-guard check --full` — includes `tsc` / `vue-tsc`, architecture boundaries, and the large-diff guard.
- **After changing the baseline**: `npx fe-guard baseline --verify --base <target-branch>` — confirm there is no silent widening without `--widen`.
- **Before adoption / when handing over**: `npx fe-guard doctor` — first see which checks actually cover this repo and which are empty.

### Pre-commit hook (Husky)

See the example at [`examples/husky-pre-commit`](../examples/husky-pre-commit):

```sh
# .husky/pre-commit
npx fe-guard check --staged --profile fast
```

Only staged content is checked, so speed stays predictable; if the check fails, the commit is blocked. `git commit --no-verify` can still bypass it — that's a team-convention issue; the tool doesn't fight it.

### About CI

fe-guard's **own development repository** has GitHub Actions (`.github/workflows/ci.yml` runs `verify:local`). But it does not require the **target project** to have CI: leaving a pipeline file that never runs in an intranet project makes whoever takes over believe "CI already has us covered", and they skip the local hook — the only thing that actually executes. If the target project does connect any pipeline (Jenkins / GitLab / self-hosted / GitHub Actions), just move this one command over; no tool changes needed:

```sh
npm run verify:local   # inside the fe-guard repo: npm test + all v1/v2/v3/v4 verifications + self-check
# inside the target project, CI only needs: npx fe-guard check --full
```

### SARIF for GitHub Code Scanning

`check --format sarif` prints SARIF 2.1.0 to stdout, ready to upload:

```yaml
permissions:
  contents: read
  security-events: write   # required by upload-sarif
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 22 }
      - run: npm i -D github:luffy-lcc/fe-guard
      - id: guard
        run: npx fe-guard check --full --format sarif > fe-guard.sarif
        continue-on-error: true          # upload first, fail the job afterwards
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with: { sarif_file: fe-guard.sarif }
      - if: steps.guard.outcome == 'failure'
        run: exit 1
```

- **Only new violations and `not-executed` results are emitted.** Existing debt already lives in the baseline; uploading it would flood the alerts page and then make alerts vanish as the baseline tightens. The exit code is still 0/1/2, so CI keeps failing on new violations.
- **Boundaries results are file-level.** dependency-cruiser has no line numbers, so `region` is omitted — GitHub pins the alert to the file, not a line. Nothing is fabricated.
- `not-executed` results keep `level: error`, the invocation sets `executionSuccessful: false`, and a tool notification is attached, so a check that never ran can't look like a pass.
- Requires code scanning to be available for the repository (GitHub Advanced Security for private repos); otherwise just keep `npx fe-guard check --full` as the gate.

### Static HTML report

`check --format html` writes a single self-contained file next to the JSON report (default
`.fe-guard/report.html`, following `report.path`), prints its path, and leaves the exit code
untouched. CSS and the small filter script are inlined — no CDN, fonts, images or links — so
it opens offline and works as a CI artifact. With JavaScript disabled the full table is still
rendered; the script only filters rows.

```yaml
      - run: npx fe-guard check --full --format html
        continue-on-error: true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: fe-guard-report
          path: .fe-guard/report.html
```

The page lists every violation (new, existing, `not-executed`), each check's status
(`unavailable` / `skipped` are called out), the baseline tightening/removal trail and per-check
timings. It is a snapshot of one run — trends come later.

### Baseline trend

`fe-guard baseline --trend [--limit <n>] [--json]` reads the committed history of
`fe-guard.baseline.json` and prints one row per commit: total accepted violations, the delta,
the ratchet key count and how many explicit widens happened. It answers "are we actually
paying down debt?" without storing any second source of truth — nothing is written.

- Only **committed** history counts. If the baseline is not tracked yet, the command says so
  (and exits 0); commit it so every developer and CI share the same ledger.
- `--json` returns `{ available, path, truncated, versions, summary, latestWidenLog }`.
- Widens count only explicit `--widen` events; initial adoption and rename migration are not
  "widening". `firstSeen` dates drive the "last 30 days" line.

### Task event summary

`fe-guard task events --summary [--json]` aggregates the current task's event stream without
adding state: event counts by type, gate runs (passed/failed, modes, last result, worst
single-run new-violation count), rejected tool calls by tool and reason, criteria coverage,
and whether the task was delivered (and whether that delivery was degraded).

## Intranet distribution: two paths, pick one

This does not depend on whether a private npm registry exists. Both paths deliver the same package; upgrades and rollbacks follow "the version locked in the project".

### Route A: private registry (use it if you have one)

```sh
# maintainer (with publish access to the registry)
npm publish --registry https://npm.internal.example.com

# consuming project
npm i -D fe-guard --registry https://npm.internal.example.com
npx fe-guard --version
```

Upgrade: `npm i -D fe-guard@0.5.0`. Rollback: `npm i -D fe-guard@0.4.0`. Commit `package-lock.json` in the project so everyone installs the same version.

### Route B: install the tarball directly (works without a registry)

```sh
# on the maintainer's machine
npm pack                      # produces fe-guard-0.5.0.tgz
# send the tgz to consumers via intranet file share / scp / shared directory

# consuming project
npm i -D ./fe-guard-0.5.0.tgz
npx fe-guard --version
```

Upgrade: once you have the new tgz, `npm i -D ./fe-guard-0.5.0.tgz`. Rollback: `npm i -D ./fe-guard-0.4.0.tgz` (just keep the old tgz in the shared directory).

`npm pack` includes only `bin/`, `src/`, `examples/`, `README.md`, `README.zh-CN.md`, `LICENSE`, `CHANGELOG.md` — no tests or verification scripts. npm restores the executable bit on `bin` automatically, so `npx fe-guard` runs directly after install.

### One person maintaining many repos: where the cost is

- **Upgrading isn't "publish once and done"**: each repo locks its own version; you must `npm i -D` and verify repo by repo. Recommended: run it in one repo for a full two weeks before rolling out.
- **Configs will diverge**: thresholds and disabled checks differ across repos. When upgrading, change only the tool version — don't tweak configs along the way; commit config changes separately.
- **Schema incompatibility fails loudly**: when the config `schemaVersion` or baseline `version` is newer than the tool, the tool exits with code 2 and prints upgrade guidance — it never silently re-seeds. So the upgrade order is "upgrade the tool first, then decide whether to migrate the config".
