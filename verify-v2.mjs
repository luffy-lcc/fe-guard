#!/usr/bin/env node
/**
 * fe-guard v2 一键验证。
 *
 * 与 verify.sh（v1，验证 CLI 检查与 baseline 棘轮）互补：这里用真实的 MCP 协议
 * （stdio + 换行分隔 JSON-RPC）驱动一次完整开发会话，并断言"绕过流程"的几条路径确实被拦住。
 *
 * 用法: node verify-v2.mjs      （或 npm run verify:v2 / npm run verify:all）
 * 退出码: 0 = 全部通过，1 = 有失败项
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS_BEGIN, AGENTS_END, agentsBlock } from './src/ide/source.js'
import { AGENTS_TOKEN_LIMIT, estimateTokens } from './src/ide/tokens.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const MCP_BIN = path.join(ROOT, 'bin', 'fe-guard-mcp.js')
const SAMPLE = path.join(ROOT, 'examples', 'sample-app')
const WORK = path.join(ROOT, '.verify-v2-tmp')

let pass = 0
let fail = 0

const line = (text) => console.log(text)
const step = (title) => line(`\n== ${title} ==`)
const indent = (text) => String(text).split('\n').map((item) => `        ${item}`).join('\n')

function check(desc, condition, detail) {
  if (condition) {
    pass += 1
    line(`  PASS  ${desc}`)
  } else {
    fail += 1
    line(`  FAIL  ${desc}`)
    if (detail !== undefined && detail !== null && String(detail).length > 0) line(indent(detail))
  }
}

// ------------------------------------------------------------------ 工程与 CLI

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${result.stderr}`)
  return result.stdout
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

function makeApp(name) {
  const app = path.join(WORK, name)
  rmSync(app, { recursive: true, force: true })
  mkdirSync(app, { recursive: true })
  cpSync(SAMPLE, app, {
    recursive: true,
    filter: (src) => !['node_modules', '.fe-guard', '.git'].includes(path.basename(src)),
  })
  symlinkSync(path.join(SAMPLE, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'verify@fe-guard.local'])
  git(app, ['config', 'user.name', 'fe-guard verify'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'sample app: initial'])
  return app
}

/** 生成物幂等性靠"文件内容哈希前后一致"来判断。 */
function snapshot(app) {
  const entries = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(item.name)) continue
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 12)
      entries.push(`${path.relative(app, full)}:${hash}`)
    }
  }
  walk(app)
  return entries.sort().join('\n')
}

const configFileOf = (app) => path.join(app, 'fe-guard.config.json')
const baselineFileOf = (app) => path.join(app, 'fe-guard.baseline.json')

function patchConfig(app, mutate) {
  const file = configFileOf(app)
  const config = readJson(file)
  mutate(config)
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}

function baselineKeyCount(app) {
  const entries = readJson(baselineFileOf(app)).entries
  return Object.values(entries).reduce((sum, rules) => sum + Object.keys(rules).length, 0)
}

// ------------------------------------------------------------------ MCP 客户端

class Mcp {
  constructor(root) {
    this.child = spawn(process.execPath, [MCP_BIN, '--root', root], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buffer = ''
    this.pending = new Map()
    this.seq = 0
    this.maxBytes = 0
    this.stderr = ''
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      this.drain()
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8')
    })
    this.child.on('exit', (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP 进程退出（code=${code}）`))
      this.pending.clear()
    })
  }

  drain() {
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const text = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!text) continue
      let message
      try {
        message = JSON.parse(text)
      } catch {
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      pending.resolve(message)
    }
  }

  request(method, params = {}) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} 超时`))
      }, 180000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async call(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args })
    const text = response.result?.content?.map((item) => item.text).join('') ?? ''
    this.maxBytes = Math.max(this.maxBytes, Buffer.byteLength(text, 'utf8'))
    let value = null
    try {
      value = JSON.parse(text)
    } catch {
      value = null
    }
    return { isError: Boolean(response.result?.isError), text, value }
  }

  close() {
    this.child.stdin.end()
    this.child.kill()
  }
}

