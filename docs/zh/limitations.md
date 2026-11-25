# 已知限制与明确没做的事

[← 返回 README](../../README.zh-CN.md) · [English](../limitations.md)

## 检查能力的限制（诚实版）

- **baseline 记录的是「文件 + 规则」的计数**（metrics 记最大值），不是具体行。因此**同一文件、同一规则**内部「修一条、又新增一条」在计数上等价于没变，无法识别；跨规则的变化可以识别。
- **文件重命名**默认仍表现为「旧文件条目删除 + 新文件条目新增」；用 `baseline --follow-renames`（重命名先 `git add`）可把账本键迁移到新路径，保留 firstSeen、widenLog 留痕、`--verify` 承认迁移。未跟踪的新文件 git 配不成重命名。
- **不做自动修复执行**，只把工具的修复可能性放进 `fix` 字段。
- **`--diff-only` 只按路径过滤结果**，tsc / dependency-cruiser 仍全量运行；`--staged` 下 tsc / dependency-cruiser / diff-size 也仍读工作区（报告会标注）。
- **不读取 `.eslintignore` / `.gitignore` 之外的自定义忽略规则**；ESLint 自己的忽略逻辑仍然生效。
- **deps 只做静态解析**。`require(name)` 里如果是变量、运行时拼出来的包名、或者经过构建插件注入的依赖，它看不到；`import type` 和普通 import 一样处理。它也不判断「这个包用得对不对」，只判断「是不是被禁/未声明/重复」。
- **deps 的「新增依赖」依赖 git**。没有 git、或 `diff.base` 指向的提交里没有 `package.json` 时，`deps/unregistered` 不会触发（其余三条规则仍然工作）。
- **deps 跳过 `.d.ts`**。自动生成的类型声明（如 `components.d.ts`）里的 import 不代表运行时依赖，不参与「未声明 / 幻觉包」判定。
- **ui 是启发式**。它按文件名/`defineOptions` 推断组件名，按 `defineProps` / 函数参数推断 props。以下情况抓不到或会误报：动态生成组件名、props 从外部类型别名（而非本文件 `interface` / 字面量）继承、`h()` 函数组件、`<script setup>` 里用复杂表达式声明的 props、以及「名字不同但业务上重复」的语义重复。
- **ui 的 props 重合只是线索**。相似度 ≥ `propOverlap` 只记为 `warn`，因为它无法区分「复制了一份」和「同一类表单的两个变体」。默认 `minProps: 2` 用来压掉简单组件的误报。
- **ui 的 `index.*` 不参与重名与重复检测**。`index.vue` / `index.tsx` 这类入口文件名天然重复，按父目录名命名、并且不参与重复块检测。
- **metrics 的重复检测是 token n-gram**。换行、调换语句顺序、加注释都会让它认为「不重复」；它也无法识别「逻辑相同但写法不同」。开启 `duplication.normalizeIdentifiers` 可抗「复制改名」（标识符按首现顺序归一化），但结构相似的不同逻辑也会命中。这是为了零依赖和可解释性付出的代价。
- **metrics 的函数长度按花括号配对估算**。箭头函数简写、返回对象字面量、模板字符串里的花括号可能让边界算偏；`any` 计数只统计显式写法（`: any`、`as any`、`<any>`、`any[]`），隐式推断出的 `any` 不计。
- **diff-size 只看增删行数和文件数**。把一个 500 行文件整体重写、只新增 20 行，它不会报；纯删除也不会报。它拦的是「改动面」而不是「改动风险」，默认阈值 20 文件 / 600 行是经验值，需要按团队评审能力调。
- **它抓不到「该不该复用」**。两个组件名字不同、props 拆得不一样，但业务上就是重复的，需要人判断。工具只能把「同名」「高重合」「同能力用了两个库」这些确定性的信号变成失败或告警。
- **boundaries 已在真实 Vue 仓库（Repo A）实测**（depcruise 18.8.0：19 条循环、抽样 0 误报、<1s）；仍未覆盖 React/TSX 仓库与 monorepo 多包边界。Vue 仓库需 depcruise 能解析 `@vue/compiler-sfc`，否则适配器报 `boundaries/not-executed`（不会假通过）。
- **`init` 的探测只看前置文件是否存在**（tsconfig、ESLint 配置、dependency-cruiser 配置、`.vue` 文件、workspaces），不判断这些配置本身是否可用。已存在的配置不会被重新探测，除非加 `--force`——init 之后删掉 tsconfig，检查仍保持启用并会明确报错，而不是静默通过。
- **SARIF 只含新增违规与 `not-executed`**。存量留在 baseline 里、不上传，因此 Code Scanning 告警页展示的就是 CLI 会失败的那一组；boundaries 没有行号，只能是文件级告警。
- **被 ESLint 配置排除的文件不会被检查，也不产生违规**。改动文件命中 `ignores`（或没有匹配的 flat config 块）时，ESLint 只给提示，fe-guard 会丢弃它——这个文件属于 lint 范围之外，和非源文件扩展名同理。想检查就去掉对应 ignore 规则；fe-guard 不会用 `--no-ignore` 覆盖你的 ESLint 配置。
- **baseline 趋势只看已提交的历史**。未入库的 baseline、浅克隆、squash 合并都会让趋势截断；它是只读视图，从不影响门禁。放宽次数只算显式 `--widen`（首次入账与重命名迁移不算），指标只统计键数量、不求和——每文件最大值没有有意义的“总量”。
- **`task events --summary` 是单任务、事件推导的**。只覆盖当前任务文件，拒绝原因最多列 5 条，而且只能报告被记录下来的事实——AI 绕过工具直接改文件时，摘要同样看不出来。
- **ui 默认排除 story 与测试文件**。`*.stories.*`、`*.story.*`、`*.test.*`、`*.spec.*` 以及 `__tests__` / `__mocks__` / `e2e` 目录不算组件，否则重复的 `Default` story 会淹没重名检查。真实组件请按正常命名放置。
- **整包被 ESLint 排除时记为跳过，而不是失败**。根 flat config 忽略 workspace 包的全部文件时，ESLint 不 lint 任何文件并退出 2；fe-guard 在耗时里把该包记为 `skipped`。它不是“通过”——需要 lint 就去掉对应的 ignore 规则。
- **monorepo 跨包边界只覆盖相对路径引用**。`checks.boundaries.workspace: "auto"` 会再跑一遍 dependency-cruiser，拦截 workspace 包之间 `../../packages/ui/src/x` 这类引用；通过包名（`@scope/ui`，包括直接进内部目录）、根包代码、以及被你的 depcruise 配置整体排除的包都不在判定范围内。启用仍需要 `.dependency-cruiser.{cjs,js,json}`——`init` 不猜 dependency-cruiser 是否安装。
- **HTML 报告是单次快照，不是趋势**。它逐条列出所有违规（新增 / 存量 / `not-executed`），大仓库会得到较大的文件，也不会自动裁剪；输出位置跟随 `report.path`，`.gitignore` 不会被动——不想提交就自己忽略 `.fe-guard/`。

