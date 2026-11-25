# Configuration reference

[← Back to README](../README.md) · [简体中文](zh/configuration.md)

Configuration is JSON, not YAML: zero dependencies (no hand-written YAML-subset parser), built-in editor validation and completion, and no mysterious failures from bad indentation. Every field of `fe-guard.config.json`:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "profile": "full",
  "checks": {
    "eslint": {
      "enabled": true,
      "level": "error",
      "bin": "eslint",
      "args": ["--format", "json"],
      "targets": [],
      "workspace": "auto",
      "extensions": [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue"]
    },
    "typescript": {
      "enabled": true,
      "level": "error",
      "args": ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
      "vue": "auto",
      "workspace": "auto"
    },
    "boundaries": {
      "enabled": true,
      "level": "error",
      "bin": "depcruise",
      "args": ["src", "--output-type", "json", "--config", ".dependency-cruiser.cjs"],
      "workspace": "off"
    },
    "deps": {
      "enabled": true,
      "level": "error",
      "roots": ["src"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
      "internalPrefixes": ["@/", "~/", "src/"],
      "capabilities": {
        "date": {
          "allow": ["dayjs"],
          "block": ["moment", "date-fns", "luxon"],
          "exempt": ["src/utils/date.ts"],
          "useInstead": "src/utils/date.ts",
          "example": "import dayjs from 'dayjs';\ndayjs(ts).format('YYYY-MM-DD')"
        }
      },
      "registry": {}
    },
    "ui": {
      "enabled": true,
      "level": "error",
      "roots": ["src"],
      "extensions": [".vue", ".tsx", ".jsx"],
      "inventory": ".fe-guard/ui-inventory.json",
      "propOverlap": 0.8,
      "minProps": 2
    },
    "metrics": {
      "enabled": true,
      "level": "error",
      "roots": ["src"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
      "maxFileLines": 500,
      "maxFunctionLines": 100,
      "maxAny": 20,
      "overrides": {
        "apps/legacy": { "maxFileLines": 800, "maxFunctionLines": 150, "maxAny": 50, "duplication": { "maxRatio": 0.6 } }
      },
      "duplication": {
        "windowTokens": 50,
        "minTokens": 200,
        "maxRatio": 0.5,
        "normalizeIdentifiers": false,
        "ignore": ["**/locales/**", "**/i18n/**", "**/lang/**"]
      }
    },
    "diff-size": {
      "enabled": true,
      "level": "error",
      "maxFiles": 20,
      "maxLines": 600,
      "ignore": ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "*.min.js", "dist/**", ".fe-guard/**", "fe-guard.baseline.json"]
    }
  },
  "baseline": {
    "path": "fe-guard.baseline.json",
    "strategy": "root",
    "packageFile": "fe-guard.baseline.json",
    "autoTighten": true
  },
  "report": { "path": ".fe-guard/report.json" },
  "feedback": { "path": ".fe-guard/false-positives.jsonl" },
  "diff": { "base": "HEAD" },
  "workflow": {
    "enabled": true,
    "gate": { "mode": "full", "testCommand": "node --test", "testTimeoutMs": 120000 },
    "stages": { "contract": "enforce", "plan": "enforce", "verify": "enforce" },
    "preflight": { "command": "", "timeoutMs": 60000 },
    "distill": "enforce"
  }
}
```

| Field | Description |
| --- | --- |
| `schemaVersion` | Config schema version. If newer than the current tool, exits with code 2 and prompts you to upgrade the tool; new fields are never silently ignored |
| `profile` | Default profile: `full` (default) or `fast`. CLI `--profile` / `--full` overrides it temporarily |
| `enabled` | Global master switch. When `false`, `check` passes immediately (exit code 0, report marked `skipped`) — an emergency stopgap |
| `checks.<name>.enabled` | Per-check switch; absent means disabled. Old configs lack `deps` / `ui` / `metrics` / `diff-size`; after upgrading they stay disabled by default, so nothing suddenly turns all red. `init` probes the project first and writes `false` for checks whose prerequisite is missing (no tsconfig → `typescript`, no ESLint config → `eslint`, no `.dependency-cruiser.{cjs,js,json}` → `boundaries`); turn one back on once the prerequisite exists |
| `checks.boundaries.workspace` | `off` (default) or `auto`. With `auto` in a monorepo, a second dependency-cruiser pass scans every package and flags **relative-path imports that cross a package boundary** (`boundaries/workspace-cross-package`). Your own `.dependency-cruiser.cjs` is untouched; package-entry imports are allowed. `init` writes `auto` when it detects a workspace plus a dependency-cruiser config |
| `checks.<name>.level` | `error` or `warn`. With `warn`, new violations from this check are reported but do not block |
| `checks.<name>.bin` / `args` | The command actually executed. By default the same-named command in the project's `node_modules/.bin` is preferred; PATH is the fallback (external three checks only). For `typescript`, **omit `bin`** so the check auto-selects `vue-tsc` for Vue projects and `tsc` otherwise; writing `"bin": "tsc"` explicitly disables the Vue switch and `.vue` files won't be type-checked |
| `checks.eslint.targets` | Which directories ESLint scans in a full check. Empty array = auto: scan only `src/` if it exists, otherwise the repo root — avoids linting `dist/` or `docker/static` along the way |
| `checks.eslint.workspace` | `auto` (default) detects monorepos and runs per package with each package's own config; `root` falls back to "run once at the repo root" |
| `checks.typescript.vue` | `auto` (default) switches to `vue-tsc` when Vue is detected, so type errors inside `.vue` are checked; `false` explicitly accepts running `tsc` only |
| `checks.typescript.workspace` | `auto` (default) runs with each package's own tsconfig; `root` falls back to a single run at the root |
| `checks.*.timeoutMs` | Subprocess timeout (ms, default 120000). If ESLint / tsc / vue-tsc / depcruise hangs: SIGTERM first, SIGKILL after 2s, producing a non-baselineable `<check>/not-executed` |
| `checks.eslint.extensions` | Only affects the file filter passed to ESLint in diff-only mode, and the "are there any files to check this time" decision |
| `checks.deps.roots` / `extensions` | Which directories and extensions to scan for imports; `.d.ts` is excluded (generated declaration files often import virtual packages) |
| `checks.deps.internalPrefixes` | Prefixes treated as in-project references, not third-party packages |
| `checks.deps.capabilities` | "Capability → single library" mapping. `allow` is the correct library, `block` the forbidden ones, `exempt` the wrapper layer allowed to import directly (e.g. `src/utils/date.ts`), `useInstead` the replacement file, and `example` appears verbatim in the error. Only `date` is provided by default; `http` must be configured explicitly per repo |
| `checks.deps.registry` | Purpose registry for new dependencies: `{ "package-name": "where it is used, why existing implementations won't do" }`. An unregistered runtime dependency fails `deps/unregistered` |
| `checks.ui.inventory` | Component inventory output path (add it to `.gitignore`; it is rebuilt on every check) |
| `checks.ui.propOverlap` | Props overlap threshold (Jaccard, 0–1); reaching it triggers a warning |
| `checks.ui.minProps` | Both sides must have at least this many props before comparison, avoiding false positives on simple components |
| `checks.metrics.maxFileLines` | Max lines per file (default 500; 800 recommended for large legacy repos) |
| `checks.metrics.maxFunctionLines` | Max lines of the longest function (default 100; 150 recommended for legacy repos) |
| `checks.metrics.maxAny` | Max explicit `any` count per file (default 20) |
| `checks.metrics.overrides` | Override thresholds by directory prefix (longest-prefix match): `{ "apps/legacy": { "maxFileLines": 800, "duplication": { "maxRatio": 0.6 } } }`. Decoupled from workspace detection — works for monorepo packages and legacy areas of single repos alike; only the four threshold fields are allowed |
| `checks.metrics.duplication` | Cross-file duplicate-block detection: window token count, minimum block size, maximum allowed ratio, skipped paths (locales/i18n skipped by default — entries are naturally isomorphic) |
| `checks.metrics.duplication.normalizeIdentifiers` | Default `false`. When enabled, non-keyword identifiers are normalized by first-appearance order, so copy-and-rename duplicates are caught too; the cost is hits on structurally similar but semantically different code — record those as false positives |
| `checks.diff-size.maxFiles` / `maxLines` | Max changed files / added lines for this change; exceeding either fails |
| `checks.diff-size.ignore` | Paths ignored in large-diff counting (lock files, build output, `.fe-guard/`, the baseline itself) |
| `baseline.strategy` | `root` (default) keeps one repository-wide ledger and changes nothing for existing configs; `package` gives each workspace package its own ledger. `package` requires a detected workspace (`workspaces` / `pnpm-workspace.yaml` / `lerna.json`); single repos must keep `root` |
| `baseline.packageFile` | Ledger filename used by package mode, relative to **each package directory** (default `fe-guard.baseline.json`, so `apps/web/fe-guard.baseline.json`). Absolute paths and `..` are rejected. Keep it inside a tracked directory — a ledger under a gitignored path won't be committed |
| `baseline.autoTighten` | Default `true`: when `check` passes, fixed legacy violations are written back to the baseline (both the count and metric ledgers tighten). Set `false` in read-only environments |
| `feedback.path` | Output path for false-positive records (JSONL). Append-only and auditable; `check` never reads it as an ignore list |
| `report.path` | Report file path |
| `diff.base` | Comparison base for `--diff-only` and large-diff counting; can be changed to e.g. `origin/main` |
| `workflow.preflight` | `{ command, timeoutMs }` environment preflight. Empty `command` (default) = off. When set, a failure makes `task_start` create no task and makes `task_gate` report "this check was not executed" — no evidence, criteria not covered. `timeoutMs` defaults to 60000 |
| `workflow.distill` | `enforce` (default) / `warn` / `off`. With `enforce`, a task cannot be delivered until a `task_lesson` is recorded after the last failed gate; `warn` allows delivery but marks it `degraded`; `off` disables the requirement |
| `workflow.*` | Workflow-layer switches; see [Workflow switches](workflow.md#switches) |

Acceptance-criterion fields (`type` / `source` / `verify` / `testFile` / `evidenceFile`) belong to the task contract, not this config file; see [Acceptance criteria](workflow.md#acceptance-criteria-type-source-verification).

Do not put target files/directories in `args` (e.g. ESLint's `.`): fe-guard automatically appends the full targets or the changed-file list at the end.

**Emergency shutdown**: edit the config file only — do not add `eslint-disable` in code or skip hooks.

- Disable everything: `"enabled": false`
- Downgrade to warnings: `"checks": { "eslint": { "level": "warn" } }`
- Disable one check only: `"checks": { "boundaries": { "enabled": false } }`

## Monorepo and Vue projects

`check` reads `workspaces` from `package.json`, plus `pnpm-workspace.yaml` and `lerna.json`, expands declarations like `apps/*` and `packages/**`, then:

- **ESLint and TypeScript run per package**, each using the config in its own directory (when ESLint finds no local config it inherits upward to the repo root; packages with no config even at the root are skipped without error).
- **Root-level checks — deps / ui / metrics / boundaries — run only once**, but the default scan root `src` is automatically expanded to each sub-package's source directory.
- Packages run **in parallel**; the report includes per-package timings, and stdout prints the total time per check.
- If a package has a config but execution fails (e.g. the ESLint config itself throws), the check **fails outright and names the package** — never silently counted as passed.

**Baseline can also be per package.** Set `"baseline": { "strategy": "package", "packageFile": "fe-guard.baseline.json" }` (package mode requires the workspace detection above). Root-level files stay in `baseline.path`; each package's files go to `<package>/<packageFile>`. For an existing repo, run `npx fe-guard baseline --migrate-packages` once to split the root ledger, commit the result, then run `npx fe-guard check`. `baseline --show` / `--verify` / `--trend` accept `--package <name|rel>`. Root mode remains the default. See [monorepo: per-package ledgers](baseline.md).

To fall back to "run once at the repo root":

```json
{ "checks": { "eslint": { "workspace": "root" }, "typescript": { "workspace": "root" } } }
```

When a Vue project is detected (`.vue` files present, or `vue` in dependencies), the TypeScript check automatically switches to `vue-tsc --noEmit`, checking type errors in both `<script setup>` and `<template>`. The key safety floor: **if the project has `.vue` files but vue-tsc is not installed / not executable, the check fails**, reporting a `typescript/vue-tsc-missing` that can never enter the baseline.

- Vue 3 + TS 5: `npm i -D vue-tsc typescript` (vue-tsc 2.x or 3.x)
- Vue 2.7 / older TS: `npm i -D vue-tsc@1.8`
- **TypeScript 7 is not supported by any vue-tsc version yet** (TS 7 no longer exports `typescript/lib/tsc`); Vue projects must stay on `typescript@5`
- Version mismatches (vue-tsc 2.x + TS 4.x, Vue 2 + vue-tsc 2.x, Vue + TS 7) error out directly instead of producing a fake result
- Explicitly accept "don't check `.vue`": `"checks": { "typescript": { "vue": false } }`

**Architecture boundaries (boundaries) and Vue**: depcruise only includes `.vue` in the dependency graph if it can resolve `@vue/compiler-sfc` (or `vue-template-compiler` for Vue 2) from its own install location. When missing, it does not error — it silently skips `.vue`. fe-guard compares the `.vue` count on disk with the count in the graph; if incomplete it reports `boundaries/not-executed` rather than a fake 0. Since depcruise 18, tsconfig aliases are written as `options.tsConfig: { fileName: 'tsconfig.json' }` (the old `tsConfigFile` is deprecated; invalid configs are rejected by schema validation).

**Project root ≠ git root (frontend and backend in one repo)**: fe-guard can attach to a subdirectory with `--root frontend`; since v6.2 all git-dependent features have correct path semantics: the `--staged` snapshot exports only tracked files under the subdirectory and offsets paths automatically; `diff-size` / `--diff-only` count only changes inside the subdirectory; rename migration and `--verify` reading the HEAD ledger use cwd-relative paths. Put the hook at the git root's `.git/hooks/pre-commit`, `cd` into the subdirectory, and run `check --staged --profile fast`.
