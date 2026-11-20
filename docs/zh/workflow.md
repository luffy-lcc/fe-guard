# 在 AI IDE 里用对话驱动开发

[← 返回 README](../../README.zh-CN.md) · [English](../workflow.md)

## 为什么不写一大段提示词

给 AI 写一段「请先写需求、再写计划、最后跑检查」的规则，基本靠不住：规则文件整体并不提升成功率，反而增加约 20% 推理成本。真正有效的只有一类——**模型靠常识猜不到的非标准约定**。

所以流程层的做法是：

- 流程做成**工具**（MCP server）。AI 必须调用工具才能推进，阶段由工具写下的事件推导。
- 硬规则写在**代码**里。没有「把阶段标记为通过」的工具，模型输出什么都无法让任务进入交付态。
- 生成出来的规则文件只留最短的那部分非标准约定（AGENTS.md 片段约 530 token，上限 600）。

## 挂到 Trae

1. 在项目里执行 `npx fe-guard init`（已写入 `.trae/mcp.json`）。
2. 打开 Trae 的 MCP 面板，确认出现 `fe-guard`，能看到 6 个 `task_*` 工具和 1 个 `ui_lookup`。
3. `.trae/rules/fe-guard.md` 作为项目规则被读取；`.trae/commands/` 下多了两个斜杠命令 `/fe-guard-next`、`/fe-guard-gate`。

生成的配置大致是：

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

如果项目里没有本地安装 fe-guard（比如直接用本仓库的 CLI），这里会写成当前这份安装的绝对路径；换机器后重跑一次 `init` 即可。

> macOS GUI 应用不加载 shell 的 PATH：node 装在 nvm / fnm 下时，`command: "node"` 可能 ENOENT，面板红错、0 个工具。把 `command` 与 `args` 全改成绝对路径即可。详见 [FAQ](faq.md)。

## 挂到 Cursor

1. `npx fe-guard init` 已写入 `.cursor/mcp.json`，在 Settings → MCP 里确认 `fe-guard` 已启用。
2. `.cursor/rules/fe-guard.mdc` 已设 `alwaysApply: true`，Cursor 会自动读取。

## 挂到 Claude Code / VS Code / Gemini CLI

`init` 还会写这几个客户端的项目级配置，只合并自己的 `fe-guard` 条目：

| 客户端 | 文件 | 结构 |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `mcpServers.fe-guard` |
| VS Code（Copilot agent） | `.vscode/mcp.json` | `servers.fe-guard`，带 `"type": "stdio"` |
| Gemini CLI | `.gemini/settings.json` | `mcpServers.fe-guard`；文件里的其它设置不动 |

重载客户端或重新打开项目即可加载。Windsurf / Cline / Codex CLI 刻意不写：它们只接受用户级配置，而 fe-guard 不碰用户 home。

所有客户端用同一个 server、同一份 `AGENTS.md`、同一份任务状态，换工具不用重配。

## 装完之后，对话是什么样

你说：「给项目加一个 formatDuration 工具函数，1 秒显示 1s」。

AI 会依次调用下面的工具（IDE 的工具面板里能看到每个请求和返回值）：

| 步骤 | 工具 | 返回 |
| --- | --- | --- |
| 1 | `task_start` | `{ ok, taskId, stage: "contract", next: "task_criteria" }` |
| 2 | `task_criteria` | `{ ids: ["C1","C2"], stage: "plan" }` |
| 3 | `task_plan` | `{ stage: "implement", next: "task_gate" }` |
| 4 | 改代码 | —— |
| 5 | `task_gate` | 通过：`{ ok: true, stage: "deliver", criteria: { total: 2, achieved: 2 } }` |

能写成测试的条件可以挂 `testFile`（仓库内相对路径，如 `{ text: "formatDuration(1000) 返回 1s", testFile: "test/duration.test.mjs" }`）。门禁会真跑这个测试，**通过才覆盖该条件**；测试命令来自配置 `workflow.gate.testCommand`（默认 `node --test`），模型只能给路径、不能给命令。

门禁没过时，第 5 步返回的是：

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

