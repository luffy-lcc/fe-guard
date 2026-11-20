# 真实仓库实测报告

[← 返回 README](../../README.zh-CN.md) · [English](../real-world.md)

> 样本均为真实前端仓库，已匿名化为 Repo A / Repo B / Repo C。全部在副本上执行，原仓库未修改、未 commit、未生成任何文件。所有数字为真实实测结果。
>
> 文中 v3–v6.2 为开源前的内部迭代标记；首个公开版本 0.1.0 包含全部迭代成果。

## 样本与执行方式

| 样本 | 类型 | 规模（src） | 技术栈 | 选它的理由 |
| --- | --- | --- | --- | --- |
| **Repo A** | 较老 / 较杂 | 402 个源文件，约 10.9 万行 | Vue 3.2、axios 0.27、dayjs + moment-mini、npm、`.eslintrc.cjs` | 典型的“跑了几年、多人接手”的后台，JS/Vue 混写，依赖新旧并存 |
| **Repo B** | 较新 / 较规范 | 480 个源文件，约 18 万行 | Vue 3.4、pnpm workspace、TS、每 app 独立 eslint、vitest | 新一些的 monorepo，用来看工具在“更规范但更复杂”的仓库上的表现 |
| **Repo C** | 前后端同仓 | frontend 子目录 | Vue 3.5 + TS 5.9 + vue-tsc 3.3 + ESLint 10 + pnpm | git 根在仓库顶层（含 backend / frontend），fe-guard 根 = frontend，验证子目录根支持 |

执行方式：

- 用 `rsync -a` 把整个仓库（含 `node_modules`、`.git`）复制到本机临时副本，所有 `init` / `baseline` / `check` 只在副本里跑。
- 原仓库仅进行只读检查（读 `package.json`、`git log`），没有写入、没有切换分支、没有 commit。
- Repo A / B 都没有安装 dependency-cruiser，`boundaries` 检查被关闭（boundaries 的实测见后文 v6.1 节）。
- Repo A 用默认 ESLint；Repo B 是 monorepo，根 ESLint 配置和子 app 配置冲突，早期实测时关闭了 `eslint`，`tsc` 指定某个 app 的 `tsconfig.json`。

## 首次告警量（按检查类型）

### 修复前（v3 初始默认值）

| 检查 | Repo A | Repo B |
| --- | ---: | ---: |
| eslint | 4351 | 431（全部是 monorepo 配置导致的 parse-error） |
| typescript | 0 | 0 |
| boundaries | 未安装 | 未安装 |
| deps | 21 | 548 |
| ui | 4454 | 18 |
| metrics | 495 | 118 |
| diff-size | 0 | 0 |
| **合计** | **9321** | **1115** |

这份数据直接暴露了三类问题：ESLint 扫到了构建产物、组件名把 66 个 `index.vue` 全叫 `Index`、monorepo 把子包依赖全判成幽灵依赖。

### 修复与调参后（当前默认值）

| 检查 | Repo A | Repo B | 说明 |
| --- | ---: | ---: | --- |
| eslint | 607 | 关闭 | 607 条都是真实 lint 问题；关闭前 431 条是配置不匹配，不是代码问题 |
| typescript | 0 | 0 | 两个仓库 tsc 都是干净的；Repo B 需用 `vue-tsc` 才能覆盖 `.vue` |
| deps | 0 | 0 | 修复后无误报 |
| ui | 164（12 error / 152 warn） | 18（全部 warn） | 12 条 error 都是“共享图表组件在 views 里被重造” |
| metrics | 185 | 118 | 行数 70 / 重复 70 / 函数长度 42 / any 3（Repo A） |
| diff-size | 0 | 0 | 初始化产生的文件未触发阈值 |
| **合计** | **956** | **136** | 相比修复前下降 89.7% / 87.8% |

存量问题全部通过一次 `fe-guard baseline` 入账；随后 `check` 退出码 0。Repo A 的 baseline 约 1300 行 JSON，已把 `fe-guard.baseline.json` 加入 `diff-size.ignore`，否则它自己会把 diff 撑爆。

