import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { ToolError, callTool, listTools, recordRejection } from '../workflow/tools.js'
import { loadConfig } from '../config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const INSTRUCTIONS = 'fe-guard 流程：不确定下一步时先调 task_next；阶段与验收条件由门禁证据推导，不能自行标记完成。'

/**
 * 极简 MCP stdio server（零依赖，换行分隔的 JSON-RPC 2.0）。
 * 只实现 tools 能力；stdout 只用于协议消息，日志一律走 stderr。
 */
export async function startMcpServer({ root }) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const log = (...args) => {
    if (process.env.FE_GUARD_DEBUG) console.error('[fe-guard-mcp]', ...args)
  }
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
  const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  async function handleLine(line) {
    const text = line.trim()
    if (!text) return

    let request
    try {
      request = JSON.parse(text)
    } catch {
      failure(null, -32700, 'JSON 解析失败')
      return
    }

    const { id, method, params } = request ?? {}
    const isNotification = id === undefined || id === null

    try {
      if (method === 'initialize') {
        result(id, {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fe-guard', version: VERSION },
          instructions: INSTRUCTIONS,
        })
        return
      }
      if (typeof method === 'string' && method.startsWith('notifications/')) return
      if (method === 'ping') {
        result(id, {})
        return
      }
      if (method === 'tools/list') {
        let config = null
        try {
          config = loadConfig(root)
        } catch {
          // 配置缺失时仍列出全部工具，具体错误在调用时给出。
        }
        result(id, { tools: listTools(config) })
        return
      }
      if (method === 'resources/list') {
        result(id, { resources: [] })
        return
      }
      if (method === 'resources/templates/list') {
        result(id, { resourceTemplates: [] })
        return
      }
      if (method === 'prompts/list') {
        result(id, { prompts: [] })
        return
      }
      if (method === 'tools/call') {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (typeof name !== 'string') {
          failure(id, -32602, 'tools/call 需要 name')
          return
        }
        try {
          const value = await callTool({ root, name, args })
          result(id, { content: [{ type: 'text', text: JSON.stringify(value) }] })
        } catch (error) {
          const message = error instanceof ToolError ? error.message : `执行失败：${error.message}`
          recordRejection(root, name, message)
          log(error.stack)
          result(id, { content: [{ type: 'text', text: message }], isError: true })
        }
        return
      }
      if (isNotification) return
      failure(id, -32601, `不支持的方法：${method}`)
    } catch (error) {
      log(error.stack)
      if (!isNotification) failure(id, -32603, `内部错误：${error.message}`)
    }
  }

  rl.on('line', (line) => {
    // 串行处理，避免并发写 task.json 造成事件交错。
    queue = queue.then(() => handleLine(line))
  })

  await new Promise((resolve) => rl.on('close', resolve))
}
