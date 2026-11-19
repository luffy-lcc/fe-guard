#!/usr/bin/env node
/**
 * fe-guard v3 一键验证（真实执行，不只测纯函数）。
 *
 * 覆盖：
 * 1. 依赖守卫：能力冲突 / 幽灵依赖 / 新增依赖未登记 / 同能力重复 / 存量只拦新增；
 * 2. 组件清单：生成清单、同名与 props 重合、baseline 入账、MCP ui_lookup；
 * 3. 腐化指标：行数/函数长度/any/重复块的检测、值棘轮收紧、放宽需 --widen；
 * 4. 大 diff：阈值边界、拆分提示、warn 降级、不被 baseline 吸收；
 * 5. 单项开关：关掉任意一项不影响其余检查与退出码；
 * 6. 存量接入：历史问题不红、修一条收紧、变差要显式 --widen。
 *
 * 用法: node verify-v3.mjs   （或 npm run verify:v3 / npm run verify:all）
 * 退出码: 0 = 全部通过，1 = 有失败项
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const MCP_BIN = path.join(ROOT, 'bin', 'fe-guard-mcp.js')
const SAMPLE = path.join(ROOT, 'examples', 'sample-app')
const WORK = path.join(ROOT, '.verify-v3-tmp')

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

// ------------------------------------------------------------------ 工程操作

function git(cwd, args, allowFail = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} 失败: ${result.stderr}`)
  return result
}

function cli(app, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const baselineFileOf = (app) => path.join(app, 'fe-guard.baseline.json')
const configFileOf = (app) => path.join(app, 'fe-guard.config.json')
const reportFileOf = (app) => path.join(app, '.fe-guard', 'report.json')

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

function commitAll(app, message) {
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', message])
}

function reset(app) {
  git(app, ['reset', '-q'], true)
  git(app, ['checkout', '--', '.'], true)
  git(app, ['clean', '-qfd'])
}

function patchConfig(app, mutate) {
  const config = readJson(configFileOf(app))
  mutate(config)
  writeFileSync(configFileOf(app), `${JSON.stringify(config, null, 2)}\n`)
}

function disableLegacyChecks(config) {
  for (const key of ['eslint', 'typescript', 'boundaries']) config.checks[key].enabled = false
}

function setup(name, { disable = ['eslint', 'typescript', 'boundaries'] } = {}) {
  const app = makeApp(name)
  check('init 成功', cli(app, ['init']).code === 0)
  patchConfig(app, (config) => {
    for (const key of disable) config.checks[key].enabled = false
  })
  const baseline = cli(app, ['baseline'])
  check('存量入账成功', baseline.code === 0, baseline.err || baseline.out)
  commitAll(app, 'setup: init + baseline')
  return app
}

function runCheck(app, args = []) {
  const result = cli(app, ['check', '--json', ...args])
  let report = null
  try {
    report = JSON.parse(result.out)
  } catch {
    report = null
  }
  return { code: result.code, report, out: result.out, err: result.err }
}

const newViolations = (report) => (report?.violations ?? []).filter((item) => item.status === 'new')
const hasNew = (report, ruleId) => newViolations(report).some((item) => item.ruleId === ruleId)
const ruleIds = (report) => (report?.violations ?? []).map((item) => item.ruleId)

function writeTextDeep(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function writeLines(file, count, prefix = 'value') {
  writeTextDeep(
    file,
    Array.from({ length: count }, (_, index) => `export const ${prefix}${index} = ${index} * 2 + 1`).join('\n'),
  )
}

const ANY_COUNT = 25

/** 一个既有超长函数、又有 25 个 any 的大文件；行数精确等于 lines。 */
function bigSource(lines) {
  const parts = ['export function longTask(n: number): number {', '  let total = 0']
  for (let index = 0; index < 100; index += 1) parts.push(`  total += n * ${index}`)
  parts.push('  return total', '}', '')
  while (parts.length < lines - ANY_COUNT) parts.push(`export const value${parts.length} = ${parts.length} * 3 + 1`)
  for (let index = 0; index < ANY_COUNT; index += 1) parts.push(`export const any${index}: any = null`)
  return parts.join('\n')
}

