# Conversation-driven development in AI IDEs

[← Back to README](../README.md) · [简体中文](zh/workflow.md)

## Why not one big prompt

Writing the AI a rule like "write requirements first, then a plan, then run the checks" is basically unreliable: rule files as a whole do not improve success rates and add roughly 20% inference cost. Only one kind actually works — **non-standard conventions the model cannot guess from common sense**.

So the workflow layer does this:

- The workflow is made of **tools** (an MCP server). The AI must call tools to advance; stages are derived from the events the tools write.
- Hard rules live in **code**. There is no "mark the stage as passed" tool; nothing the model outputs can move a task into the delivered state.
- The generated rule file keeps only the shortest set of non-standard conventions (the AGENTS.md snippet is ~530 tokens, capped at 600).

## Connecting Trae

1. Run `npx fe-guard init` in the project (it writes `.trae/mcp.json`).
2. Open Trae's MCP panel, confirm `fe-guard` appears, and you should see 6 `task_*` tools and 1 `ui_lookup`.
3. `.trae/rules/fe-guard.md` is read as a project rule; `.trae/commands/` gains two slash commands, `/fe-guard-next` and `/fe-guard-gate`.

The generated config looks roughly like:

```json
{
  "mcpServers": {
    "fe-guard": {
      "command": "node",
      "args": ["./node_modules/fe-guard/bin/fe-guard-mcp.js"]
    }
  }
}
```

