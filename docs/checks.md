# Checks: how AI-written code rots a repository

[← Back to README](../README.md) · [简体中文](zh/checks.md)

Let's be clear up front: the AI is not deliberately writing the repo into a mess. It only looks at the task in front of it each time, and it produces output far faster than humans can read. So these very concrete phenomena show up:

| What you see | What is actually happening | The check that blocks it | Default behavior |
| --- | --- | --- | --- |
| The project already has `dayjs`, yet new code does `import moment` | Two toolsets for the same capability; bundle size, timezone behavior, and upgrade cadence all split | `deps` | Errors and directly gives the correct library, the wrapper file path, and an example |
| A wrapped `http` already exists, but the AI does `import axios` directly | Auth, retries, and tracking are bypassed; production issues become hard to debug | `deps` | Errors, pointing at `src/services/http.ts` |
| A new package is installed and nobody knows why | Dependencies only grow; six months later nobody dares remove them | `deps` | A new dependency in `package.json` without a registered purpose fails |
| A `UserCard` already exists, and the AI writes another near-identical one | Two implementations evolve separately; fix one, miss the other | `ui` | Same name errors; highly overlapping props warn |
| A file grows from 200 lines to 800 | Nobody can read it end to end; change risk rises exponentially | `metrics` | Fails once the configured line count is exceeded |
| A chunk of logic is copy-pasted into a new file | Fixing a bug means fixing two places, and the second is always forgotten | `metrics` | Fails when cross-file duplicate token blocks exceed the ratio |
| `any` everywhere to make errors disappear | Type checking becomes a formality; every later change runs naked | `metrics` | Fails when the `any` count exceeds the configured limit |
| One PR touches 40 files and 2000 lines | Review can only skim; every quality issue leaks through here | `diff-size` | Fails past the file/line limits and gives splitting steps |

## How each check detects

- **Dependency guard (`deps`)**: reads `import` / `export ... from` / `require` / dynamic `import()` in source, matches package names against `package.json` (in a monorepo, dependencies are merged from the nearest package.json + ancestor workspaces); then applies the configured "capability → single library" mapping. New dependencies in `package.json` are compared against the git base once, not rescanned in full every run.
- **Component inventory (`ui`)**: scans `.vue` / `.tsx` / `.jsx`, extracts component names, props, and emits, and writes `.fe-guard/ui-inventory.json`. Same names are graded by directory: involving the `src/components/` shared directory reports `error` (a shared component was rebuilt); same names only within separate feature directories report `warn` (common across business partitions); `index.*` entry files are excluded from same-name detection. High props overlap always warns.
- **Rot metrics (`metrics`)**: per-file line count, longest function line count, `any` count, and cross-file token n-gram duplication ratio. Duplication detection only compares cross-file windows; for `.vue` only `<script>` is compared; locales/i18n are skipped by default. All four use a "value ratchet": the baseline records the **allowed maximum**, not a count.
- **Large-diff guard (`diff-size`)**: `git diff --numstat --relative` counts files and added lines under the project root; exceeding the thresholds fails. When the project root is a subdirectory of the git root, only changes inside the project count — sibling directories (e.g. backend) do not. **It deliberately stays out of the baseline** — a large diff is "an event of this change", not historical debt; recording it would permanently close the gate.
- **ESLint / TypeScript / architecture boundaries**: run the project's own `eslint`, `tsc` (automatically `vue-tsc` for Vue projects), and `depcruise` respectively; fe-guard only orchestrates and normalizes output — it does not reimplement rules.

## Why the component inventory is queried on demand instead of written into context

The component inventory grows with the project. Stuffing it into `AGENTS.md` or every conversation's context trades permanent tokens for occasionally-used information — and it goes stale the moment the inventory updates.

So the inventory lives on disk and is queried on demand only through the MCP tool `ui_lookup`: the AI queries once before writing a component and gets at most 5 summaries (name, file, first 8 props/emits), usually under 300 bytes. `AGENTS.md` keeps just one line: "run `ui_lookup` before writing a component". It stays a standalone tool, not stuffed into the `task_*` state machine: a query advances no stage, writes no events, and returns a smaller payload.

## What this tool inherently cannot catch (the honest version)

- **"Should this be reused" is a semantic judgment**. Two components with different names and differently split props can still be business duplicates; `ui` cannot catch that — it only catches same names and highly overlapping props.
- **Reformatting / reordering statements after copying**. `metrics` duplication detection is based on token sequences; line-break changes and reordering make it see "no duplication". "Copy then rename" can be caught by enabling `duplication.normalizeIdentifiers` (off by default).
- **Dynamic dependencies**. `require(someVariable)` and package names assembled at runtime are invisible to static parsing.
- **Generated code**. Lock files, `dist/`, and `*.min.js` are ignored by default; if your code generator's output lives under `src/`, add it to `diff-size.ignore` yourself or raise the thresholds.
- **Small-diff, big-rewrite inside one file**. `diff-size` only counts added/removed lines; rewriting a 500-line file wholesale while adding only 20 lines will not trigger it, and the `metrics` file line count may not change either.
- **Whether the team actually reviews**. The tool can only turn a "large diff" into a failure; it cannot guarantee humans read carefully. That is a process problem, not a detection problem.

For real-repository measurements, per-item false-positive judgments, and the bug-fix list, see the [real-world report](real-world.md).
