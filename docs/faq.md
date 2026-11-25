# FAQ and troubleshooting

[← Back to README](../README.md) · [简体中文](zh/faq.md)

**`fe-guard: 未找到 fe-guard.config.json`**
Run `npx fe-guard init` in the project root first, or point to the right path with `--root` / `--config`.

**`运行 eslint 失败：找不到可执行文件：eslint`**
The target project doesn't have ESLint installed. Run `npm i -D eslint`, or set `checks.eslint.enabled` to `false`. Same for tsc and dependency-cruiser.

**`eslint 输出不是合法 JSON`**
`checks.eslint.args` must include `--format json` (the default config already does). If you override `args`, remember to keep it.

**`git diff 执行失败` / the base branch does not exist**
`--diff-only` requires a git repository. If `diff.base` is set to `origin/main`, run `git fetch origin main` first. To check only current uncommitted changes, use the default `HEAD`.

**The check passed, but the baseline changed**
That's auto-tightening: you fixed legacy violations, so `check` lowered the allowed counts. This is expected — commit the baseline changes along with your fix. If the runtime environment is read-only, set `"baseline": { "autoTighten": false }`.

**I want to accept a batch of new debt**
`npx fe-guard baseline --widen` — it lists every `(file, rule)` pair about to be widened, one by one. Don't use it routinely.

**Upgraded ESLint / TS and suddenly a batch of new rule violations appears**
Record them with `--widen` first (state the reason), then schedule cleanup separately; or downgrade the affected rules to `warn` for now.

**`--diff-only` is still slow on a large repo**
ESLint runs only on changed files, but tsc and dependency-cruiser still need full analysis (otherwise the type and dependency graphs are incomplete); fe-guard merely filters their results by changed files.

**Why is `line` null in the report?**
dependency-cruiser's JSON provides no line numbers, only "who depends on whom". ESLint and tsc violations all have line numbers.

**fe-guard doesn't show up in the Trae / Cursor MCP panel**
First confirm the project root has the config for your client — `.trae/mcp.json` (Trae), `.cursor/mcp.json` (Cursor), `.mcp.json` (Claude Code), `.vscode/mcp.json` (VS Code, under `servers`) or `.gemini/settings.json` (Gemini CLI) — containing a `fe-guard` entry, then reload the project. Verify manually that the server starts: `node ./node_modules/fe-guard/bin/fe-guard-mcp.js` (it waits for stdin; Ctrl+C to exit), or `npx fe-guard mcp`. When troubleshooting, set `FE_GUARD_DEBUG=1` — errors go to stderr.

**MCP config loads fine, but the panel shows a red error and 0 tools**
If the log only shows "config loaded / server added" with no connection record, the process most likely never started: macOS GUI apps don't load the shell's PATH, so when node is installed under nvm / fnm, `command: "node"` fails with ENOENT. Change `command` and `args` in `mcp.json` to absolute paths (node executable + script + `--root`), independent of PATH and cwd. nvm paths contain version numbers — update them when you switch node versions.

**The AI keeps saying "call task_start first"**
That's expected: without a task, the workflow won't let it write a plan or run the gate. Just state the requirement clearly — it should call `task_start` on its own.

**The task is stuck at verify**
Run `npx fe-guard task` to see the blockers, fix them, then have the AI call `task_gate` again; `npx fe-guard task events` shows the full timeline. Blockers can include unconfirmed `assumption` criteria (human `task confirm`), missing manual evidence, or a missing lesson after a failed gate (`task_lesson`).

**Why do criteria need `type` and `source`?**
A plain text list lets a task look complete while whole categories are missing, and makes "where did this come from" unanswerable. `type` forces a check for interaction / data / tracking / compat / performance criteria, and `source: assumption: ...` marks guesses that a human must confirm before delivery.

**Why are `confirm` / `defer` CLI-only?**
They are human decisions: confirming an assumption or accepting a release todo changes what "done" means. As MCP tools the model could approve itself. The CLI requires `--note` / `--reason` and `--yes`, and leaves an auditable event in the task stream.

**What should the preflight command do? What if it fails?**
Put whatever must be true before verification is meaningful — for example `npm run check:env` verifying a local API, generated types or required environment variables. If it fails, `task_start` creates no task and `task_gate` reports "this check was not executed" (no evidence, criteria not covered). fe-guard never starts your dev server or logs in for you.

**Why can't I deliver after a failed gate? How do I turn it off?**
`workflow.distill` defaults to `enforce`: after the last failed gate, a `task_lesson` (text + evidence + scope) is required. Set it to `warn` to allow delivery marked `degraded`, or `off` to disable the requirement. Don't write a fake lesson just to pass.

**Where does `task stats` data come from?**
It replays the event stream of the current `.fe-guard/task.json` plus `.fe-guard/tasks/*.json` archives. It is read-only and writes nothing; corrupt archive files are skipped and counted, and deleting an archive removes it from future stats.

**Want to skip the workflow temporarily for an urgent fix**
Set `workflow.enabled` to `false` in `fe-guard.config.json` (checks only), or run `npx fe-guard check` yourself. Don't edit the baseline to "manufacture a pass".

**Should task state files be committed?**
`.fe-guard/` is local working state (reports, component inventory, and the current task) — add it to `.gitignore`. `fe-guard.baseline.json` must be committed.
