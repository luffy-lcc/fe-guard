import { CRITERION_TYPES, VERIFY_MODES } from './criteria.js'

/**
 * MCP 工具定义。schema 是流程的第一道硬约束：
 * 模型无法传入 achieved / stage 之类的自报字段。
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'task_start',
    description: '开始一个任务并写入需求合同（目标、不做的事、约束）。任何开发任务的第一步；已有进行中的任务会被拒绝。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '一句话说明这次要做什么' },
        goal: { type: 'string', description: '完成标准的目标描述' },
        outOfScope: { type: 'string', description: '明确不做什么，防止范围膨胀' },
        constraints: { type: 'string', description: '技术或业务约束' },
      },
      required: ['title', 'goal'],
    },
  },
  {
    name: 'task_criteria',
    description: '在 contract 阶段写入验收条件（每条必须有 type/source）。条件是否达成由门禁证据推导，不接受模型自报 status/achieved。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        criteria: {
          type: 'array',
          description: '验收条件列表，至少 1 条，最多 20 条',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '可选，缺省自动编号 C1、C2…' },
              text: { type: 'string', description: '可被验证的一句话' },
              type: {
                type: 'string',
                enum: CRITERION_TYPES,
                description: '条件类型：ui / interaction / data / tracking / compat / performance',
              },
              source: {
                type: 'string',
                description: '出处：需求、设计稿、代码或既有行为；无法确认的写 assumption: 原因',
              },
              verify: {
                type: 'string',
                enum: VERIFY_MODES,
                description: '可选，验收方式；缺省按 testFile→test、evidenceFile→manual、否则 gate 推断',
              },
              testFile: { type: 'string', description: '可选：仓库内测试文件相对路径，门禁会真跑它，通过才覆盖该条件' },
              evidenceFile: {
                type: 'string',
                description: '可选：仓库内手工证据文件相对路径（截图说明、对账记录），门禁校验存在且非空',
              },
            },
            required: ['text', 'type', 'source'],
          },
        },
      },
      required: ['criteria'],
    },
  },
  {
    name: 'task_plan',
    description: '写入实现计划（步骤列表）。写入后合同锁定，阶段进入 implement；之后修改条件需要新任务。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          description: '实现步骤，1-15 条，每条一句话',
          items: { type: 'string' },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'task_next',
    description: '查询当前阶段、阻塞项和下一步该调用的工具。不确定下一步时先调用它。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'task_gate',
    description: '执行真实门禁检查（复用 fe-guard check），把结果写入证据。只有通过且验收条件都有证据才会进入 deliver。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'task_status',
    description: '查询任务、验收条件达成情况与门禁证据摘要。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'task_lesson',
    description: '复盘一次失败门禁：记录结论、证据与落地范围。失败后不写复盘不能交付。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '验证过的结论：发生了什么、为什么、以后怎么避免' },
        evidence: { type: 'string', description: '结论依据：门禁记录、日志、文件路径或复现步骤' },
        scope: {
          type: 'string',
          enum: ['skill', 'rule', 'none'],
          description: '落地范围：skill / rule / none（只记录，不自动生成）',
        },
        scopeReason: { type: 'string', description: 'scope=none 时必填：为什么这次结论不落地' },
      },
      required: ['text', 'evidence', 'scope'],
    },
  },
  {
    name: 'ui_lookup',
    description: '按名称或关键词查已有组件的 props、emits 和文件路径。写新组件前先查，避免重造已有组件。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '组件名或关键词；省略时返回清单前 5 个' },
      },
    },
  },
]

export function listTools(config) {
  if (config?.workflow?.enabled === false) {
    // 流程层关闭时只保留门禁，退回 v1 的纯检查能力。
    return TOOL_DEFINITIONS.filter((tool) => tool.name === 'task_gate')
  }
  return TOOL_DEFINITIONS
}
