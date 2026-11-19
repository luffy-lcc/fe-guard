import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { UserError, writeTextFile } from '../utils.js'

export const MCP_SERVER_NAME = 'fe-guard'

/**
 * 幂等写入：内容相同就不动文件。
 * 返回 created / updated / unchanged，init 据此打印"生成"还是"已是最新"。
 */
export function writeManagedFile(root, relative, content) {
  const file = path.join(root, relative)
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (current === content) return { file: relative, status: 'unchanged' }
  writeTextFile(file, content)
  return { file: relative, status: current === null ? 'created' : 'updated' }
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
 * 合并而不是覆盖：用户可能已经挂了别的 MCP server。
 * 只接管 mcpServers["fe-guard"] 这一项。
 */
export function mergeMcpConfig(root, relative, entry = mcpServerEntry(root)) {
  const file = path.join(root, relative)
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  let parsed = {}
  if (current !== null) {
    try {
      parsed = JSON.parse(current) ?? {}
    } catch {
      throw new UserError(`${relative} 不是合法 JSON，无法合并 fe-guard 的 MCP 配置。请先修好它，或手动添加 mcpServers.${MCP_SERVER_NAME}。`)
    }
  }
  const next = {
    ...parsed,
    mcpServers: { ...(parsed.mcpServers ?? {}), [MCP_SERVER_NAME]: entry },
  }
  const text = `${JSON.stringify(next, null, 2)}\n`
  if (current === text) return { file: relative, status: 'unchanged' }
  writeTextFile(file, text)
  return { file: relative, status: current === null ? 'created' : 'updated' }
}
