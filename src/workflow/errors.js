/**
 * 流程工具的可预期错误（参数或状态不满足）。
 * MCP 层会把它原样回显给模型，并记录一次「被拒绝的调用」用于审计。
 * 单独成文件是为了让拆分后的 gate.js / tools.js 共用同一个错误类型，避免循环依赖。
 */
export class ToolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolError'
  }
}
