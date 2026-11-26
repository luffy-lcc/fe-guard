# 从「不更坏」开始：fe-guard 的前端质量门禁与 AI 工作流

> 用 baseline 棘轮冻结历史欠债，把 AI 的「已完成」变成可核对的门禁证据。

## 前端仓库是怎么慢慢变坏的

大多数前端仓库不是被一次大重构拖垮的，而是被一连串看起来「还好」的提交磨坏的。

一次需求里多写了一个下拉框，和已有组件只差两个 props；为了赶进度引入第二套日期库；一个页面从 300 行长到 800 行；`any` 从 3 个变成 30 个。单独看每个 diff，都能通过评审——它确实解决了眼前的问题。三个月后，重复组件、两套时间处理、没人敢动的巨石文件一起出现，团队才开始讨论「要不要治理」。

传统做法是全量 lint：第一次打开就是几百上千条，评审说「先关掉，等有空再清」。检查从此不再是门禁，只是一份没人看的报告。AI 加入后，生成速度更快，这个问题只会更早出现——写得越快，越需要一条自动守住下限的路径。

## fe-guard 的答案：先冻结存量，再只拦新增

fe-guard 不假设项目能一次还清历史欠债。它把质量拆成两层：检查层负责「有没有变坏」，工作流层负责「有没有做完」。

检查层的第一条规则是 baseline 棘轮：

- 第一次接入跑一次 `baseline`，把现有违规记进账本；
- 之后每次 `check` 只拦「超出账本」的新增；
- 修掉旧问题，账本自动收紧；要放宽必须显式 `--widen` 并留下审计；
- monorepo 可以按 package 各记一本账，A 包还债不会误收紧 B 包。

这和「全量必须干净」的思路相反：**它承认历史，但不允许历史继续变多。** 项目不一定因为一次治理突然变好，但可以因为每次提交都没有变坏而慢慢变好。

## 不是又一个 lint 包装器

fe-guard 不重新实现 ESLint，也不要求团队换工具。它做的是编排和归一化：把不同工具的输出变成同一种违规结构，再叠加三件工具本身不提供的能力：

- **存量棘轮**：只拦新增，历史可审计；
- **统一执行**：monorepo 按包、Vue 自动 `vue-tsc`、子目录根、fast / full 两档；
- **报告出口**：JSON / SARIF / 单文件 HTML，接 CI 与代码扫描。

## 七项检查：把确定性的问题交给工具

fe-guard 编排项目自己的 ESLint、TypeScript、dependency-cruiser，并内置四项轻量检查：

| 检查 | 拦什么 |
| --- | --- |
| ESLint / TypeScript / 架构边界 | 语法、类型、循环依赖与跨层引用 |
| 依赖守卫 | 未登记的新依赖、幽灵包、同类能力用了两个库 |
| 组件清单 | 同名组件、props 高度重合的重复实现 |
| 腐化指标 | 文件行数、长函数、显式 `any`、跨文件重复块 |
| 大 diff | 一次改太多文件/行，要求拆 PR |

baseline 记两本账：`(文件, 规则) -> 允许条数` 和 `(文件, 指标) -> 允许最大值`。只紧不松，`firstSeen` / `widenLog` 可审计。monorepo 还可以按 package 各记一本账，A 包还债不会误收紧 B 包。

## 把「做完了」拆成证据：工作流层

检查层回答「有没有变坏」，工作流层回答「到底做完了没有」。fe-guard 通过 MCP 把流程做成工具：

**合同 → 验收条件 → 计划 → 实现 → 门禁 → 交付**

模型不能自己把阶段标成通过，也没有「我完成了」这个工具。每个动作都写入事件流，阶段由事件推导：

- **验收条件**必须写 `type`（UI / 交互 / 数据 / 埋点 / 兼容 / 性能）和 `source`（需求、设计稿、代码或 `assumption`）；
- 能写成测试的挂 `testFile`，门禁真跑测试；手工/视觉验证必须挂 `evidenceFile`，记录 `bytes` 与 `sha256`；
- 推断项要人执行 `task confirm`；明确放弃的条件要人执行 `task defer`，交付会标 `degraded`，并列出待办；
- 每次门禁写快照 `.fe-guard/evidence/...`，报告本轮修好几条、又引入几条；
- 失败过的门禁，交付前要写 `task_lesson`；`workflow.distill` 默认 `enforce`；
- `task stats` 只读聚合交付率、门禁失败率、top blocker、复盘与待办。

这些不是提示词建议，而是代码里的判定。模型可以说「我完成了」，但只有门禁证据能让任务进入交付态。

## 一次真实的任务长什么样

