# 常见问题与排错

[← 返回 README](../../README.zh-CN.md) · [English](../faq.md)

**`fe-guard: 未找到 fe-guard.config.json`**
先在项目根目录运行 `npx fe-guard init`，或用 `--root` / `--config` 指定正确的路径。

**`运行 eslint 失败：找不到可执行文件：eslint`**
目标项目没装 ESLint。`npm i -D eslint`，或把 `checks.eslint.enabled` 设为 `false`。tsc、dependency-cruiser 同理。

**`eslint 输出不是合法 JSON`**
`checks.eslint.args` 必须包含 `--format json`（默认配置已包含）。如果你覆盖了 `args`，记得保留它。

**`git diff 执行失败` / baseline 分支不存在**
`--diff-only` 需要是 git 仓库。若 `diff.base` 配成了 `origin/main`，先 `git fetch origin main`。只想看当前未提交改动就用默认的 `HEAD`。

**检查通过了，但 baseline 被改了**
这是自动收紧：你修掉了存量违规，`check` 把允许条数调低了。属于预期行为，建议把 baseline 的改动一起提交。如果运行环境只读，设置 `"baseline": { "autoTighten": false }`。

**我想接受一批新欠债**
`npx fe-guard baseline --widen`，它会逐条列出将要放宽的 `(文件, 规则)`。不要日常使用。

**升级了 ESLint / TS 版本，突然报了一批新规则违规**
先用 `--widen` 记录下来（说明原因），再单独排期清理；或者把对应规则先降级为 `warn`。

**大仓库上 `--diff-only` 也不快**
ESLint 会只跑变更文件，但 tsc 和 dependency-cruiser 仍需要全量分析（否则类型与依赖图不完整），fe-guard 只是在结果上按变更文件过滤。

**报告里的 `line` 为什么是 null**
dependency-cruiser 的 JSON 不提供行号，只有「谁依赖了谁」。ESLint 和 tsc 的违规都有行号。

**Trae / Cursor 的 MCP 面板里看不到 fe-guard**
先确认项目根有对应客户端的配置——`.trae/mcp.json`（Trae）、`.cursor/mcp.json`（Cursor）、`.mcp.json`（Claude Code）、`.vscode/mcp.json`（VS Code，`servers` 下）或 `.gemini/settings.json`（Gemini CLI）——并且里面有 `fe-guard` 条目；然后重载项目。手动验证 server 能否启动：`node ./node_modules/fe-guard/bin/fe-guard-mcp.js`（它会等 stdin 输入，Ctrl+C 退出），或 `npx fe-guard mcp`。排查时加环境变量 `FE_GUARD_DEBUG=1`，错误会打到 stderr。

**MCP 配置加载正常，但面板红错、0 个工具**
日志里只有「config loaded / server added」却没有连接记录，多半是进程根本没起来：macOS GUI 应用不加载 shell 的 PATH，node 装在 nvm / fnm 下时 `command: "node"` 会 ENOENT。把 `mcp.json` 的 `command` 与 `args` 全改成绝对路径（node 可执行文件 + 脚本 + `--root`），不依赖 PATH 与 cwd。nvm 路径带版本号，切换 node 版本后要同步改。

**AI 一直说「先调用 task_start」**
这是预期的：没有任务时流程不会允许它写计划或跑门禁。直接把需求讲清楚即可，它应该自己调用 `task_start`。

**任务卡在 verify**
`npx fe-guard task` 看阻塞项，按 blockers 修完再让 AI 调一次 `task_gate`；`npx fe-guard task events` 能看到完整的时间线。阻塞项可能是未确认的 `assumption` 条件（需人工 `task confirm`）、缺失的手工证据，或失败门禁后还没写复盘（`task_lesson`）。

**为什么条件要 `type` 和 `source`？**
只有一段文字时，任务很容易「看起来做完了」却漏掉整类条件，也回答不了「这条从哪来」。`type` 逼着检查交互 / 数据 / 埋点 / 兼容 / 性能类条件；`source: assumption: ...` 标记推断项，交付前必须由人确认。

**confirm / defer 为什么只能 CLI？**
它们是人的决定：确认推断项、接受上线待办，都会改变「做完」的定义。做成 MCP 工具等于让模型自己批准。CLI 强制 `--note` / `--reason` 与 `--yes`，并在任务事件流里留下可审计记录。

**preflight 命令写什么？失败怎么办？**
写「不满足就不能相信后续验证」的前置条件，例如 `npm run check:env` 检查本地接口、生成类型或必需环境变量。失败时 `task_start` 不创建任务，`task_gate` 报「本次检查未执行」（不产证据、条件不被覆盖）。fe-guard 不会替你启动 dev server 或登录。

**失败门禁后为什么不能交付？怎么关闭？**
`workflow.distill` 默认 `enforce`：最近一次失败门禁之后必须写 `task_lesson`（结论 + 证据 + scope）。改成 `warn` 可交付但标记 `degraded`，改成 `off` 则关闭要求。不要为了过门禁编一条假复盘。

**task stats 的数据从哪来？**
它重放当前 `.fe-guard/task.json` 与 `.fe-guard/tasks/*.json` 归档里的事件流。只读、不写任何文件；损坏的归档会跳过并计数，删除归档后不再计入。

**想临时跳过流程做一次紧急修改**
把 `fe-guard.config.json` 里 `workflow.enabled` 设为 `false`（只剩门禁），或者自己跑 `npx fe-guard check`。不要改 baseline 来“制造通过”。

**任务状态文件要不要提交**
`.fe-guard/` 是本地工作状态（含报告、组件清单和当前任务），建议加进 `.gitignore`；`fe-guard.baseline.json` 要提交。
