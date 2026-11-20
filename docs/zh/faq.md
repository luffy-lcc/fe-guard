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
`npx fe-guard task` 看阻塞项，按 blockers 修完再让 AI 调一次 `task_gate`；`npx fe-guard task events` 能看到完整的时间线。

**想临时跳过流程做一次紧急修改**
把 `fe-guard.config.json` 里 `workflow.enabled` 设为 `false`（只剩门禁），或者自己跑 `npx fe-guard check`。不要改 baseline 来“制造通过”。

**任务状态文件要不要提交**
`.fe-guard/` 是本地工作状态（含报告、组件清单和当前任务），建议加进 `.gitignore`；`fe-guard.baseline.json` 要提交。
