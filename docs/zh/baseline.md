# 核心概念：检查项、baseline 棘轮与档位

[← 返回 README](../../README.zh-CN.md) · [English](../baseline.md)

## 检查项（七个适配器）

三个检查包在外部工具外面；另外四个是 fe-guard 自带的轻量实现，读源码、不跑编译器。七个都走同一套 `enabled` / `level`，也都产出同一种违规结构。

| 检查项 | 默认工具 | 归一化后的 `ruleId` 形式 |
| --- | --- | --- |
| `eslint` | `eslint --format json` | `eslint/no-unused-vars` |
| `typescript` | `tsc --noEmit --pretty false`（Vue 自动 `vue-tsc`） | `typescript/TS2322` |
| `boundaries` | `depcruise src --output-type json` | `boundaries/services-no-ui` |
| `deps` | 自带（读 import + package.json） | `deps/capability-conflict`、`deps/phantom`、`deps/unregistered`、`deps/capability-duplicate` |
| `ui` | 自带（扫 `.vue` / `.tsx` / `.jsx`） | `ui/duplicate-name`（error）、`ui/duplicate-props`（warn） |
| `metrics` | 自带（token 统计，无外部依赖） | `metrics/file-lines`、`metrics/function-lines`、`metrics/any`、`metrics/duplication` |
| `diff-size` | 自带（`git diff --numstat`） | `diff-size/files`、`diff-size/lines` |

不管哪个工具，最终都变成同一种结构：

```json
{
  "ruleId": "eslint/eqeqeq",
  "file": "src/utils/math.ts",
  "line": 11,
  "severity": "error",
  "message": "Expected '===' and instead saw '=='.",
  "fix": "可自动修复：eslint --fix"
}
```

字段说明：

- `ruleId`：`工具名/规则名`，baseline 用它做键，也让报告能追溯到是哪个工具报的。
- `file`：相对仓库根的 posix 路径，换机器也不会漂。
- `line`：工具给行号就用；dependency-cruiser 不提供行号，这里为 `null`。
- `severity`：`error` / `warn`。配置里把某个检查的 `level` 改成 `warn` 后，这里统一按 `warn` 输出，也不会导致失败。
- `fix`：工具给得出修复建议就填，给不出就是 `null`（fe-guard 不代替你改代码）。

## baseline 棘轮（核心机制）

baseline 的存储粒度是 **(文件路径, ruleId) → 允许的违规条数**，不是「全仓库总数」，也不是「每个文件的总数」。

为什么不能只记总数？看这个例子：

```
src/utils/math.ts 原有违规：eqeqeq 1 条
开发者做了两件事：
  1. 把 `a == b` 改成 `a === b`      → eqeqeq 少 1 条
  2. 新写了一个 `: any`              → no-explicit-any 多 1 条
```

如果 baseline 只记「这个文件允许 2 条违规」，改动后总数还是 2，检查会通过，新问题被悄悄放进来。按 `(文件, ruleId)` 记账时，`no-explicit-any` 是一个全新的键，允许数为 0，于是立刻失败——**同时**旧规则 `eqeqeq` 的允许数会被收紧。

三条规则：

| 情况 | 结果 | baseline 变化 |
| --- | --- | --- |
| 某 (文件, 规则) 的违规数超过允许数 | 失败（退出码 1） | 不变，不放宽 |
| 少于允许数（修掉了存量） | 通过 | 自动收紧到当前数量；降到 0 就删除该条目 |
| 出现了 baseline 里没有的 (文件, 规则) | 失败 | 不变 |

所以要「接受新的欠债」，必须显式执行 `npx fe-guard baseline --widen`，并建议在提交说明里写清原因。`check` 永远只收紧，不扩额。

### 两种账本：条数与数值

`metrics` 不适合记「条数」——一个文件历史上 820 行，不是「允许 1 条超长违规」，而是「允许最长 820 行」。所以 baseline 里多了 `ratchets` 一节，语义仍是**只紧不松**：