## baseline 与执行模式的限制

- **`--staged` 只有内容检查读暂存内容**。ESLint / deps / ui / metrics 在 `git checkout-index` 导出的影子目录上执行；TypeScript、boundaries、diff-size 仍读工作区（`tsc` / `vue-tsc` 难以可靠指向影子目录），报告里的 `staged` 字段和 stdout 的 `--staged:` 行会明确列出哪边是哪边。
- **影子目录只导出项目根下的跟踪文件**。`git ls-files -- .` 列清单后 `git checkout-index --stdin` 导出；项目根是 git 根的子目录时，检查在「影子目录 + 子目录偏移」上进行。清单超出输出上限会拒绝导出不完整快照，不会静默扫空。`node_modules` 不导出，只软链根目录与各 workspace package 的那份；ESLint 配置依赖未提交的本地文件时可能报「找不到插件」——这类失败会带包名失败，不会静默通过。
- **`baseline --verify` 必须有可确定的基线**。优先级：`--base` > `GITHUB_BASE_SHA` / `GITHUB_BASE_REF` > 本地 upstream；都没有时退出码 2。shallow clone 需要先 fetch 目标分支，否则 merge-base 算不出来，同样退出码 2。
- **跳过仍然不失败**。没有 ESLint 配置的 package、没有源文件的 diff 会记录 `skipped` 并在报告里可见，但退出码仍是 0；这是「缺配置」与「配了但坏了」的区别，前者不该阻断提交。
- **超时是单进程 120s**。可用 `checks.eslint.timeoutMs` / `checks.typescript.timeoutMs` / `checks.boundaries.timeoutMs` 调整；超时后先 SIGTERM、2s 后 SIGKILL，产出不可入账的 `<check>/not-executed`。stdout 累积上限 8MB，超出会标记 `truncated`，JSON 解析失败时按执行失败处理。
- **全局 `enabled:false` 仍是显式紧急止血**。它会退出码 0 并写报告 `skipped: true`；但它也能让门禁变绿，所以只应作为临时手段。0 个启用项（没有全局关闭，但 `checks.*` 全关或整段缺失）会退出码 2。
- **没有 HEAD 的仓库全档 `diff-size` 会失败**。新仓库在第一次 commit 之前，`check --full` 会报 `diff-size/not-executed`（退出码 1），因为它确实算不出本次改动规模；先完成一次初始提交，或临时关闭 `checks.diff-size`。
- **`<check>/not-executed` 不可入账**。缺工具、超时、git 不可用、子进程崩溃都会产出它，`baseline` 永远不会吸收；但它不会阻止有人直接改 `enabled:false`——这需要评审兜底。
- **package 模式暂不支持 `--follow-renames`**。重命名可能同时改变文件归属（文件从一个 package 移到另一个），必须先确认账本拆分正确；需要迁移重命名时回到 root 模式，或用 `--show` 核对后人工搬条目。
- **`--migrate-packages` 的冲突不会自动合并**。目标 package 账本里已有同 key 不同值时，命令退出 2 且不写任何文件，必须人工判断哪一份是对的。
- **根账本 stale 会直接报错**。package 模式下根账本里仍有 package 文件条目时，`check` / `baseline` 退出 2 并提示 `--migrate-packages`。这是有意的：静默丢掉这些条目等于把历史欠债悄悄解冻。
- **package 归属按最长前缀判断**。把文件移到另一个 package 会被视为「旧条目删除 + 新条目新增」；`--follow-renames` 只在 root 模式提供，跨包移动需要人工迁移账本。
- **`--verify` 不能判断账本是否覆盖了所有文件**。它只检查每本账是否仍存在、有没有被放宽；漏记的文件会在 `check` 里变成新增违规。
- **`packageFile` 放在包内**。如果指向被 gitignore 的目录（如 `.fe-guard/`），账本不会提交，CI 看到的是一本空账——请放在被跟踪的目录。
- **根账本仍管理根文件**。根包代码与仓库级脚本不会进入 package 账本，即使每个 workspace package 都有自己的账本。

