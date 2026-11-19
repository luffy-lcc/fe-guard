/**
 * IDE 接入产物的唯一事实源。
 * AGENTS.md 片段、Trae 规则、Trae 命令、Cursor 规则、hooks 示例全部从这里渲染，
 * 避免同一套约定在多份文件里各自演化（漂移）。
 *
 * 只写"模型靠常识猜不到的非标准约定"：流程必须走哪些工具、什么情况会被拦住、
 * 本仓库 baseline 的特殊语义。通用的代码风格不在这里重复。
 */

export const AGENTS_BEGIN = '<!-- fe-guard:begin -->'
export const AGENTS_END = '<!-- fe-guard:end -->'

/** 主流程：agi 必须按顺序调用的 4 个工具。 */
export const FLOW_STEPS = [
  { tool: 'task_start', text: '写标题、目标、明确不做什么。' },
  { tool: 'task_criteria', text: '至少 1 条可验证的验收条件；能写成测试的条件挂 testFile。' },
  { tool: 'task_plan', text: '1-15 步实现计划（写入后合同锁定）。' },
  { tool: 'task_gate', text: '改完代码后跑真实门禁。' },
]

/** 查询类工具：随时可调，不改变阶段。 */
export const QUERY_TOOLS = [
  { tool: 'task_next', text: '当前阶段、下一个该调用的工具、阻塞项' },
  { tool: 'task_status', text: '任务、验收条件达成情况、门禁证据摘要' },
  { tool: 'ui_lookup', text: '写组件前查已有组件的 props/emits/路径（按需返回，不进上下文）' },
]

/** 代码里判定的硬规则，不是提示词建议。 */
export const HARD_RULES = [
  '没有"把阶段标记为通过"的工具：阶段由事件推导，条件达成由门禁证据推导。',
  '门禁未通过，或验收条件在门禁之后没有证据，任务不会进入交付态。',
  '挂 testFile 的条件必须门禁真跑测试且通过才覆盖；测试命令来自配置，模型只给路径。',
  'baseline 记「文件+规则 → 允许条数」和「文件+指标 → 允许最大值」，只收紧不放宽；同文件"修一条旧违规 + 加一条别的规则"仍会失败。',
  '写组件前先 `ui_lookup`；与已有组件同名或 props 高度重合会被拦。',
  '新增依赖必须在 `checks.deps.registry` 登记用途；日期/请求等能力只允许一个库。',
  'metrics 只拦"比 baseline 更差"：文件行数、长函数、重复块、any 数量。',
  '大 diff 不进 baseline：超过配置的文件数/行数每次都失败，需要拆 PR。',
  '要关掉或降级检查，改 `fe-guard.config.json` 的 `enabled` / `level`，不要在代码里绕过。',
]

const numbered = (steps) => steps.map((step, index) => `${index + 1}. \`${step.tool}\`：${step.text}`).join('\n')
const bulleted = (items) => items.map((item) => `- ${item}`).join('\n')
const queries = () => QUERY_TOOLS.map((item) => `- \`${item.tool}\`：${item.text}`).join('\n')

/** AGENTS.md 里的受管片段：跨工具唯一交集，token 预算最小。 */
export function agentsBlock() {
  return `${AGENTS_BEGIN}
## fe-guard 工作流（必须调用工具推进）

流程状态在 \`.fe-guard/task.json\`，由 fe-guard MCP server 的工具推进。接到开发任务时按顺序调用：

${numbered(FLOW_STEPS)}

迷路时调 \`task_next\`，看证据调 \`task_status\`。以下约束在代码里判定，不是建议：

${bulleted(HARD_RULES)}

提交前 \`npx fe-guard check --staged --profile fast\` 退出码必须为 0。
${AGENTS_END}`
}

/** 规则正文：Trae 规则与 Cursor 规则共用，保证两边内容一致。 */
function ruleBody() {
  return `# fe-guard 工作流

本仓库的开发流程由 fe-guard MCP server 推进，状态在 \`.fe-guard/task.json\`。
它只追加事件，当前阶段由事件推导，所以可审计、可回放，也没法"直接改状态"。
**流程不是提示词，而是工具**：不调用工具就没有阶段可推进。

## 接到开发任务时的顺序

${numbered(FLOW_STEPS)}

## 查询类工具（随时可用）

${queries()}

## 什么情况会被拦住（判定在代码里）

${bulleted(HARD_RULES)}

## 提交前

- \`npx fe-guard check --staged --profile fast\` 退出码必须为 0（Husky 的 pre-commit 也走这条）。
- 报告在 \`.fe-guard/report.json\`；退出码 0 通过 / 1 新增违规 / 2 配置或环境错误。

## 卡住时

- \`npx fe-guard task status\` 看任务与条件达成情况；\`npx fe-guard task events\` 看事件流。
- \`npx fe-guard task reset --yes\` 归档当前任务并重来。
- 想彻底退回纯检查模式：把 \`fe-guard.config.json\` 里的 \`workflow.enabled\` 设为 \`false\`。
`
}

export function traeRule() {
  return ruleBody()
}

export function cursorRule() {
  return `---
description: fe-guard 开发流程：阶段与验收条件由 MCP 工具和门禁证据推进
globs:
alwaysApply: true
---

${ruleBody()}`
}

export function traeCommandNext() {
  return `---
description: 查看 fe-guard 当前阶段与下一步该做什么
---

调用 fe-guard MCP 的 \`task_next\` 工具，按返回的 \`nextTool\` 执行下一步，不要跳过工具直接改代码。
如果 \`stage\` 是 \`none\`，先调用 \`task_start\` 写清目标，再用 \`task_criteria\` 写验收条件。
`
}

export function traeCommandGate() {
  return `---
description: 跑 fe-guard 真实门禁并处理结果
---

调用 fe-guard MCP 的 \`task_gate\` 工具。未通过时按返回的 \`blockers\` 修代码后重跑。
不要为了让门禁通过去改 \`fe-guard.baseline.json\`、关闭检查或删验收条件。
`
}

/** hooks 示例：只做提示，不自动生效；两家 IDE 的事件名以各自版本文档为准。 */
export function hooksExample(ide) {
  const events =
    ide === 'trae'
      ? [
          { event: 'afterToolCall', command: 'npx fe-guard check --diff-only --profile fast' },
          { event: 'sessionEnd', command: 'npx fe-guard check --staged --profile fast' },
        ]
      : [
          { event: 'afterFileEdit', command: 'npx fe-guard check --diff-only --profile fast' },
          { event: 'stop', command: 'npx fe-guard check --staged --profile fast' },
        ]
  return `${JSON.stringify(
    {
      _readme: [
        '示例，不会被自动加载：把 hooks 里的命令搬到 IDE 的 hooks 设置后才会生效。',
        '事件名以你所用 IDE 版本为准；Trae 有 6 类事件，这里只用到「工具调用后」和「会话结束」。',
        '两家 IDE 都没有 git pre-commit 事件，提交前拦截请用 Husky（examples/husky-pre-commit）。',
      ],
      hooks: events.map((item) => ({ ...item, timeoutMs: 120000 })),
    },
    null,
    2,
  )}\n`
}