async function handshake(mcp) {
  return mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fe-guard-verify', version: '1' },
  })
}

const taskFileOf = (app) => path.join(app, '.fe-guard', 'task.json')

// ------------------------------------------------------------------ 场景 1：完整会话

async function happyPath() {
  step('1. 完整会话：用真实 MCP 协议把一次新需求从头走到交付')
  const app = makeApp('happy')
  check('init 成功', cli(app, ['init']).code === 0)
  const baseline = cli(app, ['baseline'])
  check('存量违规入账（复用 v1 baseline）', baseline.code === 0, baseline.out)

  const mcp = new Mcp(app)
  try {
    const init = await handshake(mcp)
    check('initialize 回显协议版本', init.result?.protocolVersion === '2024-11-05', JSON.stringify(init))
    check('initialize 声明 tools 能力', Boolean(init.result?.capabilities?.tools), JSON.stringify(init.result?.capabilities))

    const list = await mcp.request('tools/list', {})
    const tools = list.result?.tools ?? []
    const names = tools.map((tool) => tool.name)
    // v3 新增了 ui_lookup（组件清单按需查询），工具上限从 6 放宽到 8。
    check(`工具数量 ≤ 8（实际 ${names.length}）`, names.length <= 8, names.join(', '))
    check(
      '覆盖 合同/条件/计划/下一步/门禁/状态',
      ['task_start', 'task_criteria', 'task_plan', 'task_next', 'task_gate', 'task_status'].every((name) =>
        names.includes(name),
      ),
      names.join(', '),
    )
    check(
      '每个工具描述 ≤ 90 字（短描述，控制上下文占用）',
      tools.every((tool) => tool.description.length <= 90),
      tools.map((tool) => `${tool.name}=${tool.description.length}`).join(' '),
    )

    const idle = await mcp.call('task_next')
    check('未开始时 task_next 指向 task_start', idle.value?.nextTool === 'task_start', idle.text)

    const started = await mcp.call('task_start', {
      title: '新增时长格式化工具',
      goal: '新增 formatDuration(ms)，并保证 fe-guard 全量检查通过',
      outOfScope: '不改动现有页面与接口',
      constraints: '只用 TypeScript，不新增依赖',
    })
    check('task_start 返回 taskId', started.value?.ok === true && /^T-/.test(started.value.taskId), started.text)

    const criteria = await mcp.call('task_criteria', {
      criteria: [{ text: 'formatDuration(1000) 返回 "1s"' }, { text: 'fe-guard 全量检查通过' }],
    })
    check('验收条件自动编号 C1/C2', JSON.stringify(criteria.value?.ids) === '["C1","C2"]', criteria.text)
    check('写条件后阶段为 plan', criteria.value?.stage === 'plan', criteria.text)

    const plan = await mcp.call('task_plan', {
      steps: ['新增 src/features/duration.ts', '实现 formatDuration', '跑门禁'],
    })
    check('写计划后进入 implement', plan.value?.stage === 'implement', plan.text)

    const nextAtImplement = await mcp.call('task_next')
    check('task_next 在 implement 阶段指向 task_gate', nextAtImplement.value?.nextTool === 'task_gate', nextAtImplement.text)

    mkdirSync(path.join(app, 'src/features'), { recursive: true })
    writeFileSync(
      path.join(app, 'src/features/duration.ts'),
      'export function formatDuration(ms: number): string {\n  const seconds = ms / 1000\n  return `${seconds}s`\n}\n',
    )

    const gate = await mcp.call('task_gate')
    check('门禁真实执行并通过', gate.value?.ok === true && gate.value?.exitCode === 0, gate.text)
    check('通过后直接进入 deliver（不需要模型声明）', gate.value?.stage === 'deliver', gate.text)
    check(
      '2/2 验收条件被门禁证据覆盖',
      gate.value?.criteria?.total === 2 && gate.value?.criteria?.achieved === 2,
      gate.text,
    )

    const status = await mcp.call('task_status')
    check(
      'task_status 显示 delivered，且每条条件都有 evidence id',
      status.value?.task?.stage === 'deliver' &&
        status.value?.task?.status === 'delivered' &&
        status.value.criteria.every((item) => item.achievedBy),
      status.text,
    )

    check(`单次工具返回都在 token 预算内（最大 ${mcp.maxBytes} 字节）`, mcp.maxBytes < 1600, `maxBytes=${mcp.maxBytes}`)

    const task = readJson(taskFileOf(app))
    check(
      '状态文件只存事件流（seq/type），没有可直接改写的 stage 字段',
      Array.isArray(task.events) &&
        task.events.length >= 5 &&
        task.events.every((event) => typeof event.seq === 'number' && !('stage' in event)) &&
        !('stage' in task),
      JSON.stringify(task).slice(0, 300),
    )
    const types = task.events.map((event) => event.type)
    check(
      '事件顺序为 合同→条件→计划→门禁→交付',
      JSON.stringify(types) === JSON.stringify(['task.started', 'criteria.declared', 'plan.written', 'gate.recorded', 'task.delivered']),
      types.join(' → '),
    )

    const report = readJson(path.join(app, '.fe-guard/report.json'))
    check('门禁结果写进了 v1 的报告文件（同一套检查内核）', report.ok === true && report.summary.new === 0, JSON.stringify(report.summary))

    const cliStatus = cli(app, ['task', 'status'])
    check('命令行可以审计同一份状态', cliStatus.code === 0 && cliStatus.out.includes('deliver'), cliStatus.out)
  } finally {
    mcp.close()
  }
}

