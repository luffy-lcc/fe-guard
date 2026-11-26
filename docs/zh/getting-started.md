# 快速上手与日常使用

[← 返回 README](../../README.zh-CN.md) · [English](../getting-started.md)

前提：Node 18+，项目是 git 仓库，本地已装好 ESLint / TypeScript / dependency-cruiser（没有也没关系，对应检查会明确报“未执行”或可关闭）。

## 1. 安装

```bash
npm i -D fe-guard
npx fe-guard --version
```

内网没有公共 npm 时，用 tarball 或私有 registry，见[内网分发](#内网分发两条路任选一条)。

包尚未发布到 npm。当前发布版为 v0.6.0，可从 GitHub 安装：`npm i -D github:luffy-lcc/fe-guard#v0.6.0`。

## 2. 初始化

```bash
npx fe-guard init
```

生成这些文件：

| 文件 | 作用 |
| --- | --- |
| `fe-guard.config.json` | 唯一的配置入口：检查项开关、严重级别、baseline 与报告路径、流程层开关 |
| `fe-guard.baseline.json` | 历史欠债账本，初始为空 |
| `AGENTS.md` | 追加一段受管片段（带 `<!-- fe-guard:begin -->` 标记），是跨工具的唯一事实源 |
| `.trae/mcp.json`、`.cursor/mcp.json`、`.mcp.json`、`.vscode/mcp.json`、`.gemini/settings.json` | 把 fe-guard MCP server 挂到 Trae / Cursor / Claude Code / VS Code / Gemini CLI（每个文件只接管自己的 `fe-guard` 条目，不覆盖已有 server 或其它设置；不碰用户 home） |
| `.trae/rules/fe-guard.md`、`.cursor/rules/fe-guard.mdc` | 同一份流程说明，按各自格式生成 |
| `.trae/commands/fe-guard-*.md` | 两个斜杠命令：看下一步、跑门禁 |
| `.trae/hooks.example.json`、`.cursor/hooks.example.json` | hooks 示例（不会自动生效） |

`init` 可以重复执行：内容没变就不写文件，AGENTS.md 只替换 marker 之间的片段，不会重复追加。

写配置之前 `init` 会先探测项目：没有 `tsconfig.json`（根目录与 workspace 子包都算）就关闭 `typescript`；没有 ESLint 配置就关闭 `eslint`；没有 `.dependency-cruiser.{cjs,js,json}` 就关闭 `boundaries`，并按实际存在的那个文件写 `args`。被关闭的检查会打印出来并写成 `enabled: false`，因此纯 JS 项目第一次 `check` 就能正常通过，而不是直接中断。前置条件补齐后把开关改回 true 即可；已存在的配置不会被重新探测，除非显式加 `--force`。

### 预设与 `--dry-run`

`init --preset <名称>` 给生成的配置定一个起点。执行顺序是「预设先定基调（开关取舍、阈值宽窄），探测再叠加降级」：探测只关掉缺前置条件的检查，不会把预设关掉的检查重新打开，也不会改动阈值。

| 预设 | 改动 |
| --- | --- |
| `js` | 纯 JavaScript：关闭 `typescript` 与 `ui` |
| `vue` | 显式写出 `vue-tsc` 自动切换（`typescript.vue: "auto"`）；默认值本就面向 Vue |
| `legacy` | 放宽腐化阈值：单文件 800 行、函数 150 行、`any` 50 个、重复率 0.6；大 diff 40 文件 / 1200 行 |
| `monorepo` | 显式按 package 执行（`workspace: "auto"`），并把大 diff 预算放宽到 40 文件 / 1000 行 |

`init --dry-run` 会打印每个将要创建或更新的文件及其完整内容，但不写任何文件：

```bash
npx fe-guard init --preset legacy --dry-run   # 只看预览
npx fe-guard init --preset legacy             # 真正写入
```

配置已存在时（未加 `--force`）`--preset` 不会生效，`init` 会明确提示，而不是悄悄改你的设置。

## 3. 把现有违规记进 baseline

```bash
npx fe-guard baseline
```

输出类似：

```
fe-guard baseline 已更新: fe-guard.baseline.json
  当前条数型违规: 8，涉及 5 个文件
  当前指标型条目: 4
  新增条目: 12，收紧: 0，删除: 0
  首次记录存量: 12
```

此时 `fe-guard.baseline.json` 的内容是：

```json
{
  "version": 3,
  "note": "由 fe-guard 生成。entries 是「文件 + 规则 -> 允许的违规条数」；ratchets 是「文件 + 指标 -> 允许的最大值」（单文件行数、重复率等）。两者都只会自动收紧，不会自动放宽。firstSeen 是首次入账日期；widenLog 记录每次显式放宽，供 CI 审计。",
  "entries": {
    "src/services/user.ts": { "boundaries/services-no-ui": 1 },
    "src/utils/legacy.ts": { "typescript/TS2322": 1 },
    "src/utils/math.ts": {
      "eslint/@typescript-eslint/no-unused-vars": 1,
      "eslint/eqeqeq": 1
    }
  },
  "ratchets": {
    "src/pages/home.ts": {
      "metrics/file-lines": 820,
      "metrics/function-lines": 134,
      "metrics/any": 3,
      "metrics/duplication": 0.11
    }
  },
  "firstSeen": {
    "src/services/user.ts::boundaries/services-no-ui": "2026-11-13",
    "src/utils/math.ts::eslint/eqeqeq": "2026-11-13"
  },
  "widenLog": [
    { "at": "2026-11-13T08:00:00.000Z", "type": "initial-adoption", "entries": 4, "ratchets": 4 }
  ]
}
```

读法分三部分：

- `entries`：`src/utils/math.ts` 这个文件，历史上允许有 1 条 `eqeqeq` 违规、1 条 `no-unused-vars` 违规。这是**条数**账本。
- `ratchets`：`src/pages/home.ts` 历史上最长 820 行、最长函数 134 行、3 个 `any`、重复率 0.11。这是**值**账本，记录的是「允许的最大值」。
- `firstSeen`：每条规则首次入账的日期。只记一次，之后收紧/重跑都不会变，方便回答「这条为什么在」。
- `widenLog`：每次放宽的来源。首次接入记为 `initial-adoption`，显式放宽记为 `widen` 并附逐条明细，`baseline --verify` 用它判断有没有人不带 `--widen` 偷偷放宽。

两本账的棘轮语义一样：只能往下调，不能往上调。metrics 报出的 `value` 超过账本才失败。棘轮机制详见 [baseline 棘轮](baseline.md)。

不确定某条为什么在账本里时，不要直接改 JSON，用 `baseline --show` / `--by-rule` / `--verify` 查。

### monorepo：按 package 管理存量

默认是全仓库一本账。monorepo 里可以给每个 workspace package 各留一本账，某个 app 的清理不会和另一个 app 的欠债混在一起：

```json
{ "baseline": { "strategy": "package", "packageFile": "fe-guard.baseline.json" } }
```

`baseline.strategy: "package"` 要求能识别出 workspace。包内文件写到 `<package>/<packageFile>`；根 `package.json`、`scripts/` 与仓库级文件仍留在 `baseline.path`。

```bash
npx fe-guard baseline                               # 跑一次，按文件归属拆账
npx fe-guard baseline --migrate-packages --dry-run  # 已有根账本：先预览
npx fe-guard baseline --migrate-packages            # 再实际拆分并提交结果
npx fe-guard baseline --show --package apps/web
npx fe-guard baseline --verify --package apps/web --base origin/main
```

常见错误：

- `根账本 ... 里仍有 N 条 package 文件条目` — 根账本还没拆干净；先跑 `baseline --migrate-packages`，再 `check`。
- `账本被删除，历史欠债被静默解冻` — `--verify` 发现基线里存在的 package 账本被删了；把账本恢复，或显式迁移条目，而不是删文件。

完整行为与限制见 [monorepo：package 级账本](baseline.md)。

## 4. 跑检查

```bash
npx fe-guard check
```

```
fe-guard  mode=full
checks: ESLint=error, TypeScript (tsc)=error, 架构边界 (dependency-cruiser)=error, 依赖守卫=error, 组件清单 / 重复实现=error, 腐化指标棘轮=error, 大 diff 拦截=error
profile: full
存量违规 12 条（baseline 允许），新增 0 条（error 0 / warn 0）
报告: .fe-guard/report.json
结果：通过（退出码 0）
```

`mode` 是检查范围（`full` / `diff-only` / `staged`），`profile` 是档位（`fast` / `full`），两者独立。

## 5. 试试制造一条新违规

在任意源文件里加一行 `const unused = 1`，再跑：

```
存量违规 12 条（baseline 允许），新增 1 条（error 1 / warn 0）
  [new] src/pages/home.ts:9  eslint/@typescript-eslint/no-unused-vars (error)
        'unused' is assigned a value but never used.
报告: .fe-guard/report.json
结果：失败（退出码 1，存在新增违规）
```

把这一行删掉，又回到退出码 0。这就完成了闭环。

## 6. 第一次接入会看到什么

老项目第一次 `check` 时，所有存量问题都会被当成“新增”，可能一次出现几百上千条。这不是工具坏了，也不是项目刚被改烂了。当前的处理方式：

- 默认输出**只逐条展示新增**，存量收敛成一行：`存量违规 956 条（baseline 允许，默认不逐条展示；--all 看全部，fe-guard baseline --show 按文件看）`。
- 还没入账时会额外打印一段引导，明确告诉你下一步是 `npx fe-guard baseline`。
- 想逐条看存量：`npx fe-guard check --all`；想看账本分组：`npx fe-guard baseline --show`。
- `init` 结束时也会打印同一段引导，避免第一次接入被几百条吓退。

真正会挡住提交的只有**新增**。存量在你执行 `baseline` 的那一刻就被明确接受，并记录首次日期，后续只能收紧。

## 7. 觉得某条是误报

不要直接关检查。先把判断沉淀下来，供后面统一修正规则：

```bash
npx fe-guard false-positive --file src/x.ts --line 42 \
  --rule eslint/eqeqeq --reason "这里比较的是用户输入的表单字符串"

npx fe-guard false-positive --summary   # 哪条规则、哪类检查被标得最多
npx fe-guard false-positive --list      # 全部记录（含时间、文件、原因）
npx fe-guard false-positive --suggest   # 按规则给出降级/关闭建议
```

记录写在 `.fe-guard/false-positives.jsonl`，只追加、不改写、可审计。边界要说清：**标记误报不会让 `check` 忽略这条违规**，它只是证据；要降级请改 `level`，要关闭请改 `enabled`，并走评审。

## 8. 验收条件与证据

通过 MCP 流程做任务时，每条验收条件都是结构化的：

```json
{ "text": "空态显示 0 条", "type": "ui", "source": "设计稿/spec-v3#empty" }
```

- `type` 是 `ui` / `interaction` / `data` / `tracking` / `compat` / `performance` 之一；`source` 写明出处。推断项写成 `source: "assumption: 原因"`。
- `assumption` 条件需要人确认：`npx fe-guard task confirm C2 --note "..." --yes`；未确认的推断项会阻止交付。
- 能写成测试就挂 `testFile`；否则 `verify: "manual"` 必须有 `evidenceFile`（截图说明、对账记录），门禁会校验存在且非空，并记录字节数与 sha256。类型不明显时加 `evidenceKind`（`screenshot` / `diff` / `log`）；自动化视觉检查用 `verify: "gate"` + `evidenceKind: "diff"`，并配置 `workflow.visualDiff.command`。
- 门禁失败后用 `task_lesson` 写复盘（结论 + 证据 + scope）。`workflow.distill` 默认 `enforce`，不写复盘不能交付；确实不需要时才改 `warn` / `off`。
- 进度口径是「N 完成 / M 待办」（以及未完成）；有待办时交付标记 `degraded`，工具不会说「全部完成」。

`npx fe-guard task stats` 只读查看当前任务与归档的交付 / 降级、门禁失败率、平均门禁次数、top blocker、复盘与待办数量。

## 常用命令

```bash
npx fe-guard init                 # 生成配置 / baseline / AGENTS.md 片段 / IDE 接入产物
npx fe-guard init --force         # 覆盖已存在的配置和 baseline（谨慎）

npx fe-guard baseline             # 把当前违规记为 baseline（拒绝变宽）
npx fe-guard baseline --widen     # 显式接受新的欠债
npx fe-guard baseline --follow-renames  # 迁移重命名文件的账本条目（先 git add，留审计）
npx fe-guard baseline --show      # 按文件分组看账本：规则、数量、首次入账日期
npx fe-guard baseline --show --by-rule # 按规则聚合，按可清理条数排序（先修哪三条）
npx fe-guard baseline --show --all # 文件多时展开全部
npx fe-guard baseline --verify    # 对比 merge-base，baseline 未登记的放宽直接失败
npx fe-guard baseline --verify --base origin/main  # 显式指定基线

npx fe-guard doctor               # 看当前档位、每项覆盖、跳过、上次耗时、baseline 规模
npx fe-guard doctor --profile fast --json # 同样内容，机器可读（含 emptyChecks）

npx fe-guard check                # 全量检查（默认档位 full，只逐条展示新增）
npx fe-guard check --full         # 明确跑全档（等价于 --profile full）
npx fe-guard check --profile fast # 快档：ESLint/依赖/组件/指标，钩子用
npx fe-guard check --all          # 连存量也逐条展示
npx fe-guard check --diff-only    # 只检查本次改动涉及的源文件（工作区 + 暂存 + 未跟踪）
npx fe-guard check --staged       # 检查暂存区内容（提交前钩子用）
npx fe-guard check --json         # stdout 只输出 JSON 报告
npx fe-guard check --config ./configs/fe-guard.alt.json  # 换一份配置
FE_GUARD_CONFIG=./configs/fe-guard.alt.json npx fe-guard check  # 环境变量方式
npx fe-guard --version            # 输出自身版本

npx fe-guard false-positive --file src/x.ts --line 42 --rule eslint/eqeqeq --reason "..."
npx fe-guard false-positive --list / --summary / --suggest

npx fe-guard task                 # 查看当前任务、验收条件与门禁证据
npx fe-guard task events          # 事件流（可审计 AI 做过什么、试过绕过什么）
npx fe-guard task reset --yes     # 归档当前任务并清空（归档到 .fe-guard/tasks/）
npx fe-guard task stats           # 只读查看当前任务与归档的交付 / 门禁 / 复盘统计
npx fe-guard task confirm C2 --note "..." --yes   # 人工确认推断项
npx fe-guard task defer C3 --reason "..." --yes   # 把条件转为上线待办
npx fe-guard mcp                  # 以 MCP stdio server 启动（IDE 挂载的就是它）

npx fe-guard check --root ../app  # 指定项目根目录（默认当前目录）
```

`--diff-only` 和 `--staged` 的差别：

- `--diff-only`：相对 `diff.base`（默认 `HEAD`）的工作区改动 + 暂存改动 + 未跟踪的新文件。
- `--staged`：检查**暂存区里的内容**（导出到临时影子目录），适合 pre-commit。暂存后又改了文件但没 add，不会被误判为通过。ESLint / deps / ui / metrics 读影子目录；TypeScript / boundaries / diff-size 仍读工作区，报告里会明确标注。项目根是 git 根的子目录（前后端同仓）时同样可用：快照只导出项目根下的文件，检查自动偏移到对应子目录。

两种模式下，baseline 只会收紧「本次范围内文件」对应的条目，不会误删其它文件的账。

## doctor：一条命令回答“我这儿还缺什么”

没有 CI、没人读 README 时，`doctor` 是接入主入口。它只做只读探测，不执行检查，随时可以跑：

```sh
npx fe-guard doctor
npx fe-guard doctor --profile fast --json
```

真实输出（某真实仓库副本）：

```
fe-guard doctor  (profile: full)
配置: fe-guard.config.json
档位: full — 全量核对用：包含类型检查、架构边界与大 diff
workspace: 单仓库（未检测到 workspaces / pnpm-workspace.yaml / lerna.json）

检查覆盖:
  ESLint      覆盖 1 个仓库  上次 1.7s
  TypeScript  覆盖 1 个 package  耗时未知（跑一次 check 后显示）
      （Vue 项目，全档会用 vue-tsc）
  架构边界        已关闭（配置里已关闭）
  依赖守卫        覆盖 402 个文件  上次 1.4s
  组件清单        覆盖 225 个文件  上次 1.3s
  腐化指标        覆盖 402 个文件  上次 1.2s
  大 diff      覆盖 1 个仓库  耗时未知（跑一次 check 后显示）
      只在全档执行

baseline: 1276 行 / 136 文件 / 771 条规则型（17 条规则）+ 185 条指标型
```

它能回答四件事：当前档位跑什么；每项覆盖到哪些 package、哪些被跳过；上次每项耗时；baseline 规模。`--json` 还会给出 `emptyChecks`（覆盖为 0的检查），方便脚本判断“哪些检查是空的”。

## 接入方式：本地钩子 + 手动全档

fe-guard 不假设**目标项目**有 CI——它的使用场景包括“代码在内网、没有统一远端流水线”。唯一的执行点可以是开发者本机：

- **提交前**：`npx fe-guard check --staged --profile fast`，只查暂存区，目标 3 秒内。
- **合并前 / 定期**：`npx fe-guard check --full`，包含 `tsc` / `vue-tsc`、架构边界、大 diff。
- **改过 baseline 之后**：`npx fe-guard baseline --verify --base <目标分支>`，确认没有不带 `--widen` 的静默放宽。
- **接入前 / 换人接手**：`npx fe-guard doctor`，先看这个仓库到底被哪些检查覆盖、哪些是空的。

### 提交前钩子（Husky）

示例见 [`examples/husky-pre-commit`](../../examples/husky-pre-commit)：

```sh
# .husky/pre-commit
npx fe-guard check --staged --profile fast
```

只查暂存内容，速度可控；检查不通过，提交被拦下。`git commit --no-verify` 仍然能绕过——这是团队约定问题，工具不做对抗。

### 关于 CI

fe-guard **自身开发仓库**有 GitHub Actions（`.github/workflows/ci.yml` 跑 `verify:local`）。但它不要求**目标项目**有 CI：内网项目留一个永远不跑的流水线文件，会让接手的人误以为“已经有 CI 兜底”，从而省掉唯一真正执行的本地钩子。如果目标项目接上了任意流水线（Jenkins / GitLab / 自建 / GitHub Actions），把这一条命令搬过去即可，不需要改工具：

```sh
npm run verify:local   # 在 fe-guard 仓库内：npm test + v1/v2/v3/v4 全部验证 + self-check
# 在目标项目内，CI 只需跑：npx fe-guard check --full
```

### SARIF：接 GitHub Code Scanning

`check --format sarif` 把 SARIF 2.1.0 打到 stdout，可直接上传：

```yaml
permissions:
  contents: read
  security-events: write   # upload-sarif 需要
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 22 }
      - run: npm i -D github:luffy-lcc/fe-guard
      - id: guard
        run: npx fe-guard check --full --format sarif > fe-guard.sarif
        continue-on-error: true          # 先上传，再根据结果决定是否失败
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with: { sarif_file: fe-guard.sarif }
      - if: steps.guard.outcome == 'failure'
        run: exit 1
```

- **只输出新增违规与 `not-executed`**。存量已在 baseline 里；全量上传会淹没告警页，随后 baseline 收紧又会让告警批量消失。退出码仍是 0/1/2，CI 照样会因新增违规失败。
- **boundaries 只有文件级结果**。dependency-cruiser 不提供行号，因此省略 `region`——GitHub 把告警挂在文件上，不指向具体行，也不伪造行号。
- `not-executed` 仍然是 `level: error`，同时 `executionSuccessful: false` 并附带工具通知，未执行的检查不会看起来像通过。
- 需要仓库可启用 code scanning（私有仓库需要 GitHub Advanced Security）；没有条件就继续用 `npx fe-guard check --full` 当门禁。

### 静态 HTML 报告

`check --format html` 在 JSON 报告旁边写一个自包含文件（默认 `.fe-guard/report.html`，跟随 `report.path`），stdout 只打印路径，退出码不变。CSS 与筛选脚本全部内联——无 CDN、字体、图片或跳转链接——离线可打开，也能作为 CI artifact。禁用 JavaScript 时整张表仍然渲染，脚本只负责过滤行。

```yaml
      - run: npx fe-guard check --full --format html
        continue-on-error: true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: fe-guard-report
          path: .fe-guard/report.html
```

页面列出全部违规（新增 / 存量 / `not-executed`）、每项检查的状态（`unavailable` / `skipped` 会明确标出）、baseline 收紧与移除明细，以及各检查耗时。它是单次运行的快照，趋势留到后续版本。

### baseline 趋势

`fe-guard baseline --trend [--limit <n>] [--json]` 读取已提交的 `fe-guard.baseline.json` 历史，每个提交一行：存量条数、变化量、指标键数量、显式放宽次数。用来回答“欠债到底有没有在还”，且不写任何文件、不产生第二份事实源。

- 只统计**已提交**的历史。baseline 还没入库时会直接说明（退出码 0）；建议入库，让开发者和 CI 共用同一份账本。
- `--json` 返回 `{ available, path, truncated, versions, summary, latestWidenLog }`。
- 放宽次数只算显式 `--widen`；首次入账和重命名迁移不算放宽。`firstSeen` 用于“最近 30 天新入账”这一行。

### 任务事件摘要

`fe-guard task events --summary [--json]` 只读聚合当前任务的事件流：按类型计数、门禁次数（通过 / 失败、mode 分布、最近结果、单次新增最大值）、按工具与原因聚合的拒绝、验收条件覆盖情况，以及是否交付（是否 degraded）。

## 内网分发：两条路，任选一条

不依赖是否存在私有 npm registry。两条路产出的都是同一个包，升级/回滚都以“项目里锁定的版本”为准。

### 路线 A：私有 registry（有就用）

```sh
# 维护者（有 registry 发布权限）
npm publish --registry https://npm.internal.example.com

# 使用方项目
npm i -D fe-guard --registry https://npm.internal.example.com
npx fe-guard --version
```

升级：`npm i -D fe-guard@0.6.0`。回滚：`npm i -D fe-guard@0.5.0`。建议在项目里提交 `package-lock.json`，保证每个人装到同一版。

### 路线 B：tarball 直接装（没有 registry 也能用）

```sh
# 维护者机器上
npm pack                      # 产出 fe-guard-0.6.0.tgz
# 把 tgz 通过内网网盘 / scp / 共享目录发给使用方

# 使用方项目
npm i -D ./fe-guard-0.6.0.tgz
npx fe-guard --version
```

升级：拿到新 tgz 后 `npm i -D ./fe-guard-0.6.0.tgz`。回滚：`npm i -D ./fe-guard-0.5.0.tgz`（旧 tgz 保留在共享目录即可）。

`npm pack` 只包含 `bin/`、`src/`、`examples/`、`README.md`、`README.zh-CN.md`、`LICENSE`、`CHANGELOG.md`，不包含测试与验证脚本；`bin` 的执行位由 npm 自动恢复，安装后 `npx fe-guard` 可直接运行。

### 单人维护多仓库，成本在哪

- **升级不是“发一版就完了”**：每个仓库各自锁定版本，要逐个仓库 `npm i -D` 并验证。建议先在一个仓库用满两周，再推广。
- **配置会分叉**：不同仓库的阈值、关闭项不同，升级时只应改工具版本，不应顺手改配置；配置改动单独提交。
- **schema 不兼容会直接报错**：配置 `schemaVersion` 或 baseline `version` 比工具新时，工具会退出码 2 并给出升级指引，不会静默重播种。所以升级顺序是“先升工具，再看是否要迁移配置”。