## 误报判定

抽样方式：每类检查人工看 3–20 条，样本不足则全看。判定标准是“这条告警指出的问题，在这个仓库的上下文里是否真的需要改”。

| 检查 | 样本 | 判定 | 结论 |
| --- | --- | --- | --- |
| Repo A eslint | 20 / 607 | 20 真问题 | `prefer-const` 361、`no-unused-vars` 139、`ban-types` 66；大多是 `eslint --fix` 可自动修的存量 |
| Repo A deps | 21 / 21（全看） | 0 真问题 | 13 条 axios 是“默认 http 能力”强加的规则，仓库确实直接封装 axios；8 条是虚拟模块（`virtual:` 前缀、图标插件）、生成的 `.d.ts` 里的 `@vue/runtime-core` |
| Repo A ui error | 12 / 12（全看） | 12 真问题 | 共享图表组件、共享空状态组件在多个 views 里被复制；属于真实的共享组件重造 |
| Repo A ui warn | 8 / 152 | 8 可接受 | 不同 feature 目录下的同名空状态 / 图表组件，是业务分区，不该阻断；`warn` 级别合适 |
| Repo A metrics/duplication | 12 / 70 | 12 真重复 | 两个近乎相同的请求模块重复率 85.9%、多个 chart 文件 99%+ 相同 |
| Repo A metrics/file-lines | 10 / 70 | 10 真超长 | 均为 500–1400 行的存量视图/请求文件 |
| Repo A metrics/function-lines | 10 / 42 | 10 真超长 | 最长约 237 行 |
| Repo A metrics/any | 3 / 3（全看） | 3 真 | 显式 `: any` |
| Repo B deps | 548 / 548（全看） | 0 真问题 | pnpm workspace：依赖写在子包或根，工具只读根 package.json，548 条全是幽灵依赖误报（已修） |
| Repo B ui | 10 / 18 | 10 可接受 | 两个 app 之间的 `App.vue` / `DefaultLayout.vue` 等同名文件，`warn` 合适 |
| Repo B metrics | 10 / 118 | 10 真 | 两个 portal 互相复制，文件行数与重复块都真实存在 |

**修复后 error 级误报：0 / 1092（0%）。** warn 级有 170 条属于“真实但可接受”的信号（152 + 18），因此不建议把 ui 默认改成 error 阻断业务分区同名。

## 发现并修复的真实 bug

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 报告路径出现 `../../../private/tmp/...`，ESLint 结果无法按仓库路径过滤 | macOS `/tmp` 是 `/private/tmp` 符号链接，工具返回 realpath | `toRepoPath` 同时对 root 和文件做 realpath，新增单测 |
| 4454 条 `ui/duplicate-name` | 66 个 `index.vue` 全部被命名为 `Index` | `index.*` 用父目录名；入口文件不参与同名判定 |
| deps 把虚拟模块、图标插件、生成 `.d.ts` 当成幽灵依赖 | 虚拟模块/自动生成声明被当成 npm 包 | 跳过 `virtual:`/`~icons`/`#`/`\0`，deps 不扫 `.d.ts` |
| monorepo 548 条幽灵依赖 | 只读根 `package.json` | 递归发现子包 manifest，按“最近 package.json + 祖先 workspace”合并依赖；在 node_modules 里能解析到的传递依赖不算幽灵 |
| 初始化后 `diff-size` 自己失败 | baseline 被当成普通新增文件 | baseline 路径加入 `diff-size.ignore` |
| `**/locales/**` 忽略规则无效 | 忽略匹配不支持前导 `**/` | 补上前导 `**/` 语义并加单测 |
| 组件重复检测把 `views/x/components/` 当成共享组件 | 只看路径里有没有 `components/` | 只有 `src/components/` 或仓库根 `components/` 才算共享，其余降为 warn |

## 性能

在本机（macOS）全量执行，单次 `check`：

