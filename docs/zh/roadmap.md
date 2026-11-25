# 路线图

[← 返回 README](../../README.zh-CN.md) · [English](../roadmap.md)

fe-guard 只做一件事：让「不准更差」自动执行。这一页记录已经交付的能力、正在准备的内容，以及明确不做的方向。

## 已完成

- **0.1.x** — 检查层（七项检查）、baseline 棘轮、MCP 流程、fast / full 档位、`doctor`、monorepo 与 Vue 支持、`not-executed`。
- **0.2.0** — `init` 项目探测、预设（`js` / `vue` / `legacy` / `monorepo`）、`--dry-run`、五个客户端的项目级 MCP 配置。
- **0.3.0** — SARIF 输出、单文件 HTML 报告、`baseline --trend`、`task events --summary`。
- **0.4.0** — React/TSX 实机验证与 4 个真实问题修复；monorepo 跨包边界；结构化验收条件、`task confirm` / `task defer`、手工证据与门禁快照、环境预检、返工对比、`task_lesson` + `workflow.distill`、只读 `task stats`。

## 后续候选

| 候选 | 为什么 | 触发条件 |
| --- | --- | --- |
| 视觉比稿 / 截图 diff | 手工证据只证明文件存在，不证明 UI 与设计稿一致 | 某仓库有稳定的视觉基线，且有人能负责评审 |
| 浏览器 / dev server / 登录态预检 | 现在的预检只跑命令；多数 UI 验证需要可用的应用 | 同一类环境失败在多个任务里反复出现 |
| 规范分发 / 子代理编排 | 大任务需要按子代理裁剪说明 | 多代理使用足够普遍，值得单独做 |
| 测试页 / 移动端真机 | 组件与交互检查仍靠人工 | 团队明确提出；依赖外部工具 |
| 跨仓库聚合看板 | `task stats` 只覆盖单仓库 | 多个仓库稳定使用满一个季度 |
| per-package baseline | monorepo 账本是整仓库一份 | 某个包需要独立的欠债预算 |

## 明确不做

- 自动修复 / 自动整改。
- 语义级「这个组件该不该复用」判断。
- workspace 拓扑的通用解析器（Rush / Nx / Turborepo）。
- 多角色权限 / owner 制。
- 跨仓库任务队列或分布式执行。

这些要等「检查 + 流程」稳定运行、baseline 账本被真正使用之后再考虑。