// ------------------------------------------------------------------ 场景 2：反例

async function rejections() {
  step('2. 反例：跳过合同、自报达成、门禁未过想推进、非法跳转')
  const app = makeApp('rejections')
  check('init 成功', cli(app, ['init']).code === 0)
  check('存量违规入账', cli(app, ['baseline']).code === 0)

  const mcp = new Mcp(app)
  try {
    await handshake(mcp)

    const planFirst = await mcp.call('task_plan', { steps: ['跳过合同直接写实现'] })
    check('无任务时 task_plan 被拒绝（不能跳过合同）', planFirst.isError && /task_start/.test(planFirst.text), planFirst.text)

    const gateFirst = await mcp.call('task_gate')
    check('无任务时 task_gate 被拒绝', gateFirst.isError && /task_start/.test(gateFirst.text), gateFirst.text)

    const criteriaFirst = await mcp.call('task_criteria', { criteria: [{ text: 'x' }] })
    check('无任务时 task_criteria 被拒绝', criteriaFirst.isError && /task_start/.test(criteriaFirst.text), criteriaFirst.text)

    await mcp.call('task_start', { title: '反例验证', goal: '确认流程不能被绕过' })

    const planNoCriteria = await mcp.call('task_plan', { steps: ['跳过验收条件'] })
    check('没有验收条件时 task_plan 被拒绝', planNoCriteria.isError && /验收条件/.test(planNoCriteria.text), planNoCriteria.text)

    const gateNoPlan = await mcp.call('task_gate')
    check('没有计划时 task_gate 被拒绝', gateNoPlan.isError && /计划/.test(gateNoPlan.text), gateNoPlan.text)

    const selfReport = await mcp.call('task_criteria', { criteria: [{ text: '看起来已经做完了', achieved: true }] })
    check(
      '验收条件带 achieved 字段被拒绝（不能自报达成）',
      selfReport.isError && /不能自行标记/.test(selfReport.text),
      selfReport.text,
    )

    const forceStatus = await mcp.call('task_status', { status: 'delivered' })
    check('task_status 不接受 status 参数', forceStatus.isError, forceStatus.text)

    const criteriaOk = await mcp.call('task_criteria', { criteria: [{ text: 'fe-guard 全量检查通过' }] })
    check('合法条件可以写入', criteriaOk.value?.ok === true, criteriaOk.text)

    const restart = await mcp.call('task_start', { title: '再来一个', goal: '绕过当前任务' })
    check('进行中的任务不能被再次 task_start', restart.isError && /已有进行中的任务/.test(restart.text), restart.text)

    const unknown = await mcp.call('task_deliver', {})
    check('不存在"直接交付"的工具', unknown.isError && /未知工具/.test(unknown.text), unknown.text)

    await mcp.call('task_plan', { steps: ['实现'] })
    const planAgain = await mcp.call('task_plan', { steps: ['重复写计划'] })
    check('计划不能重复写入（阶段不能靠重复调用推进）', planAgain.isError, planAgain.text)

    writeFileSync(
      path.join(app, 'src/utils/bad.ts'),
      'export function bad(): any {\n  const unused = 1\n  return 1\n}\n',
    )
    const gateFail = await mcp.call('task_gate')
    check('门禁未通过时 ok=false', gateFail.value?.ok === false, gateFail.text)
    check('门禁未通过时停在 verify', gateFail.value?.stage === 'verify', gateFail.text)
    check('门禁未通过时条件达成数为 0', gateFail.value?.criteria?.achieved === 0, gateFail.text)
    check('返回的 blockers 指到具体文件与规则', Array.isArray(gateFail.value?.blockers) && gateFail.value.blockers.length > 0, gateFail.text)

    const statusAfterFail = await mcp.call('task_status')
    check(
      '任务没有被标成交付，也没有对应事件',
      statusAfterFail.value?.task?.status === 'active' && statusAfterFail.value?.task?.stage === 'verify',
      statusAfterFail.text,
    )
    check('失败门禁被记为 ok=false 的证据', statusAfterFail.value?.evidence?.at(-1)?.ok === false, statusAfterFail.text)

    const nextAfterFail = await mcp.call('task_next')
    check('task_next 给出阻塞原因', (nextAfterFail.value?.blockers ?? []).length > 0, nextAfterFail.text)

    rmSync(path.join(app, 'src/utils/bad.ts'))
    const gateOk = await mcp.call('task_gate')
    check('修复后重跑门禁通过并交付', gateOk.value?.ok === true && gateOk.value?.stage === 'deliver', gateOk.text)

    const task = readJson(taskFileOf(app))
    const rejected = task.events.filter((event) => event.type === 'tool.rejected')
    check(`被拒绝的调用都进了审计事件（${rejected.length} 条）`, rejected.length >= 6, rejected.map((event) => event.tool).join(', '))

    // 交付后开新任务：自动归档，不丢审计
    const second = await mcp.call('task_start', { title: '第二个需求', goal: '验证交付后可以继续' })
    check('交付后可以直接开新任务', second.value?.ok === true, second.text)
    check('旧任务被归档到 .fe-guard/tasks/', existsSync(path.join(app, '.fe-guard/tasks')) && readdirSync(path.join(app, '.fe-guard/tasks')).length >= 1)
  } finally {
    mcp.close()
  }
}