| 检查 | Repo A | Repo B |
| --- | ---: | ---: |
| eslint | 1.21s | 未测（monorepo 配置冲突） |
| typescript（tsc） | 1.59s | 0.67s（单 app） |
| deps | 0.05s | 0.10s |
| ui | 0.02s | 0.01s |
| metrics | 1.03s | 0.90s |
| diff-size | 0.03s | 0.03s |
| **整次 check（并行）** | **约 1.9s** | **约 1.2s** |

`vue-tsc` 单 app 约 4.3s，仍是可接受范围。真正贵的是 ESLint/tsc 本身，fe-guard 自己的四项检查合计约 1.1s。

## v6 复测（fast / full 档）

v6 面向“内网、没有 CI、只有本地”，新增 fast / full 档、`doctor`、`baseline --show --by-rule`。

| 指标 | Repo A |
| --- | ---: |
| `check --profile fast` 实际耗时 | **2.0s**（ESLint 2.0s / deps 1.8s / ui 1.7s / metrics 1.7s，并行） |
| `check --full` 实际耗时 | **2.5s**（额外 TypeScript 2.4s、大 diff 53ms） |
| 两档结果 | 退出码 0；存量 956 条，新增 0 条 |

Repo B 的 `baseline --show --by-rule`：11308 条存量分布在 15 条规则上，按可清理条数排序前三为：

| 排名 | 规则 | 条数 | 涉及文件 |
| ---: | --- | ---: | ---: |
| 1 | `eslint/@typescript-eslint/no-unsafe-member-access` | 5231 | 248 |
| 2 | `eslint/@typescript-eslint/no-unsafe-assignment` | 2868 | 238 |
| 3 | `eslint/@typescript-eslint/no-unsafe-return` | 970 | 204 |

结论：在 10 万行级单仓库上，fast 档 2.0s、全档 2.5s，钩子目标（3 秒内）成立；monorepo 的 fast 耗时仍由项目自身 ESLint 配置决定。fast 档不执行 tsc / vue-tsc / boundaries / diff-size，合并前仍需 `check --full`。

### v4 复测（历史记录）

v4 针对本报告暴露的两个窟窿（monorepo parse-error、`.vue` 类型检查为空）做了改动：

| 指标 | v3 | v4 | 说明 |
| --- | ---: | ---: | --- |
| Repo A 总违规 | 956 | 956 | 无变化；eslint 607 / ui 164 / metrics 185 |
| Repo A TypeScript | 0（tsc） | 0（vue-tsc 1.3 + TS 4.8） | 用的是仓库已装版本，查进了 `.vue` |
| Repo A 首次默认视图 | 逐条 956 条 | 1 行摘要 | `--all` 才展开 |
| Repo B 总违规 | 136（ESLint 被关） | 11424 | ESLint 11112 + TypeScript 178 + metrics 116 + ui 18 |
| Repo B ESLint parse-error | 431 | **0** | 5 个 package 各用自己的配置并行 |
| Repo B TypeScript | 0（tsc，未查 `.vue`） | **178**（vue-tsc） | 全是 `.vue` 里的真实类型错误 |
| Repo B 全量耗时 | 约 1.2s（仅单 app tsc） | 约 30s | ESLint 27.4s 来自项目自身的 type-aware 规则；其余四项并行约 5s |

## v6.1：boundaries 真实仓库实测

补上早期留下的最大未知项：`boundaries` 首次在真实仓库上实测。样本为 Repo A（Vue 3.2，402 源文件 / 10.9 万行），复制到本机临时副本，原仓库只读。dependency-cruiser **18.8.0** 安装在隔离目录（不污染样本依赖），`checks.boundaries.bin` 指向该目录的 depcruise。

规则配置（`.dependency-cruiser.cjs`）：`no-circular` + 两条层级规则（`apis` / `utils` 不得依赖 `views`）；`tsConfig: { fileName: 'tsconfig.json' }` 解析 `@/` 别名，`enhancedResolveOptions.extensions` 含 `.vue`。

