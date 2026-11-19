# 贡献 fe-guard

[English](./CONTRIBUTING.md) · **简体中文**

感谢你的兴趣！fe-guard 是一个小工具，设计目标是让一个人也能长期维护。欢迎贡献——请先读下面的哲学，因为它决定了我们接受什么。

## 开发 setup

- Node 18+
- `npm install`
- `npm run verify:local` —— 完整门禁：单测 + v1–v4 真实子进程验证 + self-check

每个改动都必须让 `npm run verify:local` 保持全绿。验证脚本会真实拉起 ESLint / tsc / dependency-cruiser / MCP 进程——**不 mock**。请不要为了让改动通过而削弱它们。

## 哲学（我们优化什么）

- **零运行时依赖。** 唯一的外部工具是被编排的那些（ESLint、tsc、dependency-cruiser）。不要加运行时依赖。
- **不做提前抽象。** 没有插件接口、事件总线、任务队列。七个 runner 各写各的；少量重复换来可读性。
- **范围纪律。** 只做被要求的事。新检查项对旧配置默认关闭。
- **诚实工程。** 没真正执行的检查必须失败（`not-executed`），绝不静默通过。跳过 ≠ 通过。
- **真实验证。** 构造场景、跑真实命令、记录输出。

## 加一个检查项

1. 在 `src/runners/<name>.js` 加 runner，产出归一化的违规结构。
2. 在 `src/config.js` 接默认值，在 `src/runners/index.js` 接编排。
3. 在 `test/` 加单测 + 端到端用例，并加一个 `verify-v*.mjs` 场景。
4. 在 `docs/checks.md` 和 `docs/zh/checks.md` 补文档。
5. 文件保持在 ~500 行内（工具会用这条门禁自己）。

## Pull request

- 一个 PR 只做一个聚焦的改动；描述*为什么*，而不只是*做了什么*。
- 附验证证据（命令 + 输出）。
- 行为变化时同步更新英文和中文文档。
- 不要在没说明原因的情况下提交 `fe-guard.baseline.json` 的放宽。

## 报告 issue

使用 issue 模板。附上 `npx fe-guard --version`、Node 版本、OS、配置，以及相关的 `.fe-guard/report.json`（MCP 问题加 `FE_GUARD_DEBUG=1` 运行）。

## 许可证

贡献即表示你同意你的贡献以 MIT 许可证授权。
