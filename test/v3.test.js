import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { baselineKey, evaluateRatchets } from '../src/baseline.js'
import { normalizeConfig } from '../src/config.js'
import { capabilityOf, discoverManifests, extractImports, installedFor, isVirtualSpecifier, packageOf } from '../src/runners/deps.js'
import { componentNameFromFile, extractComponent, findDuplicates, lookupComponents } from '../src/inventory.js'
import { countAny, countLines, duplicationScores, functionLengths, tokenize } from '../src/metrics.js'
import { matchesIgnore, toRepoPath } from '../src/utils.js'

test('tokenize：注释和字符串被抹平，标识符/符号保留', () => {
  const tokens = tokenize("// comment\nconst x = 'hello'\n/* block */ foo(1, 2)")
  assert.ok(tokens.includes('const'))
  assert.ok(tokens.includes('foo'))
  assert.ok(!tokens.includes('hello'))
  assert.ok(!tokens.includes('comment'))
})

test('countAny：只数显式 any 的常见写法', () => {
  assert.equal(countAny('function f(x: any): any { return x as any }'), 3)
  assert.equal(countAny('const list: any[] = []'), 1)
  assert.equal(countAny('type X<T> = T'), 0)
  assert.equal(countLines('a\nb\nc'), 3)
})

test('functionLengths：按花括号配对算行数，嵌套函数取最长', () => {
  const source = [
    'export function short(a: number): number {',
    '  return a',
    '}',
    'export function long(a: number): number {',
    '  if (a > 0) {',
    '    return a',
    '  }',
    '  return 0',
    '}',
  ].join('\n')
  const result = functionLengths(source)
  assert.equal(result[0].name, 'long')
  assert.equal(result[0].lines, 6)
  assert.equal(result[0].startLine, 4)
})

test('duplicationScores：跨文件相同 token 块会被识别，小文件不参与', () => {
  const block = Array.from({ length: 80 }, (_, index) => `const value${index} = compute(input${index}, ${index})`).join('\n')
  const scores = duplicationScores(
    [
      { file: 'a.ts', text: block },
      { file: 'b.ts', text: block },
      { file: 'c.ts', text: 'const tiny = 1' },
    ],
    { windowTokens: 25, minTokens: 120, maxRatio: 0.05 },
  )
  assert.ok(scores.get('a.ts').ratio > 0.9)
  assert.equal(scores.get('a.ts').otherFile, 'b.ts')
  assert.equal(scores.get('c.ts').ratio, 0)
})

test('组件提取：Vue 的 props/emits 与 TSX 的 props 都能进清单', () => {
  const vue = extractComponent(
    [
      '<script setup lang="ts">',
      'defineProps<{ title: string; count?: number }>()',
      "defineEmits<{ (e: 'change', value: number): void; (e: 'close'): void }>()",
      '</script>',
    ].join('\n'),
    'src/ui/UserCard.vue',
  )
  assert.equal(vue.name, 'UserCard')
  assert.deepEqual(vue.props, ['count', 'title'])
  assert.deepEqual(vue.emits, ['change', 'close'])

  const tsx = extractComponent(
    [
      'interface UserCardProps { name: string; age?: number }',
      'export function UserCard(props: UserCardProps) {',
      '  return <div>{props.name}</div>',
      '}',
    ].join('\n'),
    'src/ui/UserCard.tsx',
  )
  assert.equal(tsx.name, 'UserCard')
  assert.deepEqual(tsx.props, ['age', 'name'])
  assert.equal(componentNameFromFile('src/ui/user-card.vue'), 'UserCard')
  assert.equal(componentNameFromFile('src/components/events/index.vue'), 'Events')
  assert.equal(componentNameFromFile('src/views/user/index.vue'), 'User')
})