## monorepo 与 Vue 的限制

- **monorepo 的识别是约定式的**。目前认 `package.json` 的 `workspaces`（数组或 `{ packages }`）、`pnpm-workspace.yaml` 的 `packages:`、`lerna.json`；只展开 `apps/*`、`packages/**` 这类 glob，跳过 `!` 开头的排除项。不认 `rush.json`、Nx 的 `project.json`、Bazel 等自定义拓扑——这些仓库会退回单仓库模式。
- **monorepo 下 deps / ui / metrics / boundaries 仍是根级一次**。baseline 账本现在可以按 package 拆（`baseline.strategy: "package"`），但这些检查仍把默认扫描根 `src` 展开到各 package、整仓库一套配置，只是账本文件拆开。metrics 可用 `overrides` 按目录前缀给各包不同阈值，deps / ui 仍整仓库一套配置。
- **monorepo 的 ESLint 耗时由项目自己的配置决定**。Repo B 的 5 个 package 并行仍要约 26s，因为两个 app 开了 type-aware 规则、扫 18 万行；fe-guard 的编排开销只有约 3s，不是瓶颈。
- **没有 ESLint 配置的 package 会被跳过**，报告里会列出跳过名单（`--diff-only` / `--staged` 也会记录 `skipped`，不会整类静默消失）；包里有配置却执行失败时会带包名失败。
- **没有 tsconfig 的 package 在 monorepo 下跳过**；如果根目录也没有 tsconfig 可跑，单仓库模式仍会报「找不到 tsconfig」。
- **vue-tsc 的版本兼容是有限的**。已验证的组合：Vue 3 + TS 5 用 vue-tsc 2.x 或 3.x，Vue 2.7 / 旧 TS 用 vue-tsc 1.8。**TypeScript 7 目前不被任何 vue-tsc 版本支持**——TS 7（Go 原生编译器）不再导出 `typescript/lib/tsc`，而所有 vue-tsc 启动时都要解析它，因此检查会直接给出明确报错而不是崩溃。`vue-tsc 2.x + TS 4.x`、`Vue 2 + vue-tsc 2.x`、`Vue + TS 7` 都会直接报错；更老的组合（Vue 2.6 及以下）建议显式设 `typescript.vue: false`。项目里 `.vue` 存在但 vue-tsc 未安装时，会失败并报 `typescript/vue-tsc-missing`，该条永远不进 baseline。非 Vue 项目可以直接使用 TypeScript 7——tsc 的诊断格式没有变化。
- **显式写 `checks.typescript.bin` 会关闭 Vue 自动切换**。`init` 不再写 `bin`，Vue 项目自动选 `vue-tsc`；如果你自己写了 `"bin": "tsc"`，fe-guard 会尊重该配置，但会提示 `.vue` 不会被类型检查，实际只检查 tsconfig 覆盖的非 SFC 文件。
- **vue-tsc 的检查范围等于项目自己的 tsconfig**。`include` 没覆盖到的 `.vue` 不会被检查；monorepo 下每个 package 用各自的 `tsconfig.json`。

## 本地执行与流程层的限制