// ------------------------------------------------------------------ 场景 3：存量项目

async function legacyProject() {
  step('3. 存量项目：带 v1 baseline 跑流程，棘轮行为不变')
  const app = makeApp('legacy')
  check('init 成功', cli(app, ['init']).code === 0)
  check('存量违规入账', cli(app, ['baseline']).code === 0)
  check('baseline 以 (文件, 规则) 记录 4 条', baselineKeyCount(app) === 4, String(baselineKeyCount(app)))

  const math = path.join(app, 'src/utils/math.ts')
  const original = readFileSync(math, 'utf8')
  writeFileSync(
    math,
    `${original.replace('n % 2 == 0', 'n % 2 === 0')}\nexport function parse(input: any): string {\n  return String(input)\n}\n`,
  )

  const cliCheck = cli(app, ['check'])
  check('v1 的 CLI 检查仍判失败（退出码 1）', cliCheck.code === 1, cliCheck.out)
  check('「修一条 + 加一条」后 baseline 只收紧不放宽（条目 4 → 3）', baselineKeyCount(app) === 3, String(baselineKeyCount(app)))
  check(
    'baseline 没有吸收新规则的欠债',
    !readJson(baselineFileOf(app)).entries['src/utils/math.ts']?.['eslint/@typescript-eslint/no-explicit-any'],
    JSON.stringify(readJson(baselineFileOf(app)).entries['src/utils/math.ts']),
  )

  const mcp = new Mcp(app)
  try {
    await handshake(mcp)
    await mcp.call('task_start', { title: '修复 math.ts 新增违规', goal: '同一文件不再产生新增违规' })
    await mcp.call('task_criteria', { criteria: [{ text: 'fe-guard 不再报新增违规' }] })
    await mcp.call('task_plan', { steps: ['修复 eqeqeq', '移除 any', '跑门禁'] })

    const gateFail = await mcp.call('task_gate')
    check(
      '门禁复用同一份 baseline，判出新增 1 条',
      gateFail.value?.ok === false && gateFail.value?.summary?.new === 1,
      gateFail.text,
    )
    check('门禁失败时 baseline 条目数不变（仍 3）', baselineKeyCount(app) === 3, String(baselineKeyCount(app)))
    check('门禁失败后停在 verify', gateFail.value?.stage === 'verify', gateFail.text)

    writeFileSync(
      math,
      [
        'export function add(a: number, b: number): number {',
        '  return a + b',
        '}',
        '',
        'export function subtract(a: number, b: number): number {',
        '  return a - b',
        '}',
        '',
        'export function isEven(n: number): boolean {',
        '  return n % 2 === 0',
        '}',
        '',
        'export function parse(input: string): string {',
        '  return input.trim()',
        '}',
        '',
      ].join('\n'),
    )
    const gateOk = await mcp.call('task_gate')
    check('修复后门禁通过并交付', gateOk.value?.ok === true && gateOk.value?.stage === 'deliver', gateOk.text)
    check(
      'baseline 自动收紧：math.ts 条目被删除',
      !readJson(baselineFileOf(app)).entries['src/utils/math.ts'],
      JSON.stringify(readJson(baselineFileOf(app)).entries),
    )
  } finally {
    mcp.close()
  }
}