你说：「给项目加一个 formatDuration，1 秒显示 1s。」

AI 会：

1. `task_start` 写清目标和不做什么；
2. `task_criteria` 写条件，例如「1000ms 返回 1s」（data，需求#时长，`testFile`）；
3. `task_plan` 写实现步骤；
4. 改代码、写测试；
5. `task_gate` 跑真实检查。

如果门禁失败，它拿到的是 blockers：新增了哪条违规、哪条条件没有证据、哪个推断项还没确认。它按 blockers 修，再跑一次。只有证据齐全，任务才进入 `deliver`。

你不需要逐个点开页面；你只需要看它交上来的「完成 N 条 / 待办 M 条」和证据路径。

## 诚实工程：不假绿灯

fe-guard 最看重的不是功能数量，而是**不产生假结果**：

- 缺工具、超时、子进程崩溃 → `<check>/not-executed`，永远不能进 baseline；
- 没有 ESLint 配置的 package → 记录为 `skipped`，不是通过；
- Vue 项目里 depcruise 只解析了部分 `.vue` → 报「依赖图不完整」，不给假 0；
- 环境预检失败 → 本次检查未执行，不覆盖条件；
- 删掉 package 账本 → `baseline --verify` 判失败，而不是静默解冻欠债。

跳过不等于通过，没执行不等于没问题。这是它和「跑个 lint 就算质量门禁」最大的区别。

## 真实仓库里的数字

在 3 个真实 Vue 仓库副本上实测：

- 10.9 万行单仓库：`--profile fast` **2.0s**，全档 **2.5s**，钩子 3 秒目标成立；
- 存量一次入账 956 / 11424 条，随后 `check` 退出码 0，默认只逐条展示新增；
- error 级误报 **0 / 1092**；
- boundaries（depcruise 18.8.0）抓到 **19 条真实循环依赖**，抽样 3 条人工追链，**0 误报**，耗时 <1s。

React / TSX 也在两个开源仓库上跑过，并修掉了真实问题：Storybook stories 被当成组件、子目录项目比对错 `package.json`、整包被 ESLint 忽略导致门禁中断、`pnpm-workspace.yaml` 的 `"."` 让根包跑两遍。

这些数字不代表 fe-guard 能替你做架构评审；它只说明：**确定性的问题，可以交给确定性的工具。**

## monorepo、Vue 与 React

- **monorepo**：识别 `package.json` workspaces、`pnpm-workspace.yaml`、`lerna.json`；ESLint / TypeScript 按 package 各用自己的配置并行执行；0.5 起 baseline 也可以按 package 记账；
- **Vue**：检测到 `.vue` 自动切 `vue-tsc`；有 `.vue` 但 vue-tsc 不可用时明确失败，不会静默跳过；
- **React / TSX**：已在真实开源仓库验证；stories 与测试文件不再被当成组件；
- **子目录项目**：前后端同仓时，用 `--root frontend` 挂载，git 相关路径语义正确。

零运行时依赖，Node 18+，安装体积就是几份源码。

## 适合谁，不适合谁

**适合**：

- 有历史欠债、又不想因为一次全量 lint 把检查关掉的前端仓库；
- 多人 / 多包 / AI 参与开发，靠人审已经拦不住重复组件、依赖膨胀和文件腐化；
- 想让 AI 的「已完成」有证据，而不是靠人一个个点页面。

**不适合**：

- 只改一行文案、不需要任何流程的小改动；
- 希望工具替你做语义级架构判断、自动重构、自动修所有问题；
- 不愿意把 baseline 变更纳入评审的团队——账本需要人负责。

## 五分钟接入

```bash
npm i -D github:luffy-lcc/fe-guard#v0.6.0   # 或使用 Release 里的 tgz
npx fe-guard init      # 探测项目，生成配置、账本、AGENTS.md 与 MCP 配置
npx fe-guard baseline  # 把现有存量记入账本
npx fe-guard check     # 只拦新增
```

钩子：

```bash
npx fe-guard check --staged --profile fast
```

合并前：

```bash
npx fe-guard check --full
```

报告可以直接输出 JSON、SARIF 或单文件 HTML：

```bash
npx fe-guard check --full --format sarif > fe-guard.sarif
npx fe-guard check --full --format html
```

## 最后

AI 写代码的速度已经不是瓶颈，瓶颈是「写完之后谁来验收」。fe-guard 的答案很朴素：

> 不信它说的，只信它拿出来的证据；不让项目因为一次「已完成」变得更坏。

如果这个思路对你有用，可以从一个仓库、一个 `baseline`、一条 pre-commit 开始。它不会让项目一夜之间变干净，但会让下一次提交没有变得更糟。
