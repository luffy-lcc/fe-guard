# 路线图

[← 返回 README](../../README.zh-CN.md) · [English](../roadmap.md)

fe-guard 只做一件事：让「不准更差」自动执行。这一页记录已经交付的能力、正在准备的内容，以及明确不做的方向。

## 已完成

- **0.1.x** — 检查层（七项检查）、baseline 棘轮、MCP 流程、fast / full 档位、`doctor`、monorepo 与 Vue 支持、`not-executed`。
- **0.2.0** — `init` 项目探测、预设（`js` / `vue` / `legacy` / `monorepo`）、`--dry-run`、五个客户端的项目级 MCP 配置。
- **0.3.0** — SARIF 输出、单文件 HTML 报告、`baseline --trend`、`task events --summary`。
- **0.4.0（已完成）** — React/TSX 实机验证与 4 个真实问题修复；monorepo 跨包边界；结构化验收条件、`task confirm` / `task defer`、手工证据与门禁快照、环境预检、返工对比、`task_lesson` + `workflow.distill`、只读 `task stats`。

## 0.5.0（已完成）

主题：**按 package 管理存量欠债**，让 monorepo 的 baseline 不再互相混淆。

交付内容：

- `baseline.strategy: "root" | "package"` 与 `baseline.packageFile`；root 仍是默认，现有行为不变。
- 根级文件（`package.json`、`scripts/`、仓库级配置）留在 `baseline.path`；每个 workspace package 写到 `<package>/<packageFile>`；归属按最长 package 前缀判断。
- `baseline --migrate-packages [--dry-run]`：按归属拆分已有根账本，保留 `firstSeen`，记录 `initial-adoption` / `migrate-packages`；有冲突时退出 2 且不写文件。
- `baseline --show` / `--verify` / `--trend --package <name|rel>`；删除 package 账本会被 `--verify` 拦住，而不是静默解冻欠债。
- `doctor` 输出 `baseline.strategy`，并逐本列出路径、文件数 / 条数 / 指标数与最近 git 变更时间。
- `check` 报告增加 `strategy` 与 `ledgers`；写回时输出「N 本 package 账本」。
- 测试：`npm test` 184 全过；`verify-v4.mjs` 69 项断言（v1 37 / v2 135 / v3 83 不变）。

0.5.0 不包含：package 模式下的 `--follow-renames`、迁移冲突自动合并；deps / ui / metrics / boundaries 的检查执行仍是根级一次（其中 metrics 的指标账本会按文件归属进入 package 账本）。

## 0.6.0（已完成，当前发布版）

主题：**验证环境与视觉证据的外部集成**。

已实现：

1. `workflow.preflight` 支持多步命名检查 `steps[]`，与单 `command` 二选一；顺序执行、失败即停，错误指出具体步骤。
2. 验收条件增加 `evidenceKind`（`screenshot` / `diff` / `log`）；manual 缺省按扩展名推断，gate 只接受 `diff`。
3. `workflow.visualDiff.command`：只执行项目提供的命令，stdout / 退出码 / 哈希进入证据，不引入运行时依赖。
4. 视觉条件只被 `visualDiff.ok` 覆盖；命令缺失、超时、非零退出都不算通过。
5. 中英文文档与 `verify-v4` 场景同步。

验收结果：

- 现有单命令预检继续可用；`steps[]` 失败时能指出是哪一步。
- `evidenceKind` 已记录并在 `task status` / `task status --json` 中可读，且不新增运行时依赖。
- `visualDiff.command` 不启动浏览器、不安装依赖；命令缺失按「未执行」处理，绝不当作通过。
- 测试：`npm test` 191 全过；`verify-v4.mjs` 80 项断言（v1 37 / v2 135 / v3 83 / v4 80）。

不包含：内置浏览器自动化、像素对比实现、移动端真机、按条件映射多个视觉命令。

维护与发布：0.5.x 只接收回归修复；0.6.0 已发布；npm 发布等有明确外部使用需求后再评估。

## 后续候选

| 候选 | 为什么 | 触发条件 |
| --- | --- | --- |
| 视觉比稿 / 浏览器预检的进一步细化 | 0.6.0 先做外部命令集成；内置自动化与像素对比需要专人负责 | 某仓库有稳定的视觉基线，且团队不满足于只跑外部命令 |
| 规范分发 / 子代理编排 | 大任务需要按子代理裁剪说明 | 多代理使用足够普遍，值得单独做 |
| 测试页 / 移动端真机 | 组件与交互检查仍靠人工 | 团队明确提出；依赖外部工具 |
| 跨仓库聚合看板 | `task stats` 只覆盖单仓库 | 多个仓库稳定使用满一个季度 |

## 明确不做

- 自动修复 / 自动整改。
- 语义级「这个组件该不该复用」判断。
- workspace 拓扑的通用解析器（Rush / Nx / Turborepo）。
- 多角色权限 / owner 制。
- 跨仓库任务队列或分布式执行。

这些要等「检查 + 流程」稳定运行、baseline 账本被真正使用之后再考虑。