// ------------------------------------------------------------------ 场景 4：关掉流程层

async function workflowOff() {
  step('4. 关掉流程层：退回 v1 纯检查模式')
  const app = makeApp('workflow-off')
  check('init 成功', cli(app, ['init']).code === 0)
  check('存量违规入账', cli(app, ['baseline']).code === 0)
  patchConfig(app, (config) => {
    config.workflow.enabled = false
  })

  const mcp = new Mcp(app)
  try {
    await handshake(mcp)
    const list = await mcp.request('tools/list', {})
    const names = (list.result?.tools ?? []).map((tool) => tool.name)
    check('只暴露门禁工具', JSON.stringify(names) === '["task_gate"]', names.join(', '))

    const blocked = await mcp.call('task_start', { title: 'x', goal: 'y' })
    check('流程工具被明确拒绝并说明当前是 v1 模式', blocked.isError && /流程层已关闭/.test(blocked.text), blocked.text)

    const gate = await mcp.call('task_gate')
    check('门禁仍可用，且标记 workflow=disabled', gate.value?.workflow === 'disabled' && gate.value?.ok === true, gate.text)
    check('没有产生任务状态文件', !existsSync(taskFileOf(app)))

    check('CLI 检查照常通过', cli(app, ['check']).code === 0)

    writeFileSync(
      path.join(app, 'src/utils/bad.ts'),
      'export function bad(): any {\n  return 1\n}\n',
    )
    const failing = await mcp.call('task_gate')
    check('关闭流程层后门禁仍然能拦住新增违规', failing.value?.ok === false && failing.value?.workflow === 'disabled', failing.text)
    check('CLI 检查同步失败（退出码 1）', cli(app, ['check']).code === 1)
  } finally {
    mcp.close()
  }
}

// ------------------------------------------------------------------ 场景 5：生成物

