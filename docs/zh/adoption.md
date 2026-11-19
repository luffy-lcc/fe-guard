# 渐进式落地与常见担忧

[← 返回 README](../../README.zh-CN.md) · [English](../adoption.md)

接入只是起点。这一节回答两件事：怎么按项目实际逐步用满能力（而不是上来全开），以及接入前后常见的几个顾虑。

## 落地建议：信号驱动，一次一项

目标是「恰好覆盖当前痛点」，不是「七项全开」。小项目可能长期只需要基础六项，那也是对的。判断依据不靠拍脑袋，而靠 fe-guard 自带的三个观测手段：

- `doctor`：哪些检查在跑、覆盖率、各项耗时。
- `baseline --show --by-rule`：存量欠债集中在哪条规则、哪个目录。
- `check` 报告 + `.fe-guard/` 事件流：哪类违规反复出现、误报频率、AI 绕过记录。

每项能力都有明确的「痛点信号」，信号出现再开：

| 能力 | 什么时候开 | 怎么观测到 |
| --- | --- | --- |
| 基础六项 + commit 钩子 | 接入即开（默认） | `init` 自带 |
| boundaries | 分层变复杂 / 出现循环引用 / 多人需架构约束 | 撞见循环 import；`doctor` 模块数上升 |
| 流程层（MCP task） | AI 成主力且常「声称完成」却返工 | 交付返工率高；想要 `testFile` 真跑证据 |
| 编辑实时钩子 | commit 拦截太晚，AI 已改一大片 | 钩子频繁拦下大量违规 |
| 收紧阈值 / 清存量 | 某规则存量集中、团队有余力 | `baseline --by-rule` 头部规则占比高 |
| CI 第二道门 | 多人协作 / 担心 `--no-verify` 绕过 | 出现绕过记录 |
| 按包阈值 `overrides` | monorepo 新旧包标准不一 | 各目录违规密度差异大 |

节奏：每周跑一次 `doctor` + 看 baseline 趋势；哪个痛点冒出来就开哪一项；**一次只加一项，观察误报率与耗时，再决定下一项**。这样既不会过早复杂化，也不会漏掉该补的能力。

## 常见担忧澄清

**默认阈值是不是太严？开源项目很多文件上千行。**
阈值是配置不是铁律，默认值面向业务项目。开源项目的千行文件多是「多轮 review 沉淀的结果」，业务项目的千行文件多是「没人拆的过程」——工具拦的是后者。棘轮拦的是「比 baseline 更差」，不是「必须小于 X」。复杂模块可调高 `maxFileLines` / `maxFunctionLines`，或用 `overrides` 按目录差异化，或关掉 `metrics`。判断标准：这 1000 行是「就该这么长」还是「没人拆」——前者调阈值，后者该修。

**工具能判断一个文件「该不该」这么长吗？交给 AI 判断是不是更准？**
不能。语义判断（该不该复用、该不该这么长）不在工具能力内，这是零依赖设计的取舍。工具只把确定性信号（行数、同名、高重合、重复库）变成失败或告警。「该不该」留给人或 AI：AI 在响应 blockers 时读文件判断，合理就 `false-positive --reason` 留证据，不合理就重构。不需要把 AI 判断内置进工具——现有流程已强制 AI 必须响应 blockers，工具负责「不能跳过判断」，而非「替代判断」。

**必须装 dependency-cruiser / `@vue/compiler-sfc` 吗？**
不是必须。boundaries 可关；`@vue/compiler-sfc` 是 depcruise 解析 `.vue` 需要的，不是 fe-guard 需要的（fe-guard 零运行时依赖）。

| 项目类型 | boundaries | 需要 `@vue/compiler-sfc` |
| --- | --- | --- |
| 纯 JS/TS（无 `.vue`） | 开 | 不需要 |
| Vue | 关 | 不需要 |
| Vue | 开 | 需要（Vue 2 用 `vue-template-compiler`） |

Vue 项目开 boundaries 但缺编译器时，depcruise 会静默跳过 `.vue` 造成假通过；fe-guard 对比「磁盘 `.vue` 数 vs 入图 `.vue` 数」，不完整就报 `boundaries/not-executed`（不可入账）。pnpm 不提升传递依赖，需显式 `pnpm add -D @vue/compiler-sfc` 供 depcruise 解析。小项目建议先不开 boundaries，等分层复杂或出现循环引用再开。

**什么时候才算「完全引入」？**
没有「必须全开」的时刻。参考状态：七项全开 + 流程强制 + commit/CI 双闸 + baseline 持续收紧 + 误报有证据链。但到不到这个状态取决于项目——以痛点信号为准，不为全开而全开。

**AI 编程时需要编辑实时触发吗？**
三层触发，可靠性递减：commit 钩子（硬闸，必跑）→ MCP 流程（`task_gate` 真验证，引导级）→ 编辑实时（可选）。默认前两层已够：commit 兜底不可绕过（除 `--no-verify`），`task_gate` 在「声称完成」时真跑检查与测试。实时触发（`afterToolCall`）会让中间状态频繁报错、增加延迟，多数场景不必；只有「commit 拦截太晚、AI 已改一大片」时才值得加。hooks 只是示例文件，需在 IDE 设置里对齐事件名才生效。

**能不能只在本机生效、不污染仓库？**
可以。把接入产物全部本地化：fe-guard 装进一个被忽略的独立工具目录（如 `.fe-guard-tools/`），配置 / 账本 / 状态目录用 `.git/info/exclude` 忽略（本地专属、永不入库），钩子与 MCP 指向该目录。代价：账本本地化意味着换机器 / 克隆需重新 `init` + `baseline`，适合单人本地使用。团队共享则应提交 `fe-guard.config.json` + `fe-guard.baseline.json`。