- **没有强制，只有默认路径**。`git commit --no-verify` 能绕过钩子；没有 CI 就没有第二道门。工具能做的是让默认路径足够快、足够可见，不能替团队做纪律。
- **fast 档不会改写项目自己的 ESLint 配置**。它只保证不跑 tsc / vue-tsc / boundaries / diff-size；如果项目 ESLint 配置本身启用了 type-aware 规则，fast 仍会变慢。先看 `doctor` 的上次耗时，再决定是否把最贵的规则留给全档。
- **doctor 的耗时是“上次报告里的耗时”**，不是现场测量。没跑过 `check` 时显示“耗时未知”；它不会为了报数字去执行全档。
- **档位只影响 `check`**。`baseline` 始终按配置里的完整启用项记录，避免用 fast 档生成一份缺少 tsc/边界条目的账本。
- **tarball 路线要求目标机器能执行 npm**。内网完全离线时，需要把 tgz 和项目的 `node_modules` 一起带走，或搭建一个只读的本地 registry；fe-guard 本身零运行时依赖，但安装动作仍由 npm 完成。
- **单人维护多仓库的升级成本在“逐个仓库验证”**，不在发版。建议先在一个仓库用满两周，再复制配置到第二个仓库。
- **`workflow` 只约束“经由工具”的操作**。AI 完全可以不调 MCP、直接改文件，此时流程不会知道；它拦的是「在流程内声称完成」。真正不可绕过的兜底仍然是本地的 `fe-guard check --full` 和 Husky 的 `--staged --profile fast`。
- **验收条件可选语义绑定**：挂 `testFile` 的条件由门禁真跑测试，enforce 下通过才覆盖；未挂测试的条件仍只由「条件写下之后通过的门禁证据」覆盖，不能保证「这次通过证明了这条条件」。测试命令来自配置，模型只给路径。
- **`type` / `source` 由模型声明**。工具只校验字段存在、`type` 在枚举内，不校验出处是否真实、类型是否准确。漏掉一整类条件（比如埋点）时，合同仍可能显示「全绿」。
- **`confirm` / `defer` 是人工决策标记，不是身份认证**。它们只提供 CLI，MCP 工具列表里没有，但能执行 shell 的 AI 理论上也能运行。评审与 shell 权限仍是兜底。
- **手工证据的 sha256 只证明存在与完整性**。它证明文件在门禁之后存在且未被改动，不证明截图或记录内容正确；视觉判断仍需人或外部工具。
- **预检只执行项目配置的命令**。它不知道 dev server、代理、登录态或测试数据；命令写错或超时都按「未执行」处理，不会当成通过。
- **trend 指纹上限 100，boundaries 没有行号**。按规则 + 文件 + 行比较；语义等价或挪动代码可能被看成 `fixed` / `introduced`。
- **distill 的证据是自由文本，不做机器验证**。`enforce` 会阻止交付直到有复盘，但复盘质量取决于写的人；觉得碍事可切 `warn` / `off`。
- **`task stats` 只读当前任务与归档**。损坏归档会跳过并计数；删除归档不会被追溯审计。
- **`completion` 只反映验收条件**。计划步骤与实际代码改动的双向对账尚未自动化。
- **`task_criteria` 是 BREAKING**。旧 MCP 调用必须补 `type` / `source`；历史 `task.json` 事件缺字段仍可回放，显示为 `unknown`。
- **`implement` / `deliver` 没有降级开关**。它们是事件推导出来的位置，不是判定点，所以配置里只暴露 `contract` / `plan` / `verify` 三个阶段。
- **hooks 只是示例文件**，不会自动生效；事件名需要按你所用 IDE 版本对齐。两家 IDE 都没有 git pre-commit 事件。
- **任务状态是单仓库、单任务的**：一次只有一个进行中的任务，交付后自动归档到 `.fe-guard/tasks/`，没有跨仓库汇总，也没有并发任务队列。
- **AGENTS.md 片段是给模型看的“非标准约定”**，token 上限 600（实测约 591）。它不替代工具里的判定——即使模型完全无视这段话，工具仍然会拒绝非法操作。

## 明确没做（不要期待）

- AI 代码评审 / 自动打分、Web 界面 / 看板 / 指标趋势。
- YAML 规范编译器、规则集市 / 插件市场、多产物分发。
- 跨仓库升级机器人、跨仓库任务队列 / 分布式执行、多角色权限与 owner 制。
- 语义级「这个组件该不该复用」判断、AST 级分析、自动修复（autofix）。
- 跨仓库依赖治理（组织级「唯一库白名单」下发）、性能预算 / 产物体积检查。
- workspace 拓扑的通用解析器（不解析 Rush / Nx / Turborepo 的自定义项目图）。
- 误报的自动降级、baseline 的 Web 可视化评审。
- monorepo 的跨包依赖图分析（那是 `boundaries` 的职责，且仍需 dependency-cruiser）。

这些如果要做，应该建立在「检查 + 流程」已经稳定运行、baseline 账本被团队真正使用之后。