async function artifactsIdempotent() {
  step('5. 生成物：AGENTS.md 长度可控、重复 init 幂等、MCP 配置合并不覆盖')
  const app = makeApp('artifacts')
  writeFileSync(path.join(app, 'AGENTS.md'), '# 我的仓库\n\n这是我自己写的约定，不能被覆盖。\n')
  mkdirSync(path.join(app, '.cursor'), { recursive: true })
  writeFileSync(
    path.join(app, '.cursor/mcp.json'),
    `${JSON.stringify({ mcpServers: { other: { command: 'other-bin' } } }, null, 2)}\n`,
  )

  const first = cli(app, ['init'])
  check('init 成功', first.code === 0, first.out)

  const agents = readFileSync(path.join(app, 'AGENTS.md'), 'utf8')
  check('用户已有内容被保留', agents.includes('这是我自己写的约定'))
  check('受管片段只出现 1 次', agents.split(AGENTS_BEGIN).length - 1 === 1)
  const block = agents.slice(agents.indexOf(AGENTS_BEGIN), agents.indexOf(AGENTS_END) + AGENTS_END.length)
  check(`受管片段与单一源一致`, block === agentsBlock(), 'AGENTS.md 片段与 src/ide/source.js 渲染结果不一致')
  const tokens = estimateTokens(block)
  check(`AGENTS.md 片段约 ${tokens} token（上限 ${AGENTS_TOKEN_LIMIT}）`, tokens <= AGENTS_TOKEN_LIMIT, String(tokens))

  const mcpConfig = readJson(path.join(app, '.cursor/mcp.json'))
  check(
    'MCP 配置合并而非覆盖（保留其他 server）',
    Boolean(mcpConfig.mcpServers?.other) && Boolean(mcpConfig.mcpServers?.['fe-guard']),
    JSON.stringify(mcpConfig),
  )
  check(
    'fe-guard 的挂载项是可直接运行的 node 命令',
    mcpConfig.mcpServers?.['fe-guard']?.command === 'node' &&
      Array.isArray(mcpConfig.mcpServers['fe-guard'].args) &&
      mcpConfig.mcpServers['fe-guard'].args.some((arg) => arg.includes('fe-guard-mcp.js')),
    JSON.stringify(mcpConfig.mcpServers?.['fe-guard']),
  )
  check('Trae 的 MCP 配置同样生成', existsSync(path.join(app, '.trae/mcp.json')))
  for (const file of ['.trae/rules/fe-guard.md', '.trae/commands/fe-guard-next.md', '.trae/commands/fe-guard-gate.md', '.cursor/rules/fe-guard.mdc']) {
    check(`生成 ${file}`, existsSync(path.join(app, file)))
  }

  const before = snapshot(app)
  const second = cli(app, ['init'])
  const after = snapshot(app)
  check('重复 init 成功', second.code === 0, second.out)
  check('重复 init 不产生任何文件变化（幂等）', before === after, diffSnapshots(before, after))
  check('输出里明确"已是最新"', /已是最新/.test(second.out), second.out)
}

function diffSnapshots(before, after) {
  const left = new Set(before.split('\n'))
  const right = new Set(after.split('\n'))
  const added = [...right].filter((item) => !left.has(item))
  const removed = [...left].filter((item) => !right.has(item))
  return [`+ ${added.join('\n+ ')}`, `- ${removed.join('\n- ')}`].join('\n')
}

// ------------------------------------------------------------------ 场景 6：验收条件挂测试文件