If fe-guard is not installed locally in the project (e.g. you use this repo's CLI directly), this is written as the absolute path of the current installation; after switching machines, just rerun `init`.

> macOS GUI apps do not load the shell's PATH: when node is installed under nvm / fnm, `command: "node"` may ENOENT — red error in the panel, 0 tools. Change both `command` and `args` to absolute paths. See the [FAQ](faq.md).

## Connecting Cursor

1. `npx fe-guard init` writes `.cursor/mcp.json`; confirm `fe-guard` is enabled under Settings → MCP.
2. `.cursor/rules/fe-guard.mdc` is set to `alwaysApply: true`, so Cursor reads it automatically.

## Connecting Claude Code / VS Code / Gemini CLI

`init` also writes these project-level configs, merging only its own `fe-guard` entry:

| Client | File | Shape |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `mcpServers.fe-guard` |
| VS Code (Copilot agent) | `.vscode/mcp.json` | `servers.fe-guard` with `"type": "stdio"` |
| Gemini CLI | `.gemini/settings.json` | `mcpServers.fe-guard`; the file's other settings are untouched |

Reload the client or reopen the project to pick up the server. Windsurf / Cline / Codex CLI are deliberately not written: they only accept user-level configuration, and fe-guard never touches your home directory.

All clients use the same server, the same `AGENTS.md`, and the same task state — switching tools needs no reconfiguration.

## What a conversation looks like after setup

You say: "Add a formatDuration utility to the project; 1 second should display as 1s."

The AI calls the following tools in order (every request and return value is visible in the IDE's tool panel):

| Step | Tool | Returns |
| --- | --- | --- |
| 1 | `task_start` | `{ ok, taskId, stage: "contract", next: "task_criteria" }` |
| 2 | `task_criteria` | `{ ids: ["C1","C2"], stage: "plan" }` |
| 3 | `task_plan` | `{ stage: "implement", next: "task_gate" }` |
| 4 | Edit code | — |
| 5 | `task_gate` | Passed: `{ ok: true, stage: "deliver", criteria: { total: 2, achieved: 2 } }` |

Criteria that can be written as tests can carry a `testFile` (repo-relative path, e.g. `{ text: "formatDuration(1000) returns 1s", testFile: "test/duration.test.mjs" }`). The gate really runs that test, and **only a pass covers the criterion**; the test command comes from the config `workflow.gate.testCommand` (default `node --test`) — the model can only supply a path, never a command.

When the gate does not pass, step 5 returns:

```json
{
  "ok": false,
  "stage": "verify",
  "criteria": { "total": 2, "achieved": 0 },
  "blockers": [
    "门禁未通过：新增 1 条违规（error 1）",
    "eslint/@typescript-eslint/no-explicit-any @ src/utils/math.ts:12",
    "验收条件未覆盖：C1"
  ],
  "next": "修复问题后再次调用 task_gate"
}
```

The AI fixes things according to the blockers and calls `task_gate` again. The tool never returns the full log (avoiding stuffing tens of thousands of lines back into context); when it needs details it reads `.fe-guard/report.json` itself.

## When the AI gets blocked

| What it tries | What actually happens |
| --- | --- |
| Edit code without writing a contract | With no task, `task_plan` / `task_gate` error out and tell it to `task_start` first |
| Write a plan without acceptance criteria | `task_plan` errors: criteria must come first |
| Declare "achieved" itself | No such tool; `task_criteria` only accepts `id` / `text` / `testFile` — passing `achieved` is rejected |
| Attach a testFile but write no test / let the test fail | The gate really runs the test: missing file, failure, and timeout all block; the result is written into the evidence |
| Declare "stage passed" itself | No such tool; `task_status` does not accept a `status` parameter either |
| Try to deliver with the gate not passed | Stays at `verify`; no delivery event is produced and the achieved-criteria count remains 0 |
| Rewrite the plan / start the task again | Rejected; an undelivered task cannot be `task_start`ed again |
| Edit the baseline to turn the gate green | `task_gate` only tightens the baseline; widening requires a manual `fe-guard baseline --widen` |

Rejected calls are recorded in the event stream (`tool.rejected`); `npx fe-guard task events` shows what the AI tried at the time.

## How stages are determined

There is no "set stage" API. `task.json` contains only events; the stage is derived from them:

```
no task              → none
task.started         → contract
+ criteria.declared  → plan
+ plan.written       → implement
+ gate.recorded      → verify
+ task.delivered     → deliver
```

When the gate passes on the first try, `implement` jumps straight to `deliver`; there is no intermediate "implementation complete" state for the model to judge — "is the implementation done" can only be answered by the gate anyway. That is also why there are 5 stages, not more.

## Rough token costs

| Item | Magnitude |
| --- | --- |
| `AGENTS.md` managed snippet (always resident) | ~530 tokens, capped at 600; `init` validates it |
| A single tool return | 200–600 bytes of JSON (the gate is the longest, with blockers); `ui_lookup` is usually under 300 bytes |
| `tools/list` (fetched once at IDE startup) | ~2.6 KB (7 tools) |

For comparison: the same workflow written as natural-language rules typically costs 800–1500 resident tokens and is not executable. Here the resident cost is squeezed to 530 tokens, with the decision logic inside the tools.

## Switches

```json
{
  "workflow": {
    "enabled": true,
    "gate": { "mode": "full", "testCommand": "node --test", "testTimeoutMs": 120000 },
    "stages": { "contract": "enforce", "plan": "enforce", "verify": "enforce" }
  }
}
```

| Field | Description |
| --- | --- |
| `workflow.enabled` | When `false`, only `task_gate` remains; falls back to pure-check mode, and workflow tools explicitly refuse |
| `workflow.gate.mode` | Gate scope: `full` / `diff-only` / `staged` |
| `workflow.gate.testCommand` | Test command for criteria with a testFile (default `node --test`; can be changed to `npx vitest run` etc.). Configured by humans; the model only supplies file paths |
| `workflow.gate.testTimeoutMs` | Timeout for a single criterion's test (default 120000ms) |
| `workflow.stages.contract` | With `enforce`, criteria can only be written in the contract stage; `warn` allows adding them later; `off` imposes no restriction |
| `workflow.stages.plan` | With `enforce`, the gate cannot run without a plan |
| `workflow.stages.verify` | With `enforce`, a failed gate cannot cover acceptance criteria; `warn` allows coverage, but delivery is marked `degraded` |

`implement` / `deliver` have no separate switches: they are derived entirely from events, not decision points that can be widened.

## Hook examples

`init` generates `.trae/hooks.example.json` and `.cursor/hooks.example.json`, containing "run `check --diff-only --profile fast` after tool calls" and "run `check --staged --profile fast` at session end". They **do not take effect automatically** — you must move the commands into your IDE's hooks settings; event names depend on the version you use.

Neither IDE has a git pre-commit event; pre-commit blocking still goes through Husky + `fe-guard check --staged --profile fast`.