| 指标 | 结果 |
| --- | ---: |
| 依赖图模块数 | 447（含 node_modules 入口） |
| no-circular 违规 | 19 条，涉及 16 个文件 |
| 层级规则违规 | 0 |
| fe-guard check 耗时 | 约 0.6–0.7s |
| baseline 入账后 check | 退出码 0 |

误报抽样（3 条循环，人工追 import 链）：

1. 一个三模块循环（api 层 → 工具层 → store 模块 → api 层）：真实三元环。
2. 一个经过应用入口的大循环（router guards → store → api → 工具 → 入口 → router guards）：真实大环。
3. 一个真实的组件循环（三个 `.vue` 组件互相 import）：真实组件环。

**3/3 真问题，0 误报。** 适配器归一化正确：`boundaries/no-circular`、相对 posix 路径、`line: null`、severity 透传。

### 实测发现的两个坑（都已处理）

1. **depcruise 18 的 schema 变更**：旧文档里的 `options.tsConfigFile` 已改为 `options.tsConfig: { fileName }`。配置非法时 depcruise 退出码 1 且 stdout 不是 JSON，fe-guard 正确报“输出不是合法 JSON”并附 stderr——不会假通过，但接入者需要知道新写法。
2. **Vue 解析的静默假通过（适配器已修）**：depcruise 需要能从**它自己的安装位置** import 到 `@vue/compiler-sfc`（Vue 2 用 `vue-template-compiler`）才解析 `.vue`。缺失时它不报错，只是把 225 个 `.vue` 里的 224 个排除在依赖图外（只剩 61 个模块），违规恒 0。常规接入（项目内 `npm i -D dependency-cruiser`）时 Vue 项目自带 compiler-sfc，不受影响；但隔离安装/依赖裁剪场景会踩中。**v6.1 起适配器对比「磁盘 .vue 数 vs 进入依赖图的 .vue 数」，不完整即产出不可入账的 `boundaries/not-executed`**（实测：移除 compiler-sfc → 报 `只解析了 1/225 个 .vue 文件` 并退出码 1；恢复 → 正常）。回归测试见 `test/v61.test.js`。

结论：`boundaries` 在 10 万行级 Vue 仓库上可用、快（<1s）、抽样无误报；“boundaries 未实测”这一最大未知项关闭。仍未覆盖：React/TSX 仓库、monorepo 多包边界、dependency-cruiser 旧版本（≤16）的 schema 差异。

## v6.2：子目录根复验（Repo C）

样本换成真实的目标接入仓库 Repo C：git 根在仓库顶层（含 backend / frontend），fe-guard 根 = `frontend`（Vue 3.5 + TS 5.9 + vue-tsc 3.3 + ESLint 10 + pnpm）。复制到本机临时副本（排除 node_modules/dist），原仓库只读。配置只开 deps / metrics / diff-size。

v6.2 之前，这种结构有两个已确认的缺陷：`--staged` 影子目录按 git 根布局（影子下是 `frontend/src`），检查扫 `src` 扫空 → 假通过；`diff-size` 统计全仓库改动（含 backend）。v6.2 修复后复验：

| 场景 | 结果 |
| --- | --- |
| baseline 入账 | 13 条指标型存量，check 退出码 0 |
| 暂存 700 行文件、工作区改回干净 | `check --staged` 抓到 `metrics/file-lines`，退出码 1（路径相对 frontend，修复前会扫空假通过） |
| backend 追加 1000 行 | `check --full` 退出码 0，diff-size 不计兄弟目录 |
| frontend 追加 700 行 | `check --full` 触发 `diff-size/lines`，退出码 1 |

配套修复（同属 git 路径语义）：重命名检测与 `changedFiles` 加 `--relative` + 路径限定；`--verify` / 重命名迁移读 HEAD 账本改用 `HEAD:./<path>`（cwd 相对形式）。`test/v62.test.js` 5 项端到端覆盖上述全部场景，v5 的根目录快照回归不变。

