# fe-guard

> 把前端规范变成一条「能过 / 不能过」的命令，把 AI 写代码导致的仓库腐化变成可拦截的门禁。

[![CI](https://github.com/luffy-lcc/fe-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/luffy-lcc/fe-guard/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/luffy-lcc/fe-guard?sort=semver)](https://github.com/luffy-lcc/fe-guard/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

[English](./README.md) · **简体中文**

fe-guard 编排已有的 ESLint、tsc、dependency-cruiser，把输出归一化成同一种违规结构，用 **baseline 棘轮**把历史欠债冻结住——**只允许新增违规把门拦下来**。在此之上，它把 AI 开发流程做成 **MCP 工具**：Trae / Cursor 里的 AI 必须调用工具才能推进「需求合同 → 验收条件 → 计划 → 实现 → 验证 → 交付」，阶段判定在代码里，不靠模型自觉。

## 为什么需要它

- **AI 产出速度远快于人阅读**：重造组件、引入第二套同类库、文件膨胀、`any` 泛滥、复制粘贴——靠人审拦不住。
- **规范写在文档里只能靠人记**：一开全量 lint，几百条历史问题让团队直接把检查关掉。
- **「做完了」无法验证**：AI 口头声称完成，没有可审计的证据。

fe-guard 只做一件事：让「**不准更差**」自动执行。存量欠债冻结、不要求一次还清；新增违规必失败；修掉旧违规后 baseline 自动收紧，不会变松。

## 特性

- **零运行时依赖**，Node 18+，ESM，安装体积就是几份源码。
- **七项检查**：ESLint / TypeScript / 架构边界（编排外部工具）+ 依赖守卫 / 组件清单 / 腐化指标 / 大 diff（自带轻量实现）。
- **baseline 双轨棘轮**：条数 + 指标最大值，只紧不松，`firstSeen` / `widenLog` 可审计。
- **monorepo 可按 package 记账**：可选 `baseline.strategy: "package"` 让每个 workspace package 各有一本账（老仓库用 `--migrate-packages` 拆分），root 模式仍是默认。
- **MCP 流程层**：事件溯源，阶段由事件推导，AI 无法自报「通过」；验收条件可挂测试，门禁真跑。
- **结构化合同 + 人工决策**：每条条件必须有 `type`（ui / interaction / data / tracking / compat / performance）与 `source`；`assumption` 推断项必须由人 `task confirm`，人也可以 `task defer` 把条件转成上线待办——此时交付标 `degraded`，只报「N 完成 / M 待办」，不说「全部完成」。
- **证据而不是口头声称**：每次门禁写快照到 `.fe-guard/evidence/<taskId>/<evidenceId>.json`；`verify: manual` 证据记录路径、字节数与 sha256；`completion` 给出 `achieved / total / remaining / deferred`。
- **环境预检、返工对比与复盘**：`workflow.preflight` 支持单命令或多步检查，环境不对就不开始，门禁也不会在未执行时假通过；门禁指纹返回 `fixed` / `introduced`；`task_lesson` + `workflow.distill` 要求失败门禁后必须复盘。
- **视觉证据不绑定内置浏览器**：验收条件可声明 `evidenceKind`（`screenshot` / `diff` / `log`）；`workflow.visualDiff.command` 执行项目自己的视觉对比命令，记录输出、退出码与哈希。命令缺失或失败都不会覆盖条件。
- **效果统计**：只读 `fe-guard task stats [--json]` 聚合交付/降级、门禁失败率、平均门禁次数、top blocker、复盘与待办数量。
- **fast / full 两档**：钩子 3 秒内，合并前手动全档。
- **诚实工程**：检查没真正执行就报 `not-executed`（不可入账），跳过 ≠ 通过，绝不假绿灯。
- **可分享的输出**：`check --format sarif` 直接接 GitHub Code Scanning（只含新增违规与 `not-executed`，存量不会淹没告警页）；`check --format html` 生成单文件报告，零外部资源。
- **一个配置关全局**：关掉或降级都只改配置；流程层一行 `workflow.enabled: false` 退回纯检查。

## 快速上手

```bash
npm i -D fe-guard          # npm 未发布时：npm i -D github:luffy-lcc/fe-guard
npx fe-guard init          # 先探测项目，再生成配置 / 空账本 / AGENTS.md 片段 / IDE 接入产物
npx fe-guard baseline      # 把现有违规一次入账（检查立刻变绿）
npx fe-guard check         # 只拦新增；修掉旧违规自动收紧
npx fe-guard task stats    # AI 跑过任务后：只读查看交付 / 门禁 / 复盘统计
# .husky/pre-commit:
npx fe-guard check --staged --profile fast
```

闭环验证：加一行 `const unused = 1` → `check` 失败 → 删掉 → 通过。

老项目接入？`npx fe-guard init --preset legacy --dry-run` 会先预览一份更宽松的起始配置（阈值与将要写入的文件），不落盘；去掉 `--dry-run` 才会真正写入。预设：`js`、`vue`、`legacy`、`monorepo`，详见[快速上手 → 预设与 --dry-run](docs/zh/getting-started.md#预设与---dry-run)。

## 在 AI IDE 里使用（MCP）

`npx fe-guard init` 会把流程层挂进五个项目级 MCP 配置：Trae（`.trae/mcp.json`）、Cursor（`.cursor/mcp.json`）、Claude Code（`.mcp.json`）、VS Code（`.vscode/mcp.json`，使用 `servers` + `"type": "stdio"`）与 Gemini CLI（`.gemini/settings.json`）。每个文件里只接管自己的 `fe-guard` 条目：其它 server、其它设置键原样保留，且不会碰用户 home。其它 MCP 客户端可以手动挂载这个 stdio server：

```json
{ "mcpServers": { "fe-guard": { "command": "node", "args": ["./node_modules/fe-guard/bin/fe-guard-mcp.js"] } } }
```

AI 获得 7 个 `task_*` 工具 + `ui_lookup`，必须调用工具推进「合同 → 验收条件 → 计划 → 实现 → 验证 → 交付」。阶段判定在代码里，无法自报「通过」。macOS GUI 应用不加载 shell PATH——nvm/fnm 下请把 `command`/`args` 改成绝对路径（[常见问题](docs/zh/faq.md)）。

完整流程：[workflow](docs/zh/workflow.md)。

## 文档

| 主题 | 链接 |
| --- | --- |
| 快速上手 / 常用命令 / doctor / 内网分发 | [getting-started](docs/zh/getting-started.md) |
| 七项检查与检测原理 | [checks](docs/zh/checks.md) |
| baseline 棘轮 / 档位 / 退出码 | [baseline](docs/zh/baseline.md) |
| AI IDE / MCP 流程层 | [workflow](docs/zh/workflow.md) |
| 配置参考 / monorepo / Vue | [configuration](docs/zh/configuration.md) |
| 渐进式落地与常见担忧 | [adoption](docs/zh/adoption.md) |
| 常见问题与排错 | [faq](docs/zh/faq.md) |
| 已知限制与明确没做 | [limitations](docs/zh/limitations.md) |
| 设计取舍与架构 | [design](docs/zh/design.md) |
| 路线图 | [roadmap](docs/zh/roadmap.md) |
| 真实仓库实测报告 | [real-world](docs/zh/real-world.md) |

英文文档：[README.md](./README.md) · [docs/](docs/)。

## 真实证据

在 3 个真实 Vue 仓库（10 万–18 万行）副本上实测：

- 10 万行级单仓库：fast 档 **2.0s**、全档 **2.5s**，钩子 3 秒目标成立。
- 存量一次入账（956 / 11424 条），随后 `check` 退出码 0；**error 级误报 0 / 1092**。
- boundaries（depcruise 18.8.0）：19 条真实循环依赖，抽样 **0 误报**，check < 1s。
- 抓出真实的共享组件重造、近乎相同的重复模块、`.vue` 类型错误。

完整数字与逐条判定见[实测报告](docs/zh/real-world.md)。

## 要求

- Node 18+，项目是 git 仓库。
- 被编排的工具（ESLint / TypeScript / dependency-cruiser）由项目自己安装；fe-guard 零运行时依赖。缺工具时对应检查明确报「未执行」或可关闭。

## 贡献与许可证

欢迎贡献——请先读 [CONTRIBUTING](./CONTRIBUTING.zh-CN.md)（零依赖、不做提前抽象、必须真实验证）。行为准则见 [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.zh-CN.md)。

[MIT](./LICENSE) © fe-guard contributors