AI 按 blockers 去修，再调一次 `task_gate`。工具不会回传整份日志（避免把几万行塞回上下文），需要细节时它自己去读 `.fe-guard/report.json`。

## AI 在什么情况下会被拦住

| 它想干什么 | 实际发生 |
| --- | --- |
| 不写合同直接改代码 | 没有任务时 `task_plan` / `task_gate` 报错，提示先 `task_start` |
| 不写验收条件就写计划 | `task_plan` 报错：必须先写条件 |
| 自己宣布「已达成」 | 没有这个工具；`task_criteria` 只收 `id` / `text` / `testFile`，传 `achieved` 被拒 |
| 挂了 testFile 却不写测试 / 测试失败 | 门禁真跑测试：文件缺失、失败、超时都拦住，结果写进证据 |
| 自己宣布「阶段通过」 | 没有这个工具；`task_status` 也不接受 `status` 参数 |
| 门禁没过就想交付 | 停在 `verify`，不产生交付事件，条件达成数仍是 0 |
| 重复写计划 / 重复开任务 | 被拒绝；未交付的任务不能再次 `task_start` |
| 改 baseline 让门禁变绿 | `task_gate` 只会收紧 baseline；放宽必须手动 `fe-guard baseline --widen` |

被拒绝的调用会记进事件流（`tool.rejected`），`npx fe-guard task events` 能看到 AI 当时试了什么。

## 阶段是怎么定出来的

没有「设置阶段」的接口。`task.json` 里只有事件，阶段由事件推导：

```
没有任务             → none
有 task.started      → contract
+ criteria.declared  → plan
+ plan.written       → implement
+ gate.recorded      → verify
+ task.delivered     → deliver
```

一次门禁就通过时，`implement` 会直接跳到 `deliver`，中间不出现「实现完成」这个要模型判断的状态——「实现完了没有」本来就只能由门禁回答。这也是为什么阶段是 5 个而不是更多。

## token 开销大概什么量级

| 项目 | 量级 |
| --- | --- |
| `AGENTS.md` 受管片段（常驻） | 约 530 token，上限 600，`init` 会校验 |
| 单次工具返回 | 200–600 字节 JSON（最长的是门禁，含 blockers）；`ui_lookup` 通常不到 300 字节 |
| `tools/list`（IDE 启动时拉一次） | 约 2.6 KB（7 个工具） |

作为对照：同样流程写成自然语言规则通常要 800–1500 token 常驻，而且不可执行。这里把常驻成本压到 530 token，判断逻辑放进工具。

## 开关

```json
{
  "workflow": {
    "enabled": true,
    "gate": { "mode": "full", "testCommand": "node --test", "testTimeoutMs": 120000 },
    "stages": { "contract": "enforce", "plan": "enforce", "verify": "enforce" }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `workflow.enabled` | `false` 时只保留 `task_gate`，退回纯检查模式，流程工具明确拒绝 |
| `workflow.gate.mode` | 门禁范围：`full` / `diff-only` / `staged` |
| `workflow.gate.testCommand` | 挂 testFile 条件的测试命令（默认 `node --test`，可改 `npx vitest run` 等）。人类配置，模型只给文件路径 |
| `workflow.gate.testTimeoutMs` | 单个条件测试的超时（默认 120000ms） |
| `workflow.stages.contract` | `enforce` 时条件只能在合同阶段写；`warn` 允许后补；`off` 不限 |
| `workflow.stages.plan` | `enforce` 时没有计划不能跑门禁 |
| `workflow.stages.verify` | `enforce` 时失败的门禁不能覆盖验收条件；`warn` 允许覆盖，但交付会标 `degraded` |

`implement` / `deliver` 没有独立开关：它们完全由事件推导，不是一个可以被放宽的判定点。

## hooks 示例

`init` 会生成 `.trae/hooks.example.json` 和 `.cursor/hooks.example.json`，内容是「工具调用后跑 `check --diff-only --profile fast`」「会话结束时跑 `check --staged --profile fast`」。它们**不会自动生效**，需要你把命令搬到 IDE 的 hooks 设置里，事件名以你所用版本为准。

两家 IDE 都没有 git pre-commit 事件，提交前拦截仍然走 Husky + `fe-guard check --staged --profile fast`。