结论：前后端同仓结构下，fe-guard 挂 `--root frontend` 全功能可用；钩子可用 `--staged`，diff-size 可启用。接入时钩子放 git 根的 `.git/hooks/pre-commit`，cd 到 frontend 后执行。

## 建议的接入配置

### 仓库规模与阈值

| 规模 | maxFileLines | maxFunctionLines | maxAny | duplication.maxRatio | diff maxFiles / maxLines |
| --- | ---: | ---: | ---: | ---: | --- |
| 新项目 / < 3 万行 | 400 | 80 | 10 | 0.35 | 15 / 400 |
| 中型存量 / 3–10 万行 | 500（默认） | 100（默认） | 20（默认） | 0.5（默认） | 20 / 600（默认） |
| 大型存量 / > 10 万行 | 800 | 150 | 50 | 0.6 | 40 / 1200 |

阈值只影响**新增**问题：存量已经在 baseline 里，调高阈值不会放过新代码，只是减少首次接入的噪声。

### 哪些检查建议先开 warn

- `ui`：如果仓库存在多个 app / 多业务分区，先把 `ui.level` 设为 `warn`，跑一周看告警质量；共享组件目录的重造仍会以 error 的 `severity` 出现在报告里，只是不阻断。
- `metrics`：如果存量文件普遍超过 1000 行，先按上表调高阈值，再把 `metrics.level` 设为 `warn`；等新代码习惯稳定后改回 `error`。
- `deps`：`error` 可以默认开，但 `capabilities` 必须先按仓库真实封装配置；不配置时它只拦幽灵依赖和新增依赖，误报很低。
- `eslint` / `typescript`：保持 `error`；接入前建议先跑一次 `eslint --fix`，Repo A 的 361 条 `prefer-const` 可以直接消掉。

### 接入成本

- 复制/初始化：`npx fe-guard init` + `npx fe-guard baseline`，约 2 分钟。
- 配置调整：默认配置可直接用；monorepo 会自动识别并按 package 执行。
- 改动文件：`fe-guard.config.json`、`fe-guard.baseline.json`、CI/Husky 各一处。
- 首次告警：Repo A 956 条、Repo B 136 条；入账后 `check` 全绿。

## 跨团队推广，最先会卡在哪

1. **monorepo 的 ESLint 调用方式**（最先卡）。早期 `eslint` 适配器只能在一个 cwd 下执行一条命令；Repo B 这种每个 app 有独立配置的仓库，根配置会产出 431 条 parse-error。v4 起已支持按 package 分组并行执行。
2. **Vue SFC 的类型检查**。默认 `tsc` 不检查 `.vue`；v4 起检测到 `.vue` 自动切 `vue-tsc`，未安装时明确失败。
3. **boundaries 的接入成本**。两个样本最初都没装 dependency-cruiser，规则要从零写；这是推广时最容易被跳过的检查。
4. **baseline 的评审**。存量入账是一次性动作，但 baseline 文件会很大（Repo A 约 1300 行），需要约定“baseline 变更必须单独提交、写清原因”。
5. **首次告警的心理冲击**。即使入账后全绿，第一次看到 956 条告警仍会让人想整体关掉；建议先只开 `deps` + `metrics`，再逐步开 `ui`。

### 后续版本已解决的问题

| 当时的卡点 | 现状 |
| --- | --- |
| monorepo 的 ESLint 调用方式 | v4 起自动识别 workspace，ESLint / TypeScript 按 package 各用自己的配置并行执行；Repo B 的 431 条 parse-error 归零 |
| Vue SFC 的类型检查 | v4 起检测到 `.vue` 自动切 `vue-tsc`；未安装时明确报 `typescript/vue-tsc-missing`，不再给假的 0 条 |
| baseline 的评审 | v4 起 `baseline --show` 按文件分组并带首次入账日期；v6 起 `--by-rule` 按可清理条数排序；`--verify` 用 merge-base 拦截未登记的放宽 |
| 首次告警的心理冲击 | v4 起默认只逐条展示新增，存量收敛成一行摘要，`--all` 才展开 |
| 钩子太慢、不敢开全档 | v6 起 `fast` 档只跑 ESLint / deps / ui / metrics（实测 2.0s），全档留给合并前手动执行；`doctor` 先看覆盖与耗时 |