const vueComponent = (name, props, emits = ['change']) => `<script setup lang="ts">
defineOptions({ name: '${name}' })
defineProps<{ ${props.map((prop) => `${prop}: string`).join('; ')} }>()
defineEmits<{ ${emits.map((event) => `(e: '${event}', value: number): void`).join('; ')} }>()
</script>
<template><div /></template>
`

// ------------------------------------------------------------------ MCP 客户端

class Mcp {
  constructor(root) {
    this.child = spawn(process.execPath, [MCP_BIN, '--root', root], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    this.buffer = ''
    this.pending = new Map()
    this.seq = 0
    this.stderr = ''
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      this.drain()
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8')
    })
    this.child.on('exit', (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP 退出（code=${code}）`))
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
    clientInfo: { name: 'fe-guard-verify-v3', version: '1' },
  })
}

// ------------------------------------------------------------------ 1. 依赖守卫

async function depsScenario() {
  step('1. 依赖守卫：能力冲突 / 幽灵依赖 / 新依赖登记 / 同能力重复')
  // 保留 ESLint 用来证明「关掉 deps 不影响其他检查」；关掉 tsc，避免未安装的包产生额外类型错误。
  const app = setup('deps', { disable: ['typescript', 'boundaries'] })

  // 1a 能力冲突：moment 被 block，报错必须给出 dayjs 与替代文件。
  const momentFile = path.join(app, 'src/utils/date-bad.ts')
  writeFileSync(momentFile, "import moment from 'moment'\nexport const now = (): string => moment().format('YYYY-MM-DD')\n")
  const conflict = runCheck(app)
  check('直接 import moment → 失败', conflict.code === 1, conflict.out)
  const conflictViolation = newViolations(conflict.report).find((item) => item.ruleId === 'deps/capability-conflict')
  check('命中 deps/capability-conflict', Boolean(conflictViolation), ruleIds(conflict.report).join(', '))
  check(
    '报错同时给出正确库、替代文件与示例',
    /dayjs/.test(conflictViolation?.message ?? '') &&
      /src\/utils\/date\.ts/.test(conflictViolation?.message ?? '') &&
      /dayjs/.test(conflictViolation?.fix ?? ''),
    JSON.stringify(conflictViolation),
  )

  // 单项关闭：只关 deps，其余检查与退出码语义不受影响。
  patchConfig(app, (config) => {
    config.checks.deps.enabled = false
  })
  writeFileSync(path.join(app, 'src/utils/unused.ts'), 'export function unused(): number {\n  const orphan = 1\n  return 2\n}\n')
  const depsOff = runCheck(app)
  check('关闭 deps 后 moment 不再报错', !ruleIds(depsOff.report).some((id) => id.startsWith('deps/')), ruleIds(depsOff.report).join(', '))
  check(
    '关闭 deps 后 ESLint 仍能拦住新增违规（其余检查不受影响）',
    depsOff.code === 1 && hasNew(depsOff.report, 'eslint/@typescript-eslint/no-unused-vars'),
    depsOff.out,
  )
  reset(app)

  // 1b 正例：登记过的 dayjs 正常通过。
  patchConfig(app, (config) => {
    config.checks.deps.registry.dayjs = '日期处理唯一库（封装在 src/utils/date.ts）'
  })
  const pkgFile = path.join(app, 'package.json')
  const pkg = readJson(pkgFile)
  pkg.dependencies = { ...(pkg.dependencies ?? {}), dayjs: '^1.11.13' }
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(path.join(app, 'src/utils/date.ts'), "import dayjs from 'dayjs'\nexport const format = (ts: number): string => dayjs(ts).format('YYYY-MM-DD')\n")
  const allowed = runCheck(app)
  check('已登记的 dayjs 通过（正例）', allowed.code === 0 && !ruleIds(allowed.report).some((id) => id.startsWith('deps/')), allowed.out)
  reset(app)

  // 1c 幽灵依赖：import 了 package.json 里没有的包。
  writeFileSync(path.join(app, 'src/utils/lodash.ts'), "import lodash from 'lodash'\nexport const pick = lodash.pick\n")
  const phantom = runCheck(app)
  check('未声明的包 → deps/phantom', phantom.code === 1 && hasNew(phantom.report, 'deps/phantom'), phantom.out)
  const phantomViolation = newViolations(phantom.report)[0]
  check(
    '幽灵依赖提示怎么补声明或删 import',
    /package\.json/.test(`${phantomViolation?.message} ${phantomViolation?.fix}`),
    JSON.stringify(phantomViolation),
  )

  // 1d 新增依赖未登记：以 package.json 变更为触发条件。
  reset(app)
  const pkg2 = readJson(pkgFile)
  pkg2.dependencies = { ...(pkg2.dependencies ?? {}), xlsx: '^0.18.5' }
  writeFileSync(pkgFile, `${JSON.stringify(pkg2, null, 2)}\n`)
  writeFileSync(path.join(app, 'src/export-xlsx.ts'), "import * as xlsx from 'xlsx'\nexport const read = (): unknown => xlsx\n")
  const unregistered = runCheck(app)
  const unregisteredViolation = newViolations(unregistered.report).find((item) => item.ruleId === 'deps/unregistered')
  check('新增依赖未登记用途 → 失败', unregistered.code === 1 && Boolean(unregisteredViolation), unregistered.out)
  check(
    '提示直接给出 registry 配置写法与包名',
    /registry/.test(unregisteredViolation?.fix ?? '') && /xlsx/.test(unregisteredViolation?.message ?? ''),
    JSON.stringify(unregisteredViolation),
  )

  patchConfig(app, (config) => {
    config.checks.deps.registry.xlsx = '导出 Excel（只在 src/export-xlsx.ts 使用）'
  })
  const registered = runCheck(app)
  check('登记用途后通过（正例）', registered.code === 0 && !ruleIds(registered.report).some((id) => id.startsWith('deps/')), registered.out)
  reset(app)

  // 1e 同能力重复引入：package.json 同时有两个日期库。
  const pkg3 = readJson(pkgFile)
  pkg3.dependencies = { ...(pkg3.dependencies ?? {}), dayjs: '^1.11.13', moment: '^2.30.1' }
  writeFileSync(pkgFile, `${JSON.stringify(pkg3, null, 2)}\n`)
  const duplicate = runCheck(app)
  const duplicateViolation = newViolations(duplicate.report).find((item) => item.ruleId === 'deps/capability-duplicate')
  check('同时依赖 dayjs 与 moment → deps/capability-duplicate', duplicate.code === 1 && Boolean(duplicateViolation), duplicate.out)
  check(
    '提示说明保留哪个、移除哪个',
    /dayjs/.test(duplicateViolation?.fix ?? '') && /moment/.test(duplicateViolation?.message ?? ''),
    JSON.stringify(duplicateViolation),
  )
  reset(app)

  // 1f 存量幽灵依赖只拦新增。
  const legacyApp = makeApp('deps-legacy')
  writeFileSync(path.join(legacyApp, 'src/utils/old.ts'), "import lodash from 'lodash'\nexport const old = (): unknown => lodash\n")
  commitAll(legacyApp, 'legacy: undeclared import')
  check('存量项目 init 成功', cli(legacyApp, ['init']).code === 0)
  patchConfig(legacyApp, (config) => {
    config.checks.typescript.enabled = false
    config.checks.boundaries.enabled = false
  })
  check('存量项目 baseline 入账成功', cli(legacyApp, ['baseline']).code === 0)
  commitAll(legacyApp, 'legacy: baseline')
  const legacyGreen = runCheck(legacyApp)
  check('存量幽灵依赖不导致全红', legacyGreen.code === 0 && legacyGreen.report.summary.new === 0, legacyGreen.out)

  writeFileSync(path.join(legacyApp, 'src/utils/new.ts'), "import lodash from 'lodash'\nexport const next = (): unknown => lodash\n")
  const legacyNew = runCheck(legacyApp)
  const fresh = newViolations(legacyNew.report)
  check('新文件再次 import 同一包 → 只报新增 1 条', legacyNew.code === 1 && fresh.length === 1 && fresh[0].ruleId === 'deps/phantom', legacyNew.out)
}

// ------------------------------------------------------------------ 2. 组件清单

async function uiScenario() {
  step('2. 组件清单：生成、同名 / props 重合、baseline 入账、MCP 按需查询')
  const app = setup('ui')

  const props = ['title', 'count', 'avatar']
  writeFileSync(path.join(app, 'src/ui/UserCard.vue'), vueComponent('UserCard', props))
  const first = runCheck(app)
  check('首个组件不报重复（正例）', first.code === 0, first.out)

  const inventoryFile = path.join(app, '.fe-guard/ui-inventory.json')
  const inventory = existsSync(inventoryFile) ? readJson(inventoryFile) : null
  const card = inventory?.components?.find((item) => item.name === 'UserCard')
  check('生成 .fe-guard/ui-inventory.json', Boolean(inventory), inventoryFile)
  check(
    '清单包含组件名、props、emits',
    [...(card?.props ?? [])].sort().join(',') === [...props].sort().join(',') && (card?.emits ?? []).includes('change'),
    JSON.stringify(card),
  )

  // MCP：清单不在上下文里，按需查询。
  const mcp = new Mcp(app)
  try {
    await handshake(mcp)
    const list = await mcp.request('tools/list', {})
    const tools = list.result?.tools ?? []
    check('新增且只新增 ui_lookup（工具总数 7）', tools.length === 7 && tools.some((tool) => tool.name === 'ui_lookup'), tools.map((tool) => tool.name).join(', '))
    check(
      'ui_lookup 描述 ≤ 90 字',
      tools.every((tool) => tool.description.length <= 90),
      tools.map((tool) => `${tool.name}=${tool.description.length}`).join(' '),
    )
    const lookup = await mcp.call('ui_lookup', { query: 'UserCard' })
    check('ui_lookup 返回匹配摘要', lookup.value?.total >= 1 && lookup.value.matches[0].file === 'src/ui/UserCard.vue', lookup.text)
    check(`ui_lookup 返回很短（${Buffer.byteLength(lookup.text, 'utf8')} 字节）`, Buffer.byteLength(lookup.text, 'utf8') < 800, lookup.text)
    const miss = await mcp.call('ui_lookup', { query: 'NothingHere' })
    check('查不到时不编造结果', miss.value?.total === 0 && miss.value.matches.length === 0, miss.text)
  } finally {
    mcp.close()
  }

  // props 重合：换个名字、props 一样 → duplicate-props。
  writeFileSync(path.join(app, 'src/ui/UserCardAlt.vue'), vueComponent('UserCardAlt', props))
  const duplicate = runCheck(app)
  check(
    'props 高度重合 → 告警（默认不阻断，避免误伤同类表单）',
    duplicate.code === 0 && newViolations(duplicate.report).some((item) => item.ruleId === 'ui/duplicate-props' && item.severity === 'warn'),
    duplicate.out,
  )
  check('命中 ui/duplicate-props', hasNew(duplicate.report, 'ui/duplicate-props'), ruleIds(duplicate.report).join(', '))
  check(
    '告警里指出另一个文件，便于直接复用',
    newViolations(duplicate.report).every((item) => /src\/ui\//.test(item.message + item.fix)),
    JSON.stringify(newViolations(duplicate.report).slice(0, 2)),
  )

  const adopt = cli(app, ['baseline'])
  check('首次接入可以把重复组件入账', adopt.code === 0, adopt.err || adopt.out)
  const known = runCheck(app)
  check('入账后重复组件变为存量，不再失败', known.code === 0 && known.report.summary.new === 0, known.out)

  // 同名：新文件导出与清单里已有组件相同的名字。
  writeTextDeep(path.join(app, 'src/components/UserCardCopy.vue'), vueComponent('UserCard', ['title']))
  const sameName = runCheck(app)
  check('同名组件 → 失败', sameName.code === 1 && hasNew(sameName.report, 'ui/duplicate-name'), sameName.out)

  writeTextDeep(path.join(app, 'src/components/UserCardThird.vue'), vueComponent('UserCard', ['title']))
  const third = runCheck(app)
  check('再新增第三个同名组件 → 仍会失败（只拦新增）', third.code === 1 && hasNew(third.report, 'ui/duplicate-name'), third.out)

  patchConfig(app, (config) => {
    config.checks.ui.enabled = false
  })
  const uiOff = runCheck(app)
  check('关闭 ui 后不再报组件重复，且其余检查不受影响', uiOff.code === 0 && !ruleIds(uiOff.report).some((id) => id.startsWith('ui/')), uiOff.out)
}

// ------------------------------------------------------------------ 3. 腐化指标

async function metricsScenario() {
  step('3. 腐化指标：行数 / 长函数 / any / 重复块，值棘轮只拦变差')
  // 这里只验证 metrics，关掉 diff-size，避免大文件本身触发“大 diff”干扰断言。
  const app = setup('metrics', { disable: ['eslint', 'typescript', 'boundaries', 'diff-size'] })
  const big = path.join(app, 'src/legacy/big.ts')

  writeTextDeep(big, bigSource(530))
  const detected = runCheck(app)
  check('超长文件、长函数、any 超标 → 失败', detected.code === 1, detected.out)
  for (const ruleId of ['metrics/file-lines', 'metrics/function-lines', 'metrics/any']) {
    const violation = newViolations(detected.report).find((item) => item.ruleId === ruleId)
    check(`命中 ${ruleId} 且带实际测量值`, Boolean(violation) && typeof violation.value === 'number', JSON.stringify(violation))
  }

  const adopt = cli(app, ['baseline'])
  check('首次接入指标入账成功', adopt.code === 0, adopt.err || adopt.out)
  const ratchets = readJson(baselineFileOf(app)).ratchets ?? {}
  check(
    'baseline 记录的是指标允许值（不是条数）',
    ratchets['src/legacy/big.ts']?.['metrics/file-lines'] === 530 &&
      ratchets['src/legacy/big.ts']?.['metrics/any'] === ANY_COUNT,
    JSON.stringify(ratchets),
  )
  const green = runCheck(app)
  check('入账后历史大文件不再报错', green.code === 0 && green.report.summary.new === 0, green.out)

  // 变差：追加 60 行，超过允许值。
  writeFileSync(big, bigSource(590))
  const worse = runCheck(app)
  const worseLine = newViolations(worse.report).find((item) => item.ruleId === 'metrics/file-lines')
  check('文件继续变长 → 新增 1 条指标违规', worse.code === 1 && Boolean(worseLine) && worseLine.value === 590, worse.out)
  check('报告带上 baseline 允许值', worseLine?.allowed === 530, JSON.stringify(worseLine))

  const refuse = cli(app, ['baseline'])
  check('不加 --widen 时拒绝放宽指标棘轮（退出码 2）', refuse.code === 2 && /变宽/.test(refuse.err + refuse.out), refuse.err + refuse.out)
  const widen = cli(app, ['baseline', '--widen'])
  check('显式 --widen 才允许放宽', widen.code === 0, widen.err + widen.out)
  check('放宽后通过', runCheck(app).code === 0)

  // 修好：降到配置阈值以下，条目删除（收紧）。
  writeFileSync(big, bigSource(495))
  const tightened = runCheck(app)
  check('降到阈值以下 → 通过', tightened.code === 0, tightened.out)
  check(
    '报告记录 file-lines 从 590 收紧到 0',
    tightened.report.baseline.tightened.some(
      (item) => item.file === 'src/legacy/big.ts' && item.ruleId === 'metrics/file-lines' && item.from === 590 && item.to === 0,
    ),
    JSON.stringify(tightened.report.baseline.tightened),
  )
  check(
    'baseline 中不再保留 file-lines 条目',
    readJson(baselineFileOf(app)).ratchets['src/legacy/big.ts']?.['metrics/file-lines'] === undefined,
    JSON.stringify(readJson(baselineFileOf(app)).ratchets),
  )

  // 重复块：两份 80 行完全相同的文件（保留已有 ratchets，验证放宽仍需确认）。
  writeFileSync(big, bigSource(430))
  const block = Array.from({ length: 80 }, (_, index) => `export const shared${index} = compute(${index}) + ${index}`).join('\n')
  writeTextDeep(path.join(app, 'src/dup/a.ts'), block)
  writeTextDeep(path.join(app, 'src/dup/b.ts'), block)
  const duplicated = runCheck(app)
  check(
    '两份重复文件 → metrics/duplication',
    duplicated.code === 1 && newViolations(duplicated.report).filter((item) => item.ruleId === 'metrics/duplication').length === 2,
    duplicated.out,
  )
  check('重复块提示指出与谁重复', /src\/dup\//.test(newViolations(duplicated.report).find((item) => item.ruleId === 'metrics/duplication')?.message ?? ''), duplicated.out)

  const dupRefuse = cli(app, ['baseline'])
  check('接受重复块也必须有 --widen', dupRefuse.code === 2, dupRefuse.err + dupRefuse.out)
  check('--widen 后入账', cli(app, ['baseline', '--widen']).code === 0)
  check('重复块入账后通过', runCheck(app).code === 0)

  // 单项关闭：metrics 关掉后，大文件不再失败；deps 仍然工作。
  patchConfig(app, (config) => {
    config.checks.metrics.enabled = false
  })
  writeFileSync(big, `${bigSource(700)}\nimport moment from 'moment'\nexport const now = (): string => moment().format()\n`)
  const metricsOff = runCheck(app)
  check('关闭 metrics 后大文件不再报错', !ruleIds(metricsOff.report).some((id) => id.startsWith('metrics/')), ruleIds(metricsOff.report).join(', '))
  check(
    '关闭 metrics 后 deps 仍能拦住 moment（单项开关互不影响）',
    metricsOff.code === 1 && newViolations(metricsOff.report).every((item) => item.ruleId === 'deps/capability-conflict'),
    metricsOff.out,
  )
}

// ------------------------------------------------------------------ 4. 大 diff

function writeCaseFiles(app, lengths) {
  lengths.forEach((count, index) => writeLines(path.join(app, `src/diff/case-${index}.ts`), count, `case${index}_`))
}

async function diffSizeScenario() {
  step('4. 大 diff：阈值边界、拆分提示、warn 降级、不被 baseline 吸收')
  const app = makeApp('diff-size')
  check('init 成功', cli(app, ['init']).code === 0)
  patchConfig(app, (config) => {
    disableLegacyChecks(config)
    config.checks['diff-size'].maxFiles = 3
    config.checks['diff-size'].maxLines = 50
  })
  check('baseline 成功', cli(app, ['baseline']).code === 0)
  commitAll(app, 'setup: thresholds')

  // 边界：正好 3 文件 / 50 行 → 通过（阈值是严格大于才失败）。
  writeCaseFiles(app, [10, 20, 20])
  const exact = runCheck(app)
  check('正好等于阈值（3 文件 / 50 行）→ 通过', exact.code === 0, exact.out)
  reset(app)

  // 文件数 +1，行数不变 → 只报文件数。
  writeCaseFiles(app, [10, 10, 20, 10])
  const tooManyFiles = runCheck(app)
  const fileViolation = newViolations(tooManyFiles.report).find((item) => item.ruleId === 'diff-size/files')
  check('4 个文件 / 50 行 → 只报 diff-size/files', tooManyFiles.code === 1 && Boolean(fileViolation) && !hasNew(tooManyFiles.report, 'diff-size/lines'), tooManyFiles.out)
  check('文件数超限的提示包含可操作的拆分步骤', /拆分/.test(fileViolation?.fix ?? '') && /PR/.test(fileViolation?.fix ?? ''), JSON.stringify(fileViolation))
  reset(app)

  // 行数 +1，文件数不变 → 只报行数。
  writeCaseFiles(app, [10, 20, 21])
  const tooManyLines = runCheck(app)
  const lineViolation = newViolations(tooManyLines.report).find((item) => item.ruleId === 'diff-size/lines')
  check('3 个文件 / 51 行 → 只报 diff-size/lines', tooManyLines.code === 1 && Boolean(lineViolation) && !hasNew(tooManyLines.report, 'diff-size/files'), tooManyLines.out)
  check('行数超限的提示说明怎么拆', /拆分/.test(lineViolation?.fix ?? '') && /PR/.test(lineViolation?.fix ?? ''), JSON.stringify(lineViolation))
  reset(app)

  // 降级为 warn：仍然报，但退出码 0。
  patchConfig(app, (config) => {
    config.checks['diff-size'].level = 'warn'
  })
  commitAll(app, 'setup: warn level')
  writeCaseFiles(app, [10, 20, 21])
  const warn = runCheck(app)
  check(
    'level=warn 时超阈值只告警、退出码 0',
    warn.code === 0 && newViolations(warn.report).some((item) => item.ruleId === 'diff-size/lines' && item.severity === 'warn'),
    warn.out,
  )
  reset(app)

  // 不进 baseline：入账一次，仍然失败。
  patchConfig(app, (config) => {
    config.checks['diff-size'].level = 'error'
  })
  commitAll(app, 'setup: error level')
  writeCaseFiles(app, [10, 20, 21])
  check('大 diff 状态下 baseline 命令本身成功（它不记录 diff-size）', cli(app, ['baseline']).code === 0)
  check(
    'baseline 文件里没有 diff-size 条目',
    !JSON.stringify(readJson(baselineFileOf(app))).includes('diff-size'),
    JSON.stringify(readJson(baselineFileOf(app))).slice(0, 300),
  )
  const stillFails = runCheck(app)
  check('入账后再次检查仍然失败（大 diff 不被吸收）', stillFails.code === 1 && hasNew(stillFails.report, 'diff-size/lines'), stillFails.out)

  patchConfig(app, (config) => {
    config.checks['diff-size'].enabled = false
  })
  const off = runCheck(app)
  check('单独关闭 diff-size 后通过', off.code === 0 && !ruleIds(off.report).some((id) => id.startsWith('diff-size/')), off.out)
}

// ------------------------------------------------------------------ 5. 存量接入

async function legacyScenario() {
  step('5. 存量接入：历史问题不全红、修一条收紧、变差要显式 --widen')
  const app = makeApp('legacy-v3')
  const big = path.join(app, 'src/legacy/big.ts')
  writeTextDeep(big, bigSource(530))
  writeTextDeep(path.join(app, 'src/ui/LegacyA.vue'), vueComponent('LegacyCard', ['title', 'count', 'extra']))
  writeTextDeep(path.join(app, 'src/ui/LegacyB.vue'), vueComponent('LegacyCard', ['title', 'count', 'extra']))
  writeTextDeep(path.join(app, 'src/utils/old-date.ts'), "import moment from 'moment'\nexport const old = (): string => moment().format()\n")
  commitAll(app, 'legacy debt')

  check('init 成功', cli(app, ['init']).code === 0)
  patchConfig(app, disableLegacyChecks)
  const adopt = cli(app, ['baseline'])
  check('第一次接入：历史欠债全部入账', adopt.code === 0, adopt.err || adopt.out)

  const green = runCheck(app)
  check(
    '接入后不因历史问题全红（new=0，known>0）',
    green.code === 0 && green.report.summary.new === 0 && green.report.summary.known > 0,
    JSON.stringify(green.report?.summary),
  )
  const ratchets = readJson(baselineFileOf(app)).ratchets ?? {}
  check('历史大文件以“允许值”入账', ratchets['src/legacy/big.ts']?.['metrics/file-lines'] === 530, JSON.stringify(ratchets))
  commitAll(app, 'legacy: baseline')

  // 修一条：降到阈值以下，条目删除。
  writeFileSync(big, bigSource(495))
  const fixed = runCheck(app)
  check('修好一条后通过', fixed.code === 0, fixed.out)
  check(
    '修好会自动收紧（条目从 530 删除）',
    fixed.report.baseline.tightened.some((item) => item.ruleId === 'metrics/file-lines' && item.from === 530 && item.to === 0),
    JSON.stringify(fixed.report.baseline.tightened),
  )
  commitAll(app, 'legacy: tighten')

  // 变差：又涨回去，必须失败。
  writeFileSync(big, bigSource(535))
  const worse = runCheck(app)
  check('再次变差 → 失败', worse.code === 1 && hasNew(worse.report, 'metrics/file-lines'), worse.out)

  const refuse = cli(app, ['baseline'])
  check('不加 --widen 拒绝放宽', refuse.code === 2, refuse.err + refuse.out)
  check('--widen 后接受新欠债', cli(app, ['baseline', '--widen']).code === 0)
  check('放宽后通过', runCheck(app).code === 0)
}

// ------------------------------------------------------------------ 主流程

async function main() {
  line('fe-guard v3 验证开始（依赖 / 组件 / 指标 / 大 diff / 存量接入）')

  if (!existsSync(path.join(SAMPLE, 'node_modules'))) {
    line('样例工程缺少依赖，正在安装（npm install，仅首次）...')
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
    ['依赖守卫', depsScenario],
    ['组件清单', uiScenario],
    ['腐化指标', metricsScenario],
    ['大 diff', diffSizeScenario],
    ['存量接入', legacyScenario],
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
  line('\nv3 全部验证通过')
  line('v1/v2 零回归请运行: npm run verify:all')
}

await main()
