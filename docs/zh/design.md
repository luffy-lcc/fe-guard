# 设计取舍与架构

[← 返回 README](../../README.zh-CN.md) · [English](../design.md)

## 它解决什么问题

规范写在文档里，只能靠人记；一开全量 lint，几百条历史问题让团队直接把检查关掉；只提示不阻断，等于没有。

fe-guard 的想法很朴素：

1. **不重造检查器**。ESLint、tsc、架构边界工具已经足够好，fe-guard 只负责编排和统一输出格式。
2. **历史欠债冻结，不要求一次还清**。存量违规写进 baseline，检查立刻变绿，团队从「要不要开检查」变成「怎么不再变差」。
3. **新增违规必须阻断**。用退出码而不是口头约定，本地钩子和任何流水线都能直接用。
4. **只允许变好**。修掉一条欠债，baseline 自动收紧，不允许悄悄回退。

它不追求「规范即一切」，只做一件事：让「不准更差」这件事自动执行。

## 设计取舍备忘

- **零运行时依赖**：唯一的外部依赖是被检查的工具本身。工具坏了，fe-guard 给出明确提示而不是抛栈。
- **一个配置关全局**：`enabled`、单项 `enabled`、`level`、`autoTighten`、`workflow.enabled` 都是普通字段，不需要理解内部机制也能操作。
- **流程做成工具，不做提示词**：模型“自觉遵守”不可验证；把阶段、条件达成、门禁结果都落成事件，判定写在代码里，才能被测试和审计。
- **事件而不是状态**：`task.json` 只追加事件，当前阶段由 `reduce()` 推导。没有“设置阶段”的入口，就没有“把阶段标成通过”的攻击面。
- **两套生成物同源**：AGENTS.md、Trae 规则、Cursor 规则、命令、hooks 全部从 `src/ide/source.js` 渲染，改一处不会漂移。
- **不做提前抽象**：没有插件接口、没有事件总线、没有任务队列。七个 runner 各写各的，重复的是十几行参数拼装，换来的是打开文件就能看懂。
- **新增检查默认不改变旧仓库**：旧配置里没有新检查段，升级后视为关闭。要用就显式加进配置，避免「升个版本突然全红」。
- **数值走独立的棘轮轨道**：`metrics` 记的是「允许的最大值」，不是条数。两条轨道共用「只紧不松」的语义，但分开存储。
- **大 diff 不进 baseline**：它是「这次的事件」，入账等于永久关掉闸门。`diff-size` 被显式列为 baseline 豁免项。
- **组件清单不常驻上下文**：清单落盘，AI 用 `ui_lookup` 按需查。常驻 token 换偶尔才用的信息不划算，而且清单会随项目增长、更新即过期。
- **失败也要留下证据**：即使检查失败，报告、baseline 收紧和门禁证据也照常产出，便于复盘。

## 目录结构

```
fe-guard/
├── bin/
│   ├── fe-guard.js              入口（解析参数、分发命令）
│   └── fe-guard-mcp.js          MCP server 入口（IDE 挂载它）
├── src/
│   ├── cli.js                   命令行与帮助
│   ├── config.js                配置读取、默认值、开关判定、workflow 归一化、七项检查默认值
│   ├── profiles.js              内置档位 fast / full
│   ├── not-executed.js          “检查未执行”违规类型（不可入账）
│   ├── check-core.js            检查内核：CLI 与 MCP 门禁共用；条数/数值两条轨道分流
│   ├── baseline.js              棘轮核心：条数与数值的对比、收紧、磁盘格式（纯函数，有单测）
│   ├── workspace.js             monorepo 识别、按 package 规划、配置与 bin 解析
│   ├── timing.js                检查项与 package 的分段耗时
│   ├── feedback.js              误报记录：追加、读取、汇总
│   ├── metrics.js               腐化指标计算：行数、函数长度、any 计数、token n-gram 重复率
│   ├── inventory.js             组件提取与清单：解析 props/emits、重建清单、重复实现判定
│   ├── git.js                   变更文件收集
│   ├── report.js                报告生成与终端输出（默认只逐条展示新增）
│   ├── commands/                init / check / baseline / feedback / doctor / task
│   ├── workflow/                state.js（事件流/阶段推导）/ tools.js（7 个 MCP 工具）/ tests.js（条件测试）
│   ├── mcp/server.js            极简 MCP stdio server（零依赖，换行分隔 JSON-RPC）
│   ├── ide/                     source.js（产物唯一事实源）/ tokens.js / artifacts.js
│   └── runners/                 index.js + eslint / typescript / boundaries / deps / ui / metrics / diff-size
├── test/                        单测 + v5/v6/v6.1/v6.2 端到端
├── examples/sample-app/         带存量违规的样例工程（真实三件套）
├── examples/husky-pre-commit    提交前钩子示例（fast 档）
├── verify.sh                    v1 一键真实验证（检查 + 棘轮）
├── verify-v2.mjs                v2 一键真实验证（MCP 协议 + 反例 + 生成物）
├── verify-v3.mjs                v3 一键真实验证（四项新检查的正反例 + 增量接入 + 单项关闭）
└── verify-v4.mjs                v4 一键真实验证（monorepo / vue-tsc / 首次视图 / baseline / 误报）
```

停两个月再回来，只需要看四个地方：`src/baseline.js`（棘轮语义）、`src/workflow/state.js`（阶段怎么推导）、`src/workflow/tools.js`（哪些操作会被拒）、`src/runners/*`（工具适配）。每个文件都控制在 500 行内（自检同款约束）。

## 验证体系

```bash
npm test               # 单测 + v5/v6/v6.1/v6.2 端到端
npm run verify:local   # 本地一键：npm test + v1/v2/v3/v4 全部验证 + self-check
npm run verify         # v1：临时目录复制样例工程，跑完整场景并断言退出码
npm run verify:v2      # v2：真实 MCP 协议跑完整会话 + 反例 + 生成物
npm run verify:v3      # v3：四项新检查的正反例 + 增量接入 + 单项关闭
npm run verify:v4      # v4：monorepo 按包执行 + 植入 .vue 类型错误 + 首次视图 + 误报闭环
npm run self-check     # 用 fe-guard 的 fast 档检查自己
```

所有验证脚本**不 mock**：真实 spawn ESLint / tsc / dependency-cruiser / MCP 子进程，在临时 git 仓库里真实建文件、装依赖、跑命令、断言退出码。当前实测：v1 37 项、v2 92 项、v3 83 项、v4 54 项全部通过；`npm test` 89 项通过（含 v6.1 的 17 项、v6.2 的 5 项）。

任何一个环节不符合预期，脚本会打印期望值、实际值和完整输出，并以退出码 1 结束。贡献指南见 [CONTRIBUTING](../../CONTRIBUTING.md)。