async function testFileBinding() {
  step('6. 验收条件挂测试文件：门禁真跑测试，通过才覆盖')
  const app = makeApp('test-binding')
  check('init 成功', cli(app, ['init']).code === 0)
  check('存量违规入账', cli(app, ['baseline']).code === 0)

  const mcp = new Mcp(app)
  try {
    await handshake(mcp)
    await mcp.call('task_start', { title: '时长工具', goal: 'formatDuration 正确且有测试覆盖' })

    const escape = await mcp.call('task_criteria', { criteria: [{ text: '逃出仓库', testFile: '../outside.test.mjs' }] })
    check('testFile 带 .. 被拒绝', escape.isError && /testFile/.test(escape.text), escape.text)

    const criteria = await mcp.call('task_criteria', {
      criteria: [
        { text: 'formatDuration(1000) 返回 "1s"', testFile: 'test/duration.test.mjs' },
        { text: 'fe-guard 全量检查通过' },
      ],
    })
    check('挂 testFile 的条件被接受', criteria.value?.ok === true, criteria.text)
    await mcp.call('task_plan', { steps: ['实现 formatDuration', '写测试', '跑门禁'] })

    mkdirSync(path.join(app, 'src/features'), { recursive: true })
    writeFileSync(path.join(app, 'src/features/duration.mjs'), 'export function formatDuration(ms) {\n  return `${ms / 1000}s`\n}\n')

    const missing = await mcp.call('task_gate')
    check(
      '测试文件缺失：停在 verify 且 blocker 指出',
      missing.value?.ok === false &&
        missing.value?.stage === 'verify' &&
        missing.value?.blockers?.some((item) => /测试文件不存在/.test(item)),
      missing.text,
    )

    mkdirSync(path.join(app, 'test'), { recursive: true })
    const testFile = path.join(app, 'test/duration.test.mjs')
    const testSource = (expected) =>
      `import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { formatDuration } from '../src/features/duration.mjs'\ntest('1s', () => assert.equal(formatDuration(1000), '${expected}'))\n`
    writeFileSync(testFile, testSource('2s'))
    const failing = await mcp.call('task_gate')
    check('测试失败：检查通过也不能交付', failing.value?.ok === false && failing.value?.stage === 'verify', failing.text)
    check('blockers 含测试失败信息', failing.value?.blockers?.some((item) => /测试未通过/.test(item)), failing.text)

    writeFileSync(testFile, testSource('1s'))
    const gate = await mcp.call('task_gate')
    check('测试通过后进入 deliver', gate.value?.ok === true && gate.value?.stage === 'deliver', gate.text)
    check('2/2 条件被覆盖', gate.value?.criteria?.total === 2 && gate.value?.criteria?.achieved === 2, gate.text)

    const task = readJson(taskFileOf(app))
    const lastGate = [...task.events].reverse().find((event) => event.type === 'gate.recorded')
    check(
      '测试结果写进门禁证据（可审计）',
      lastGate?.evidence?.tests?.some((item) => item.criterionId === 'C1' && item.ok === true),
      JSON.stringify(lastGate?.evidence?.tests),
    )

    const status = await mcp.call('task_status')
    check(
      'task_status 展示 testFile',
      status.value?.criteria?.find((item) => item.id === 'C1')?.testFile === 'test/duration.test.mjs',
      status.text,
    )
  } finally {
    mcp.close()
  }
}

// ------------------------------------------------------------------ 主流程

async function main() {
  line('fe-guard v2 验证开始（MCP 协议 + 流程约束 + 生成物）')

  if (!existsSync(path.join(SAMPLE, 'node_modules'))) {
    line(`样例工程缺少依赖，正在安装（npm install，仅首次）...`)
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: SAMPLE, stdio: 'inherit' })
    if (install.status !== 0) {
      line(`依赖安装失败，请先手动在 ${SAMPLE} 执行 npm install`)
      process.exit(1)
    }
  }

  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  line(`临时工作区: ${WORK}`)

  const scenarios = [
    ['成功路径', happyPath],
    ['反例', rejections],
    ['存量项目', legacyProject],
    ['关闭流程层', workflowOff],
    ['条件挂测试', testFileBinding],
    ['生成物', artifactsIdempotent],
  ]
  for (const [name, run] of scenarios) {
    try {
      await run()
    } catch (error) {
      fail += 1
      line(`  FAIL  ${name}场景异常中断`)
      line(indent(error.stack ?? error.message))
    }
  }

  step('汇总')
  line(`  PASS: ${pass}   FAIL: ${fail}`)
  if (fail > 0) {
    line(`\n验证失败：${fail} 项不符合预期（临时工作区保留在 ${WORK} 便于排查）`)
    process.exit(1)
  }
  line('\n全部验证通过')
}

await main()