test('toRepoPath：root 与工具输出存在 realpath 差异时仍返回仓库内相对路径', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-path-'))
  try {
    mkdirSync(path.join(root, 'src'))
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1\n')
    assert.equal(toRepoPath(root, path.join(realpathSync(root), 'src/a.ts')), 'src/a.ts')
    assert.equal(toRepoPath(root, 'src/a.ts'), 'src/a.ts')
    assert.equal(toRepoPath(root, ''), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isVirtualSpecifier：Vite 虚拟模块不会被当成幽灵依赖', () => {
  assert.equal(isVirtualSpecifier('virtual:windi.css'), true)
  assert.equal(isVirtualSpecifier('\0vite/preload'), true)
  assert.equal(isVirtualSpecifier('#internal'), true)
  assert.equal(isVirtualSpecifier('axios'), false)
})

test('monorepo：子包文件能继承根与自身 package.json 的依赖', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-mono-'))
  try {
    mkdirSync(path.join(root, 'apps/a'), { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { axios: '^1.0.0' } }))
    writeFileSync(path.join(root, 'apps/a/package.json'), JSON.stringify({ dependencies: { echarts: '^5.0.0' } }))
    const manifests = discoverManifests(root, ['apps'])
    const installed = installedFor('apps/a/src/chart.ts', manifests)
    assert.equal(installed.has('echarts'), true)
    assert.equal(installed.has('axios'), true)
    assert.equal(installed.has('lodash'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('重复实现：共享目录同名升级为 error，feature 目录同名只告警', () => {
  const shared = findDuplicates(
    [
      { name: 'NoData', file: 'src/components/NoData.vue', line: 1, props: [], emits: [] },
      { name: 'NoData', file: 'src/views/a/NoData.vue', line: 1, props: [], emits: [] },
    ],
    { propOverlap: 0.8, minProps: 2 },
  )
  assert.ok(shared.every((item) => item.ruleId === 'ui/duplicate-name' && item.severity === 'error'))

  const local = findDuplicates(
    [
      { name: 'Card', file: 'src/views/a/Card.vue', line: 1, props: [], emits: [] },
      { name: 'Card', file: 'src/views/b/Card.vue', line: 1, props: [], emits: [] },
    ],
    { propOverlap: 0.8, minProps: 2 },
  )
  assert.ok(local.every((item) => item.ruleId === 'ui/duplicate-name' && item.severity === 'warn'))

  const entry = findDuplicates(
    [
      { name: 'Events', file: 'src/components/events/Events.vue', line: 1, props: [], emits: [] },
      { name: 'Events', file: 'src/components/events/index.vue', line: 1, props: [], emits: [] },
    ],
    { propOverlap: 0.8, minProps: 2 },
  )
  assert.equal(entry.length, 0)
})

test('重复实现：同名报错、props 高重合告警，两侧都能定位', () => {
  const components = [
    { name: 'UserCard', file: 'src/a.vue', line: 1, props: ['title', 'count'], emits: [] },
    { name: 'UserCard', file: 'src/b.vue', line: 1, props: ['name', 'age'], emits: [] },
    { name: 'Profile', file: 'src/c.vue', line: 1, props: ['title', 'count'], emits: [] },
  ]
  const duplicates = findDuplicates(components, { propOverlap: 0.8, minProps: 2 })
  assert.ok(duplicates.some((item) => item.ruleId === 'ui/duplicate-name' && item.file === 'src/a.vue'))
  assert.ok(duplicates.some((item) => item.ruleId === 'ui/duplicate-props' && item.file === 'src/c.vue'))
  assert.ok(duplicates.every((item) => item.fix.includes('.vue')))
})

test('ui_lookup：返回短摘要并限制条数', () => {
  const inventory = {
    components: Array.from({ length: 8 }, (_, index) => ({
      name: `Card${index}`,
      file: `src/Card${index}.vue`,
      props: ['title'],
      emits: ['close'],
    })),
  }
  const result = lookupComponents(inventory, 'card', 5)
  assert.equal(result.total, 8)
  assert.equal(result.matches.length, 5)
  assert.ok(result.matches.every((item) => item.props.length <= 8))
  assert.equal(lookupComponents(inventory, 'nothing').total, 0)
})

test('依赖解析：import/export-from/require 都能抽取，包名归一化正确', () => {
  const imports = extractImports(
    [
      "import dayjs from 'dayjs'",
      "import type { X } from './x'",
      "export { y } from '@/services/y'",
      "const m = require('moment')",
      "const lazy = import('@scope/pkg/sub')",
    ].join('\n'),
  )
  assert.deepEqual(
    imports.map((item) => item.specifier).sort(),
    ['./x', '@/services/y', '@scope/pkg/sub', 'dayjs', 'moment'].sort(),
  )
  assert.equal(packageOf('dayjs/plugin/utc'), 'dayjs')
  assert.equal(packageOf('@scope/pkg/sub'), '@scope/pkg')
  assert.equal(packageOf('./local'), null)
})

test('能力映射：block 命中即禁用，allow 命中是唯一入口', () => {
  const capabilities = {
    date: { allow: ['dayjs'], block: ['moment'], useInstead: 'src/utils/date.ts', example: 'dayjs()' },
    http: { allow: [], block: ['axios'], useInstead: 'src/services/http.ts', example: 'http.get()' },
  }
  assert.equal(capabilityOf('moment', capabilities).blocked, true)
  assert.equal(capabilityOf('dayjs', capabilities).blocked, false)
  assert.equal(capabilityOf('axios', capabilities).blocked, true)
  assert.equal(capabilityOf('lodash', capabilities), null)
})

test('配置：新检查缺席时视为关闭，出现时用默认值补齐', () => {
  const legacy = normalizeConfig({ checks: { eslint: { enabled: true, level: 'error' } } })
  assert.equal(legacy.checks.deps.enabled, false)
  assert.equal(legacy.checks.ui.enabled, false)
  assert.equal(legacy.checks.metrics.enabled, false)
  assert.equal(legacy.checks['diff-size'].enabled, false)

  const enabled = normalizeConfig({
    checks: { deps: { enabled: true }, metrics: { maxFileLines: 120 }, 'diff-size': { enabled: true, maxLines: 10 } },
  })
  assert.deepEqual(enabled.checks.deps.capabilities.date.allow, ['dayjs'])
  assert.equal(enabled.checks.metrics.maxFileLines, 120)
  assert.equal(enabled.checks.metrics.maxFunctionLines, 100)
  assert.equal(enabled.checks['diff-size'].maxLines, 10)
  assert.equal(enabled.checks['diff-size'].maxFiles, 20)
})

test('配置：非法数值与未知检查项都会报错', () => {
  assert.throws(() => normalizeConfig({ checks: { metrics: { maxFileLines: -1 } } }), /maxFileLines/)
  assert.throws(() => normalizeConfig({ checks: { deps: { registry: { x: '' } } } }), /registry\.x/)
  assert.throws(() => normalizeConfig({ checks: { unknown: { enabled: true } } }), /不支持的检查项/)
})

test('值棘轮：只拦变差，修好自动收紧，降到阈值下删除条目', () => {
  const key = baselineKey('src/big.ts', 'metrics/file-lines')
  const metric = (value) => ({ file: 'src/big.ts', ruleId: 'metrics/file-lines', line: null, severity: 'error', value })

  const worse = evaluateRatchets([metric(460)], { [key]: 420 })
  assert.equal(worse.newCount, 1)
  assert.deepEqual(worse.nextRatchets, {})

  const better = evaluateRatchets([metric(380)], { [key]: 420 })
  assert.equal(better.knownCount, 1)
  assert.deepEqual(better.tightened, [{ file: 'src/big.ts', ruleId: 'metrics/file-lines', from: 420, to: 380 }])
  assert.deepEqual(better.nextRatchets, { [key]: 380 })

  const removed = evaluateRatchets([], { [key]: 420 })
  assert.deepEqual(removed.removed, [{ file: 'src/big.ts', ruleId: 'metrics/file-lines', from: 420, to: 0 }])

  const fresh = evaluateRatchets([metric(420)], {})
  assert.equal(fresh.newCount, 1, '没有入账的指标即使等于配置阈值也算新增')
})

test('diff-size 忽略规则：lock 文件、目录通配、扩展名通配', () => {
  assert.equal(matchesIgnore('package-lock.json', ['package-lock.json']), true)
  assert.equal(matchesIgnore('dist/app.js', ['dist/**']), true)
  assert.equal(matchesIgnore('.fe-guard/report.json', ['.fe-guard/**']), true)
  assert.equal(matchesIgnore('src/app.min.js', ['*.min.js']), true)
  assert.equal(matchesIgnore('src/app.ts', ['*.min.js']), false)
  assert.equal(matchesIgnore('src/locales/en/common.ts', ['**/locales/**']), true)
  assert.equal(matchesIgnore('src/globals/axios/index.ts', ['src/globals/axios/**']), true)
  assert.equal(matchesIgnore('src/services/http.ts', ['src/globals/axios/**']), false)
})
