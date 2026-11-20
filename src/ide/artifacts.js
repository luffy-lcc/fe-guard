import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { UserError } from '../utils.js'

export const MCP_SERVER_NAME = 'fe-guard'

/**
 * 支持的项目级 MCP 客户端。只写项目内文件，不碰用户 home；
 * 各家 schema 的差异只在 serversKey 与条目字段上，合并逻辑共用。
 * 排除项：Windsurf / Codex CLI（只有用户级配置）、Cline / Roo（扩展 UI）、
 * Continue（YAML）、Zed（context_servers 结构未确认）、JetBrains（无标准位置）。
 */
export const MCP_CLIENTS = [
  { id: 'trae', file: '.trae/mcp.json', serversKey: 'mcpServers' },
  { id: 'cursor', file: '.cursor/mcp.json', serversKey: 'mcpServers' },
  { id: 'claude-code', file: '.mcp.json', serversKey: 'mcpServers' },
  // VS Code 的 mcp.json 用 servers 键，并要求显式声明 stdio 传输。
  { id: 'vscode', file: '.vscode/mcp.json', serversKey: 'servers', extra: { type: 'stdio' } },
  { id: 'gemini-cli', file: '.gemini/settings.json', serversKey: 'mcpServers' },
]

/**
 * 只计算“要不要写、写成什么”，不落盘；init --dry-run 直接用它做预览。
 * 返回 created / updated / unchanged。
 */
export function planManagedFile(root, relative, content) {
  const file = path.join(root, relative)
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  const status = current === content ? 'unchanged' : current === null ? 'created' : 'updated'
  return { file: relative, status, content }
}

/** 替换 marker 之间的受管片段；没有 marker 时追加到文件末尾。 */
export function replaceMarkedBlock(text, begin, end, block) {
  const start = text.indexOf(begin)
  const finish = text.indexOf(end)
  if (start !== -1 && finish > start) {
    return normalize(`${text.slice(0, start)}${block}${text.slice(finish + end.length)}`)
  }
  const head = text.trim().length === 0 ? '' : `${text.replace(/\s*$/, '')}\n\n`
  return normalize(`${head}${block}`)
}

function normalize(text) {
  return `${text.replace(/\s*$/, '')}\n`
}

/**
 * MCP 挂载配置。优先用被检查项目里安装的 fe-guard（相对路径，跨机器可用）；
 * 如果项目没有本地安装（比如直接用本仓库的 CLI），退化成当前这份安装的绝对路径。
 */
export function mcpServerEntry(root) {
  const local = path.join(root, 'node_modules', 'fe-guard', 'bin', 'fe-guard-mcp.js')
  const script = existsSync(local)
    ? './node_modules/fe-guard/bin/fe-guard-mcp.js'
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/fe-guard-mcp.js')
  return { command: 'node', args: [script] }
}

/**
 * 合并而不是覆盖：用户可能已经挂了别的 MCP server，或在该文件里写了别的设置。
 * 只接管 serversKey 下的 "fe-guard" 一项。
 */
export function planMcpConfig(root, client, entry = mcpServerEntry(root)) {
  const { file: relative, serversKey, extra = {} } = client
  const file = path.join(root, relative)
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  let parsed = {}
  if (current !== null) {
    try {
      parsed = JSON.parse(current) ?? {}
    } catch {
      throw new UserError(`${relative} 不是合法 JSON，无法合并 fe-guard 的 MCP 配置。请先修好它，或手动添加 ${serversKey}.${MCP_SERVER_NAME}。`)
    }
  }
  const existing = parsed[serversKey] ?? {}
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    throw new UserError(`${relative} 里的 ${serversKey} 不是对象，无法安全合并 fe-guard 的 MCP 配置。请先修正该字段。`)
  }
  const next = {
    ...parsed,
    [serversKey]: { ...existing, [MCP_SERVER_NAME]: { ...entry, ...extra } },
  }
  return planManagedFile(root, relative, `${JSON.stringify(next, null, 2)}\n`)
}