| 情况 | 结果 | baseline 变化 |
| --- | --- | --- |
| 本次数值 > 账本允许的最大值 | 失败（退出码 1） | 不变，不放宽 |
| 本次数值 < 账本值（重构瘦身了） | 通过 | 自动收紧到本次数值 |
| 文件里没有这个指标了 | 通过 | 删除该条目 |
| 文件是新的、账本里没有 | 失败 | 不变，需要显式 `baseline` 入账 |

`diff-size` 是唯一**不参与 baseline** 的检查：大 diff 是「这次的事件」，不是历史欠债，入账等于把闸门永久关掉。它只看本次改动，`check` 不会把它写进账本。

为什么不是记录到「第几行」？行号会因为格式化、插代码而漂移，会制造大量假失败；这里选择「同文件 + 同规则」的计数，用足够低的维护成本挡住绝大多数新增问题。代价写在[已知限制](limitations.md)里。

## 退出码与报告

| 退出码 | 含义 |
| --- | --- |
| `0` | 通过（含：全局 `enabled:false` 的显式紧急止血、本次变更没有可检查的文件） |
| `1` | 存在新增违规（超出 baseline 的部分里有 error 级别），或某项检查产出“未执行”违规 |
| `2` | 配置或环境错误：配置缺失/非法、没有任何启用项、ESLint 输出无法解析、baseline 拒绝放宽、`--verify` 无法确定基线等 |

每次 `check` 都会写一份机器可读报告到 `.fe-guard/report.json`（路径可配），包含 `ok`、`exitCode`、`mode`、`profile`、`scope`、`summary`、`checks[]`（每项带 `status: "ran" | "skipped" | "unavailable"`）、`staged`（`--staged` 时标注哪些检查读暂存快照）、逐条 `violations`（带 `status: "new" | "known"`）以及本次的 `baseline.tightened` / `removed`。加 `--json` 时 stdout 只输出这份 JSON，方便接 `jq` 或其它脚本。

**“检查未执行”是不可入账的 error**：缺工具、超时、git 不可用、子进程崩溃都会产出 `<check>/not-executed`，它的 `severity` 永远是 error，`isBaselineExempt` 永远为真——`baseline` 不会吸收它。

## 两档：fast 与 full

档位是代码里的内置常量（`src/profiles.js`），不在配置里维护两份 `enabled`——两份配置一定会漂移。

| 档位 | 包含的检查 | 用途 | 目标 |
| --- | --- | --- | --- |
| `fast` | ESLint、依赖守卫、组件清单、腐化指标 | git 钩子、AI 会话内 | 3 秒内 |
| `full` | 再加 TypeScript / vue-tsc、架构边界、大 diff | 合并前、定期手动 | 按项目规模 |

默认是 `full`，所以直接 `fe-guard check` 与旧版本行为一致。钩子建议 `--profile fast`，需要全量时 `--full`。

**档位跳过会明确写出来**，不是“看起来全过了”：报告的 `profile` 字段、stdout 的 `profile:` 行都会列出被这个档位跳过的检查，并提示 `check --full`。

fast 的真实边界：fe-guard 不会改写项目自己的 ESLint 配置，所以如果那个配置本身启用了 type-aware 规则，fast 仍然会为类型信息付费。先跑 `fe-guard doctor` 看上次耗时；超过 3 秒就把 ESLint 配置里最贵的规则留给全档，或缩小 `checks.eslint.targets`。

### 配置路径覆盖

```sh
fe-guard check --config ./configs/fe-guard.frontend.json
FE_GUARD_CONFIG=./configs/fe-guard.frontend.json fe-guard check
```

优先级：`--config` > `FE_GUARD_CONFIG` > 仓库根的 `fe-guard.config.json`。相对路径按当前工作目录解析；baseline 与报告路径仍按配置里的相对值、以仓库根为基准。
