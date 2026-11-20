import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 0.2.x A1：项目级多客户端 MCP 接入（Trae / Cursor / Claude Code / VS Code / Gemini CLI）。
 * 约束：幂等合并、不覆盖其它 server 与其它设置键、只写项目内文件、--dry-run 可预览。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const tempDirs = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fe-guard-clients-${name}-`))
  tempDirs.push(dir)
  return dir
}

function writeJson(app, file, value) {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true })
  writeFileSync(path.join(app, file), `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(app, file) {
  return JSON.parse(readFileSync(path.join(app, file), 'utf8'))
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function makeApp(name) {
  const app = tempDir(name)
  writeJson(app, 'package.json', { name, private: true })
  return app
}

test('init 生成 5 个项目级 MCP 配置，VS Code 使用 servers + stdio', () => {
  const app = makeApp('all-clients')
  const init = cli(app, ['init'])
  assert.equal(init.code, 0, init.out)

  for (const file of ['.trae/mcp.json', '.cursor/mcp.json', '.mcp.json', '.vscode/mcp.json', '.gemini/settings.json']) {
    assert.equal(existsSync(path.join(app, file)), true, `缺少 ${file}`)
  }

  for (const file of ['.trae/mcp.json', '.cursor/mcp.json', '.mcp.json', '.gemini/settings.json']) {
    const entry = readJson(app, file).mcpServers['fe-guard']
    assert.equal(entry.command, 'node', `${file} 的 command 应为 node`)
    assert.ok(entry.args.some((arg) => arg.includes('fe-guard-mcp.js')), `${file} 应指向 fe-guard-mcp.js`)
    assert.equal(entry.type, undefined, `${file} 不应带 VS Code 的 type 字段`)
  }

  const vscode = readJson(app, '.vscode/mcp.json')
  assert.equal(vscode.servers['fe-guard'].type, 'stdio')
  assert.equal(vscode.servers['fe-guard'].command, 'node')
  assert.ok(vscode.servers['fe-guard'].args.some((arg) => arg.includes('fe-guard-mcp.js')))
  assert.equal(vscode.mcpServers, undefined, 'VS Code 不应写错成 mcpServers')
})

test('合并不覆盖：保留其它 server 与文件里的其它设置键', () => {
  const app = makeApp('merge')
  writeJson(app, '.mcp.json', { mcpServers: { other: { command: 'other-bin' } }, custom: true })
  writeJson(app, '.vscode/mcp.json', { servers: { other: { type: 'stdio', command: 'other' } }, inputs: [] })
  writeJson(app, '.gemini/settings.json', { theme: 'dark', mcpServers: { other: { command: 'other' } } })

  assert.equal(cli(app, ['init']).code, 0)

  const claude = readJson(app, '.mcp.json')
  assert.equal(claude.custom, true, '未知顶层键应保留')
  assert.equal(claude.mcpServers.other.command, 'other-bin')

  const vscode = readJson(app, '.vscode/mcp.json')
  assert.deepEqual(vscode.inputs, [])
  assert.equal(vscode.servers.other.command, 'other')
  assert.equal(vscode.servers['fe-guard'].type, 'stdio')

  const gemini = readJson(app, '.gemini/settings.json')
  assert.equal(gemini.theme, 'dark', 'Gemini CLI 的其它设置应保留')
  assert.equal(gemini.mcpServers.other.command, 'other')
})

test('重复 init 幂等：5 个配置文件内容不变', () => {
  const app = makeApp('idempotent')
  assert.equal(cli(app, ['init']).code, 0)
  const files = ['.trae/mcp.json', '.cursor/mcp.json', '.mcp.json', '.vscode/mcp.json', '.gemini/settings.json']
  const before = files.map((file) => readFileSync(path.join(app, file), 'utf8'))

  const second = cli(app, ['init'])
  assert.equal(second.code, 0, second.out)
  const after = files.map((file) => readFileSync(path.join(app, file), 'utf8'))
  assert.deepEqual(after, before)
  assert.match(second.out, /已是最新/)
})

test('--dry-run 预览新客户端文件，且一个都不写', () => {
  const app = makeApp('dry-run')
  const preview = cli(app, ['init', '--dry-run'])
  assert.equal(preview.code, 0, preview.out)
  assert.match(preview.out, /--- \.mcp\.json \(created\) ---/)
  assert.match(preview.out, /--- \.vscode\/mcp\.json \(created\) ---/)
  assert.match(preview.out, /--- \.gemini\/settings\.json \(created\) ---/)
  for (const file of ['.mcp.json', '.vscode/mcp.json', '.gemini/settings.json']) {
    assert.equal(existsSync(path.join(app, file)), false, `--dry-run 不应写 ${file}`)
  }
})

test('非法 JSON 或 servers 字段类型错误：退出码 2，且原文件不被覆盖', () => {
  const bad = makeApp('bad-json')
  writeFileSync(path.join(bad, '.mcp.json'), '{ not json')
  const broken = cli(bad, ['init'])
  assert.equal(broken.code, 2)
  assert.match(broken.out, /\.mcp\.json 不是合法 JSON/)
  assert.equal(readFileSync(path.join(bad, '.mcp.json'), 'utf8'), '{ not json')

  const wrongShape = makeApp('bad-shape')
  writeJson(wrongShape, '.vscode/mcp.json', { servers: [] })
  const rejected = cli(wrongShape, ['init'])
  assert.equal(rejected.code, 2)
  assert.match(rejected.out, /servers 不是对象/)
  assert.deepEqual(readJson(wrongShape, '.vscode/mcp.json'), { servers: [] })
})

test('只写项目内文件：不创建用户 home 下的配置', () => {
  const app = makeApp('no-home')
  assert.equal(cli(app, ['init']).code, 0)
  // init 只按 root 拼路径；这里用绝对路径校验没有越界写入。
  assert.equal(existsSync(path.join(app, '.mcp.json')), true)
  assert.equal(existsSync(path.join(path.dirname(app), '.mcp.json')), false)
})