仍然成立的是：没有 CI 时只有本地默认路径，`--no-verify` 仍可绕过。

## React / TSX 实机验证（0.4.x）

克隆两个开源 React 仓库，用真实工具链完整跑过（不 mock）：

| 仓库 | 形态 | 实际运行的检查 | 结果 |
| --- | --- | --- | --- |
| alan2207/bulletproof-react（`apps/react-vite`） | React 18 + Vite + TS；app 位于 git 子目录；含 Storybook stories | eslint、tsc、ui、metrics、boundaries（注入 dependency-cruiser 配置 + 故意制造的循环依赖） | 加夹具前 eslint / tsc 干净；boundaries 抓到循环；56 条 `ui/duplicate-name` 假阳性消失 |
| pmndrs/jotai | pnpm workspace（`packages: [".", "website"]`）；React 库 + TSX 测试；根 flat config 忽略 `website/` | eslint、tsc、ui、metrics；`website` 记为跳过 | 根包只执行一次；剩 1 条真实的 `metrics/file-lines` |

本次验证发现并修复的问题：

1. **Storybook story / 测试文件被当成组件**：`Default` 反复出现导致 56 条重名错误。现在 `*.stories.*`、`*.story.*`、`*.test.*`、`*.spec.*` 以及 `__tests__` / `__mocks__` / `e2e` 目录都不进入组件清单。
2. **子目录项目比对错了 `package.json`**：新增依赖检测读了 git 根的清单，导致 30 个应用依赖全被当成未登记。现在用 `git show base:./<path>` 按被检查项目根解析。
3. **整包被 ESLint 排除会让门禁中断**：所有文件都被忽略时 ESLint 退出 2；现在该 package 记为 `skipped`（在耗时里可见），而不是整体失败。恢复真实 lint 范围后仍能抓到违规。
4. **`pnpm-workspace.yaml` 里的 `"."` 让根包跑两遍**：现在根包去重，只执行一次。

边界：这验证的是四项检查在 React / TSX 上能正确运行，不代表 `ui` 的复用判断在语义上可靠；boundaries 仍需要项目自备 dependency-cruiser 配置。

## 本次结论的边界

- Vue 的结论来自 3 个后台类仓库；React / TSX 后续在 2 个开源仓库（Bulletproof React、Jotai）验证过。小程序、SSR、组件库仍未覆盖。
- 误报判定是人工抽样，不是全量标注；`metrics` 的“真重复”只代表“确实高度相似”，不代表“业务上应该合并”。
- 性能数据来自本机单次执行，没有做多轮统计，也没有覆盖 CI 冷启动、缓存命中等场景。
- 原仓库未被修改；如果真实接入，`init` 会在仓库根生成 `AGENTS.md`、`fe-guard.config.json`、`fe-guard.baseline.json`、`.fe-guard/` 等文件，需要团队评审后再提交。

## 关于“ui_lookup 接进 task_plan”

基于这次数据，**不建议现在做**：

- 组件清单的提取已在 React / TSX 上验证（stories 与测试文件被排除，不再产生假重名），但这只证明结构化信号可用，仍不能证明“该不该复用”。
- `task_plan` 是高频工具，把组件摘要塞进去会让每次计划调用多出 200–600 字节，且大多数计划与组件无关。
- 真实仓库的 ui 误报仍以 warn 为主（170 条），说明“同名/高重合”只是线索，还不足以让流程层自动替人做复用判断。

更合适的下一步是：先在 1–2 个真实仓库把 `ui` 以 warn 跑两周，统计“AI 新写的组件命中 warn 后，人是否真的选择复用”，再决定要不要把查询动作嵌进 `task_plan`。
