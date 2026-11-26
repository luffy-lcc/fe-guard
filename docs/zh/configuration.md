# 配置参考

[← 返回 README](../../README.zh-CN.md) · [English](../configuration.md)

配置用 JSON 而不是 YAML：零依赖（不用自己写 YAML 子集解析器）、编辑器自带校验和补全、不会因为缩进写错产生玄学问题。`fe-guard.config.json` 全部字段：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "profile": "full",
  "checks": {
    "eslint": {
      "enabled": true,
      "level": "error",
      "bin": "eslint",
      "args": ["--format", "json"],
      "targets": [],
      "workspace": "auto",
      "extensions": [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue"]
    },
    "typescript": {
      "enabled": true,
      "level": "error",
      "args": ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
      "vue": "auto",
      "workspace": "auto"
    },
    "boundaries": {
      "enabled": true,
      "level": "error",
      "bin": "depcruise",
      "args": ["src", "--output-type", "json", "--config", ".dependency-cruiser.cjs"],
      "workspace": "off"
    },
    "deps": {
      "enabled": true,
      "level": "error",
      "roots": ["src"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
      "internalPrefixes": ["@/", "~/", "src/"],
      "capabilities": {
        "date": {
          "allow": ["dayjs"],
          "block": ["moment", "date-fns", "luxon"],
          "exempt": ["src/utils/date.ts"],
          "useInstead": "src/utils/date.ts",
          "example": "import dayjs from 'dayjs';\ndayjs(ts).format('YYYY-MM-DD')"
        }
      },
      "registry": {}
    },
    "ui": {
      "enabled": true,
      "level": "error",
      "roots": ["src"],
      "extensions": [".vue", ".tsx", ".jsx"],
      "inventory": ".fe-guard/ui-inventory.json",
      "propOverlap": 0.8,
      "minProps": 2
    },
    "metrics": {
      "enabled": true,
      "level": "error",
      "roots": ["src"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
      "maxFileLines": 500,
      "maxFunctionLines": 100,
      "maxAny": 20,
      "overrides": {
        "apps/legacy": { "maxFileLines": 800, "maxFunctionLines": 150, "maxAny": 50, "duplication": { "maxRatio": 0.6 } }
      },
      "duplication": {
        "windowTokens": 50,
        "minTokens": 200,
        "maxRatio": 0.5,
        "normalizeIdentifiers": false,
        "ignore": ["**/locales/**", "**/i18n/**", "**/lang/**"]
      }
    },
    "diff-size": {
      "enabled": true,
      "level": "error",
      "maxFiles": 20,
      "maxLines": 600,
      "ignore": ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "*.min.js", "dist/**", ".fe-guard/**", "fe-guard.baseline.json"]
    }
  },
  "baseline": {
    "path": "fe-guard.baseline.json",
    "strategy": "root",
    "packageFile": "fe-guard.baseline.json",
    "autoTighten": true
  },
  "report": { "path": ".fe-guard/report.json" },
  "feedback": { "path": ".fe-guard/false-positives.jsonl" },
  "diff": { "base": "HEAD" },
  "workflow": {
    "enabled": true,
    "gate": { "mode": "full", "testCommand": "node --test", "testTimeoutMs": 120000 },
    "stages": { "contract": "enforce", "plan": "enforce", "verify": "enforce" },
    "preflight": { "command": "", "timeoutMs": 60000 },
    "visualDiff": { "command": "", "timeoutMs": 120000 },
    "distill": "enforce"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 配置 schema 版本。比当前工具新时退出码 2，并提示升级工具，不会静默忽略新字段 |
| `profile` | 默认档位：`full`（默认）或 `fast`。命令行 `--profile` / `--full` 可临时覆盖 |
| `enabled` | 全局总开关。`false` 时 `check` 直接通过（退出码 0，报告标记 `skipped`），用于紧急止血 |
| `checks.<name>.enabled` | 单项开关，缺省视为关闭。旧配置里没有 `deps` / `ui` / `metrics` / `diff-size`，升级后它们默认关闭，不会突然全红。`init` 会先探测项目，对缺前置条件的检查直接写 `false`（没有 tsconfig → `typescript`，没有 ESLint 配置 → `eslint`，没有 `.dependency-cruiser.{cjs,js,json}` → `boundaries`）；前置条件补齐后把开关改回即可 |
| `checks.boundaries.workspace` | `off`（默认）或 `auto`。monorepo 下 `auto` 会再跑一遍 dependency-cruiser，拦截**相对路径跨 package 的引用**（`boundaries/workspace-cross-package`）；你自己的 `.dependency-cruiser.cjs` 不会被改动，包名入口引用放行。`init` 在检测到 workspace + depcruise 配置时写入 `auto` |
| `checks.<name>.level` | `error` 或 `warn`。`warn` 时该项的新增违规只报告、不阻断 |
| `checks.<name>.bin` / `args` | 实际执行的命令。默认优先用项目内 `node_modules/.bin` 下的同名命令，找不到才走 PATH（仅外部三项）。`typescript` 的 `bin` **留空**即可自动选择（Vue 项目 → `vue-tsc`，否则 `tsc`）；显式写 `"bin": "tsc"` 会关闭 Vue 自动切换，`.vue` 将不被类型检查 |
| `checks.eslint.targets` | 全量检查时 ESLint 扫哪些目录。空数组 = 自动：有 `src/` 只扫 `src/`，否则扫仓库根，避免把 `dist/`、`docker/static` 一起 lint |
| `checks.eslint.workspace` | `auto`（默认）时识别 monorepo 并按 package 各用自己的配置执行；`root` 退回「只在仓库根跑一次」 |
| `checks.typescript.vue` | `auto`（默认）检测到 Vue 就切 `vue-tsc`，`.vue` 里的类型错误会被检查；`false` 明确接受只跑 `tsc` |
| `checks.typescript.workspace` | `auto`（默认）时按 package 各自的 tsconfig 执行；`root` 退回根目录一次 |
| `checks.*.timeoutMs` | 子进程超时（毫秒，默认 120000）。ESLint / tsc / vue-tsc / depcruise 卡死时先 SIGTERM，2s 后 SIGKILL，产出不可入账的 `<check>/not-executed` |
| `checks.eslint.extensions` | 只影响 diff-only 时传给 ESLint 的文件筛选，以及「本次有没有需要检查的文件」的判断 |
| `checks.deps.roots` / `extensions` | 扫描哪些目录、哪些后缀里的 import；`.d.ts` 不参与（生成的声明文件常 import 虚拟包） |
| `checks.deps.internalPrefixes` | 视为项目内引用的前缀，不当作第三方包 |
| `checks.deps.capabilities` | 「能力 → 唯一库」映射。`allow` 是正确库，`block` 是禁止库，`exempt` 是允许直接 import 的封装层（如 `src/utils/date.ts`），`useInstead` 是替代文件，`example` 会原样出现在报错里。默认只给 `date`，`http` 需按仓库实际情况显式配置 |
| `checks.deps.registry` | 新增依赖的用途登记：`{ "包名": "用在哪、为什么不能用已有实现" }`。没登记的运行时依赖会让 `deps/unregistered` 失败 |
| `checks.ui.inventory` | 组件清单落盘路径（建议加进 `.gitignore`，它每次检查都会重建） |
| `checks.ui.propOverlap` | props 重合度阈值（Jaccard，0–1），达到就告警 |
| `checks.ui.minProps` | 两边 props 都至少有这么多才比较，避免简单组件误报 |
| `checks.metrics.maxFileLines` | 单文件行数上限（默认 500；存量大型仓库建议 800） |
| `checks.metrics.maxFunctionLines` | 最长函数行数上限（默认 100；存量仓库建议 150） |
| `checks.metrics.maxAny` | 单文件显式 `any` 数量上限（默认 20） |
| `checks.metrics.overrides` | 按目录前缀覆盖阈值（最长前缀匹配）：`{ "apps/legacy": { "maxFileLines": 800, "duplication": { "maxRatio": 0.6 } } }`。与 workspace 识别解耦，monorepo 各包 / 单仓库遗留区都可用；只允许四个阈值字段 |
| `checks.metrics.duplication` | 跨文件重复块检测：窗口 token 数、最短块、允许的最大占比、跳过路径（默认跳过 locales/i18n，词条天然同构） |
| `checks.metrics.duplication.normalizeIdentifiers` | 默认 `false`。开启后非关键字标识符按首现顺序归一化，「复制改名」的重复也能命中；代价是结构相似但语义不同的代码会命中，误报走 false-positive 记录 |
| `checks.diff-size.maxFiles` / `maxLines` | 本次改动的文件数 / 新增行数上限，超过即失败 |
| `checks.diff-size.ignore` | 大 diff 统计时忽略的路径（lock 文件、构建产物、`.fe-guard/`、baseline 本身） |
| `baseline.strategy` | `root`（默认）保持全仓库一本账，旧配置行为不变；`package` 让每个 workspace package 各有一本账。`package` 要求能识别出 workspace（`workspaces` / `pnpm-workspace.yaml` / `lerna.json`），单仓库必须保持 `root` |
| `baseline.packageFile` | package 模式下每个 package 的账本文件名，相对**该 package 目录**（默认 `fe-guard.baseline.json`，即 `apps/web/fe-guard.baseline.json`）。禁止绝对路径与 `..`；请放在被跟踪的目录里——放在 gitignore 路径下账本不会提交 |
| `baseline.autoTighten` | 默认 `true`：`check` 通过时把修掉的存量写回 baseline（条数和数值两本账都会收紧）。只读环境设为 `false` |
| `feedback.path` | 误报记录（JSONL）的落盘路径。只追加、可审计，不会被 `check` 读取成忽略名单 |
| `report.path` | 报告文件路径 |
| `diff.base` | `--diff-only` 与大 diff 统计的比较基准，可改成 `origin/main` 之类 |
| `workflow.preflight` | `{ command, timeoutMs }` 或 `{ steps, timeoutMs }` 环境预检。`command` 与 `steps` 二选一；为空（默认）= 关闭。多步按顺序执行、失败即停，错误指出具体步骤；失败会让 `task_start` 不创建任务、`task_gate` 报「本次检查未执行」——不产证据、条件不被覆盖 |
| `workflow.visualDiff` | `{ command, timeoutMs }` 外部视觉对比命令。`command` 为空（默认）= 关闭；只执行项目自己的命令，不启动浏览器。门禁遇到 `evidenceKind: "diff"` 的条件时才执行，失败/缺失/超时都不会覆盖条件（图示见[推广页](promotion.md)） |
| `workflow.distill` | `enforce`（默认）/ `warn` / `off`。`enforce` 时最近一次失败门禁之后必须记录 `task_lesson` 才能交付；`warn` 允许交付但标记 `degraded`；`off` 关闭要求 |
| `workflow.*` | 流程层开关，见[流程层开关](workflow.md#开关) |

验收条件的字段（`type` / `source` / `verify` / `testFile` / `evidenceFile` / `evidenceKind`）属于任务合同，不在这份配置里；见[验收条件](workflow.md#验收条件类型出处验收方式)。

`args` 里不要写目标文件/目录（例如 ESLint 的 `.`）：fe-guard 会在末尾自动追加全量目标或变更文件列表。

**紧急关闭**：只改配置文件，不要在代码里加 `eslint-disable` 或跳过钩子。

- 全关：`"enabled": false`
- 降级为警告：`"checks": { "eslint": { "level": "warn" } }`
- 只关某一项：`"checks": { "boundaries": { "enabled": false } }`

## monorepo 与 Vue 项目

`check` 会读取 `package.json` 的 `workspaces`、`pnpm-workspace.yaml`、`lerna.json`，展开 `apps/*`、`packages/**` 这类声明，然后：

- **ESLint、TypeScript 按 package 分别执行**，每个包用自己目录里的配置（ESLint 找不到本地配置时向上继承到仓库根；连根配置都没有的包直接跳过，不会报错）。
- **deps / ui / metrics / boundaries 这些根级检查只执行一次**，但会把默认的扫描根 `src` 自动展开成各子包的源码目录。
- 多包**并行**执行；报告里带每个包的耗时，stdout 会打印各检查项总耗时。
- 某个包有配置但执行失败（如 ESLint 配置本身抛错）会**直接失败并指出包名**，不会静默算通过。

**baseline 也可以按 package 记账。** 配置 `"baseline": { "strategy": "package", "packageFile": "fe-guard.baseline.json" }`（package 模式依赖上面的 workspace 识别）。根级文件仍用 `baseline.path`，每个 package 下的文件写到 `<package>/<packageFile>`。老仓库先跑一次 `npx fe-guard baseline --migrate-packages` 拆分根账本，提交后再跑 `npx fe-guard check`。`baseline --show` / `--verify` / `--trend` 支持 `--package <name|rel>`。root 模式仍是默认。详见 [monorepo：package 级账本](baseline.md)。

想退回“只在仓库根跑一次”：

```json
{ "checks": { "eslint": { "workspace": "root" }, "typescript": { "workspace": "root" } } }
```

Vue 项目检测到 `.vue` 文件或依赖里有 `vue` 时，TypeScript 检查自动改为 `vue-tsc --noEmit`，`<script setup>` 和 `<template>` 里的类型错误都会被检查。关键安全底线：**项目里有 `.vue`，但 vue-tsc 没装/不可执行时，检查会失败**，并报一条永远不能进 baseline 的 `typescript/vue-tsc-missing`。

- Vue 3 + TS 5：`npm i -D vue-tsc typescript`（vue-tsc 2.x 或 3.x）
- Vue 2.7 / 旧 TS：`npm i -D vue-tsc@1.8`
- **TypeScript 7 目前不被任何 vue-tsc 版本支持**（TS 7 不再导出 `typescript/lib/tsc`），Vue 项目需停留在 `typescript@5`
- 版本不匹配（vue-tsc 2.x + TS 4.x、Vue 2 + vue-tsc 2.x、Vue + TS 7）会直接报错，而不是跑出一个假结果
- 明确接受“不检查 `.vue`”：`"checks": { "typescript": { "vue": false } }`

**架构边界（boundaries）与 Vue**：depcruise 需要能从它自己的安装位置解析到 `@vue/compiler-sfc`（Vue 2 用 `vue-template-compiler`）才会把 `.vue` 纳入依赖图。缺失时它不报错、只是静默跳过 `.vue`——fe-guard 会对比磁盘与入图的 `.vue` 数量，不完整即报 `boundaries/not-executed`，不会给一个假 0。depcruise 18 起 tsconfig 别名写法是 `options.tsConfig: { fileName: 'tsconfig.json' }`（旧版 `tsConfigFile` 已废弃，非法配置会被 schema 校验拒绝）。

**项目根 ≠ git 根（前后端同仓）**：fe-guard 可以用 `--root frontend` 挂在子目录上，v6.2 起全部 git 依赖功能路径语义正确：`--staged` 快照只导出子目录下的跟踪文件并自动偏移；`diff-size` / `--diff-only` 只统计子目录内改动；重命名迁移与 `--verify` 读 HEAD 账本用 cwd 相对路径。钩子放在 git 根的 `.git/hooks/pre-commit`，`cd` 到子目录后跑 `check --staged --profile fast` 即可。
