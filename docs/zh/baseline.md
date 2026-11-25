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

没有 ruleId 的 ESLint 消息会分类处理而不是一律归桶：被项目 `ignores` / flat config `files` 排除的文件**不产生违规**（与“非源文件扩展名”同属检查范围之外），真正的解析错误归 `eslint/parse-error`，未使用的 `eslint-disable` 指令归 `eslint/unused-disable-directive`，其它工具提示保留为 `eslint/no-rule`。

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

## monorepo：package 级账本

整仓库一本账会把所有 workspace package 混在同一个文件里。计数仍然按 `(文件, 规则)`，但「哪个包还背着债、这次改动是不是把这个包放宽了」没有答案；跨包重命名或移动还会改到别的团队负责的条目。package 模式让每个 package 各有一本账，棘轮语义完全不变。

根账本仍是默认（`baseline.strategy: "root"`），不主动开启就没有任何行为变化。

```json
{
  "baseline": {
    "path": "fe-guard.baseline.json",
    "strategy": "package",
    "packageFile": "fe-guard.baseline.json",
    "autoTighten": true
  }
}
```

`strategy: "package"` 要求能识别出 workspace（`package.json` 的 `workspaces`、`pnpm-workspace.yaml` 或 `lerna.json`）；单仓库请保持 `root`。

账本位置：

| 文件 | 账本 |
| --- | --- |
| 根 `package.json`、`scripts/**`、仓库级配置 | `baseline.path`（默认根目录 `fe-guard.baseline.json`） |
| workspace package 下的文件，如 `apps/web/**` | `apps/web/<baseline.packageFile>`（默认 `apps/web/fe-guard.baseline.json`） |

归属按最长 package 前缀判断：`apps/web-utils/x.ts` 不属于 `apps/web`，所有不在任何 package 下的文件归根账本。账本里的键仍是仓库相对路径，check 的判定逻辑不用改。

### `baseline` 与 `--widen` 的行为

- 真实检查只跑一次，结果按文件归属拆到各账本。
- 有 blocking 条目且没加 `--widen`：退出码 2，**不写任何账本**——不会出现「一个包接受了欠债、另一个包没写」的半成品状态。
- 加 `--widen` 时，每个 package 各自记录 `widenLog`。
- 只写真正有变化的账本；原本不存在的空账本不会创建文件。
- package 模式暂不支持 `--follow-renames`（明确报错）：重命名可能同时改变文件归属，必须先确认拆分正确。需要迁移重命名时回到 root 模式，或人工搬条目。

根账本里仍有 package 文件条目时，`check` 与 `baseline` 会报错并提示先跑 `baseline --migrate-packages`，绝不静默丢掉账本。

### 迁移已有的根账本

```bash
npx fe-guard baseline --migrate-packages --dry-run   # 只预览，不写文件
npx fe-guard baseline --migrate-packages             # 按归属拆分
git add . && git commit -m "baseline: split root ledger per package"
# 如果 baseline.strategy 还是 "root"，现在改成 "package"
npx fe-guard check
```

迁移会把属于各 package 的 `entries` / `ratchets` / `firstSeen` 搬到对应账本，保留原来的 `firstSeen`，并在新账本里追加 `initial-adoption` 与 `migrate-packages` 事件，`--verify` 可承认这次搬家。目标账本已有同 key 不同值时，命令退出 2 且不写任何文件——先人工判断哪一份是对的。如果 `strategy` 仍是 `root`，写入完成后会提示「文件已就绪；把 strategy 改为 package 后生效」。

### 查看与校验单个 package

```bash
npx fe-guard baseline --show --package apps/web
npx fe-guard baseline --verify --package apps/web --base origin/main
npx fe-guard baseline --trend --package apps/web
```

- `--show --json` 指定单个 package 时，单本账对象里会多出 `package` 与 `path`；不带 `--package` 时返回 `{ "strategy": "package", "ledgers": [...] }`。
- `--verify` 每本账分别对比 merge-base。当前账本缺失但基线里存在时失败，提示「账本被删除，历史欠债被静默解冻」；两边都不存在时，全部模式跳过，指定 `--package` 则报错。
- `--trend --json` 不带 `--package` 时返回 `{ "mode": "package", "ledgers": [{ "package", "path", "trend" }] }`。

### 限制

- package 模式暂不支持 `--follow-renames`。
- 根账本 stale 会直接报错（这是有意的）。
- 删除 package 账本只能被 `--verify` 拦住，`check` 本身看不出。
- `packageFile` 必须位于 package 内；放在被 gitignore 的目录里，账本不会提交。

root 模式仍是默认，行为与之前完全一致。

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
