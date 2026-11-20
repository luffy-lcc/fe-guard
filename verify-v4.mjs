#!/usr/bin/env node
/**
 * fe-guard v4 一键验证（真实执行，不只测纯函数）。
 *
 * 覆盖：
 * 1. monorepo：按 package 分别跑 ESLint（各自配置）、缺配置跳过、执行失败暴露、并行耗时；
 * 2. vue-tsc：Vue 工程自动切换，.vue 的 <script setup> 与 <template> 类型错误都能抓到；
 * 3. 类型门禁失效：有 .vue 但 vue-tsc 不可用时必须失败，且不可入 baseline；
 * 4. 首次接入：默认只展示新增、存量给摘要、--all 才展示存量、init 有引导；
 * 5. baseline 治理：--show 分组 + 首次日期、键顺序稳定、--verify 拦截静默放宽、--widen 留痕；
 * 6. 误报闭环：记录原因与时间、可列出/汇总、但不吞掉检查结果。
 *
 * 用法: node verify-v4.mjs   （或 npm run verify:v4 / npm run verify:all）
 * 依赖: 仓库根 npm install 过（vue / vue-tsc / typescript 仅用于验证）
 * 退出码: 0 = 全部通过，1 = 有失败项
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const SAMPLE = path.join(ROOT, 'examples', 'sample-app')
const WORK = path.join(ROOT, '.verify-v4-tmp')

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

function sh(cwd, command, args, allowFail = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(' ')} 失败: ${result.stderr || result.stdout}`)
  }
  return result
}

const git = (cwd, args, allowFail = false) => sh(cwd, 'git', args, allowFail)
const cli = (app, args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: 'utf8' })
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const writeText = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const baselineFileOf = (app) => path.join(app, 'fe-guard.baseline.json')
const reportFileOf = (app) => path.join(app, '.fe-guard', 'report.json')

function freshDir(name) {
  const dir = path.join(WORK, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function initGit(app) {
  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'verify@fe-guard.local'])
  git(app, ['config', 'user.name', 'fe-guard verify'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'verify: initial'])
}

function configOnly(app, checks, extra = {}) {
  const all = {
    eslint: { enabled: false },
    typescript: { enabled: false },
    boundaries: { enabled: false },
    deps: { enabled: false },
    ui: { enabled: false },
    metrics: { enabled: false },
    'diff-size': { enabled: false },
    ...checks,
  }
  writeJson(path.join(app, 'fe-guard.config.json'), { checks: all, ...extra })
}

// ================================================================ 1. monorepo

step('1. monorepo：按 package 各自配置执行，缺配置跳过，失败要暴露')
{
  const app = freshDir('monorepo')
  writeJson(path.join(app, 'package.json'), {
    name: 'monorepo-fixture',
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  })
  writeText(
    path.join(app, 'apps/a/package.json'),
    '{"name":"a","private":true}\n',
  )
  writeText(
    path.join(app, 'apps/a/eslint.config.mjs'),
    "export default [{ files: ['**/*.js'], rules: { eqeqeq: 'error' } }]\n",
  )
  writeText(path.join(app, 'apps/a/src/x.js'), "const value = 1 == '1'\nexport default value\n")

  writeText(
    path.join(app, 'apps/b/package.json'),
    '{"name":"b","private":true}\n',
  )
  writeText(
    path.join(app, 'apps/b/eslint.config.mjs'),
    "export default [{ files: ['**/*.js'], rules: { 'no-unused-vars': 'error' } }]\n",
  )
  writeText(path.join(app, 'apps/b/src/y.js'), 'const unused = 1\nexport default 2\n')

  // 没有 ESLint 配置的 package：应跳过而不是报错。
  writeText(
    path.join(app, 'packages/c/package.json'),
    '{"name":"c","private":true}\n',
  )
  writeText(path.join(app, 'packages/c/src/z.js'), 'export default 1\n')

  configOnly(app, { eslint: { enabled: true, workspace: 'auto' } })
  symlinkSync(path.join(SAMPLE, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  initGit(app)

  const result = cli(app, ['check'])
  const report = readJson(reportFileOf(app))
  const rules = report.violations.map((violation) => violation.ruleId)
  const eslintPkgs = (report.timings?.packages ?? []).filter((pkg) => pkg.check === 'eslint')

  check('识别出 workspace（package.json workspaces）', report.workspace?.isWorkspace === true, JSON.stringify(report.workspace))
  check('识别出 3 个子包（含无配置的 packages/c）', report.workspace?.packages?.length === 3, JSON.stringify(report.workspace?.packages))
  check('package a 用自己的配置命中 eqeqeq', rules.includes('eslint/eqeqeq'), rules.join(', '))
  check('package b 用自己的配置命中 no-unused-vars', rules.includes('eslint/no-unused-vars'), rules.join(', '))
  check('没有根配置硬套产生的 parse-error', !rules.some((rule) => rule.includes('parse-error')), rules.join(', '))
  check('a 的违规路径是仓库相对路径', report.violations.some((v) => v.file === 'apps/a/src/x.js'))
  check('缺配置的 package 被跳过（timings 记录）', eslintPkgs.some((pkg) => pkg.status === 'skipped'), JSON.stringify(eslintPkgs))
  check('两个有配置的 package 都执行了', eslintPkgs.filter((pkg) => pkg.status === 'ok').length === 2, JSON.stringify(eslintPkgs))
  check('报告里记录每个 package 的耗时', eslintPkgs.every((pkg) => Number.isFinite(pkg.ms)), JSON.stringify(eslintPkgs))
  check('stdout 含 workspace 摘要与耗时', /workspace:.*3 个 package/.test(result.out) && /耗时:/.test(result.out), result.out)
  check('存在违规时退出码为 1', result.code === 1, `code=${result.code}\n${result.err}`)
  check('跳过信息出现在 stdout', /已跳过 1 项检查.*packages\/c/.test(result.out), result.out)

  // 有配置但执行失败：必须暴露，不能静默成功。
  const broken = freshDir('monorepo-broken')
  writeJson(path.join(broken, 'package.json'), { name: 'broken', private: true, workspaces: ['apps/*'] })
  writeText(path.join(broken, 'apps/bad/package.json'), '{"name":"bad","private":true}\n')
  writeText(path.join(broken, 'apps/bad/eslint.config.mjs'), "throw new Error('verify boom')\n")
  writeText(path.join(broken, 'apps/bad/src/x.js'), 'export default 1\n')
  configOnly(broken, { eslint: { enabled: true } })
  symlinkSync(path.join(SAMPLE, 'node_modules'), path.join(broken, 'node_modules'), 'dir')
  const brokenResult = cli(broken, ['check'])
  check('子包 ESLint 执行失败时退出码为 2', brokenResult.code === 2, `code=${brokenResult.code}`)
  check('错误信息指出失败的 package', /apps\/bad/.test(brokenResult.err), brokenResult.err)
  check('错误信息不是静默通过', /ESLint/.test(brokenResult.err), brokenResult.err)
}

// ================================================================ 2. vue-tsc

step('2. vue-tsc：.vue 的 script 与 template 类型错误都能抓到')
const VUE_APP = freshDir('vue-app')
{
  const app = VUE_APP
  writeJson(path.join(app, 'package.json'), {
    name: 'vue-fixture',
    private: true,
    dependencies: { vue: '^3.4.0' },
    devDependencies: { 'vue-tsc': '^3.0.0', typescript: '^5.0.0' },
  })
  writeJson(path.join(app, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      jsx: 'preserve',
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    include: ['src/**/*.ts', 'src/**/*.vue'],
  })
  writeText(
    path.join(app, 'src/Bad.vue'),
    `<script setup lang="ts">
const count: number = 'not-a-number'
const props = defineProps<{ label: string }>()
const doubled = computed(() => count * 2)
</script>

<template>
  <div>{{ doubled() }}</div>
  <span>{{ props.label.toFixed(2) }}</span>
</template>
`,
  )
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  configOnly(app, { typescript: { enabled: true, vue: 'auto' } })
  initGit(app)

  const first = cli(app, ['check'])
  const report = readJson(reportFileOf(app))
  const vueViolations = report.violations.filter((violation) => violation.file === 'src/Bad.vue')
  const codes = vueViolations.map((violation) => violation.ruleId)
  check('Vue 工程自动使用 vue-tsc 并失败', first.code === 1, `code=${first.code}\n${first.out}\n${first.err}`)
  check('抓到 <script setup> 里的 TS2322', codes.includes('typescript/TS2322'), codes.join(', '))
  check('抓到 <template> 里的类型错误（非 script 行号）', vueViolations.some((v) => v.line >= 8), JSON.stringify(vueViolations))
  check('诊断定位到 .vue 文件', vueViolations.length >= 2, JSON.stringify(vueViolations))

  // 修掉两个错误后必须恢复通过，证明不是“永远失败”。
  writeText(
    path.join(app, 'src/Bad.vue'),
    `<script setup lang="ts">
const count: number = 2
const props = defineProps<{ label: string }>()
const doubled = () => count * 2
</script>

<template>
  <div>{{ doubled() }}</div>
  <span>{{ props.label.toUpperCase() }}</span>
</template>
`,
  )
  const second = cli(app, ['check'])
  check('修掉 .vue 里的类型错误后通过', second.code === 0, `code=${second.code}\n${second.out}\n${second.err}`)
  check('修复后不再有 .vue 诊断', readJson(reportFileOf(app)).violations.every((v) => v.file !== 'src/Bad.vue'))
}

step('3. 有 .vue 但 vue-tsc 不可用：必须失败且不可入账')
{
  const app = freshDir('vue-missing')
  writeJson(path.join(app, 'package.json'), {
    name: 'vue-missing',
    private: true,
    dependencies: { vue: '^3.4.0' },
  })
  writeJson(path.join(app, 'tsconfig.json'), {
    compilerOptions: { strict: true, noEmit: true, moduleResolution: 'Bundler', module: 'ESNext', target: 'ES2020' },
    include: ['src/**/*.vue'],
  })
  writeText(path.join(app, 'src/App.vue'), '<template><div>hello</div></template>\n')
  configOnly(app, { typescript: { enabled: true, vue: 'auto', bin: 'fe-guard-missing-vue-tsc' } })
  initGit(app)

  const result = cli(app, ['check'])
  const report = readJson(reportFileOf(app))
  const missing = report.violations.find((violation) => violation.ruleId === 'typescript/vue-tsc-missing')
  check('缺少 vue-tsc 时不是静默通过', result.code === 1, `code=${result.code}\n${result.out}`)
  check('产出明确的 vue-tsc-missing 违规', Boolean(missing), JSON.stringify(report.violations))
  check('诊断文案说清“类型检查未生效”和修法', /未生效|没有检查 \.vue/.test(missing?.message ?? '') && /vue-tsc/.test(missing?.fix ?? ''))

  const baselineResult = cli(app, ['baseline', '--widen'])
  const afterBaseline = readJson(reportFileOf(app))
  check('baseline 不会吸收 vue-tsc-missing', baselineResult.code === 0, baselineResult.err)
  check('入账后再次检查仍然失败', cli(app, ['check']).code === 1)
  check('账本里没有 vue-tsc-missing', !JSON.stringify(readJson(baselineFileOf(app))).includes('vue-tsc-missing'))
  check('报告仍列出该问题（只读、不吞）', afterBaseline.violations.some((v) => v.ruleId === 'typescript/vue-tsc-missing'))
}

// ================================================================ 4. 首次接入视图

step('4. 首次接入：默认只看新增，存量给摘要，--all 才展开')
{
  const app = freshDir('first-run')
  writeText(path.join(app, 'src/a.js'), 'const a = 1 == 1\nexport default a\n')
  writeText(path.join(app, 'src/b.js'), 'const b = 2 == 2\nexport default b\n')
  configOnly(app, { eslint: { enabled: true, targets: ['src'] } })
  writeText(
    path.join(app, 'eslint.config.mjs'),
    "export default [{ files: ['**/*.js'], rules: { eqeqeq: 'error' } }]\n",
  )
  symlinkSync(path.join(SAMPLE, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  initGit(app)

  const init = cli(app, ['init'])
  check('init 输出“第一次接入会看到什么”', /第一次接入会看到什么/.test(init.out), init.out)
  check('init 说明误报反馈入口', /false-positive/.test(init.out), init.out)

  const first = cli(app, ['check', '--all'])
  check('未入账时提示首次接入', /第一次接入/.test(first.out) && /baseline/.test(first.out), first.out)

  cli(app, ['baseline'])
  const second = cli(app, ['check'])
  check('入账后通过', second.code === 0, `${second.out}\n${second.err}`)
  check('默认不逐条展示存量（无 [known]）', !second.out.includes('[known]'), second.out)
  check('存量收敛为一行摘要', /存量违规 2 条/.test(second.out) && /默认不逐条展示/.test(second.out), second.out)
  check('提示如何查看全量与按文件明细', /--all/.test(second.out) && /baseline --show/.test(second.out), second.out)

  const all = cli(app, ['check', '--all'])
  check('--all 才逐条展示存量', all.out.includes('[known]'), all.out)
}

// ================================================================ 5. baseline 治理

step('5. baseline：分组展示、首次日期、键序稳定、--verify 拦截静默放宽')
{
  const app = freshDir('baseline-governance')
  writeText(path.join(app, 'src/x.js'), 'const x = 1 == 1\nexport default x\n')
  writeText(path.join(app, 'src/y.js'), 'const y = 2 == 2\nexport default y\n')
  configOnly(app, { eslint: { enabled: true, targets: ['src'] } })
  writeText(
    path.join(app, 'eslint.config.mjs'),
    "export default [{ files: ['**/*.js'], rules: { eqeqeq: 'error' } }]\n",
  )
  symlinkSync(path.join(SAMPLE, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  initGit(app)

  cli(app, ['baseline'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'chore: baseline'])

  const show = cli(app, ['baseline', '--show'])
  check('--show 按文件分组', /src\/x\.js/.test(show.out) && /src\/y\.js/.test(show.out), show.out)
  check('--show 列出规则、数量、首次入账日期', /eslint\/eqeqeq\s+1 条，首次 \d{4}-\d{2}-\d{2}/.test(show.out), show.out)

  const bytesBefore = readFileSync(baselineFileOf(app), 'utf8')
  cli(app, ['baseline'])
  const bytesAfter = readFileSync(baselineFileOf(app), 'utf8')
  check('重复 baseline 不产生无意义变动（键序稳定）', bytesBefore === bytesAfter)

  const verifyOk = cli(app, ['baseline', '--verify', '--base', 'HEAD'])
  check('--verify 对未放宽的账本通过', verifyOk.code === 0, verifyOk.out)

  // 静默放宽：直接改大数量，不带 --widen，也没有 widenLog。
  const silent = readJson(baselineFileOf(app))
  silent.entries['src/x.js']['eslint/eqeqeq'] = 3
  writeJson(baselineFileOf(app), silent)
  const verifyBad = cli(app, ['baseline', '--verify', '--base', 'HEAD'])
  check('--verify 拦截静默放宽', verifyBad.code === 1, verifyBad.out)
  check('失败信息指出具体条目', /src\/x\.js/.test(verifyBad.out) && /eqeqeq/.test(verifyBad.out), verifyBad.out)
  git(app, ['checkout', '--', 'fe-guard.baseline.json'])

  // 真实新增一条同规则违规，再 --widen：应留下 widen 记录并通过 verify。
  writeText(path.join(app, 'src/x.js'), 'const x = 1 == 1\nconst z = 3 == 3\nexport default x + z\n')
  const afterChange = cli(app, ['check'])
  check('新增同规则违规时检查失败', afterChange.code === 1, afterChange.out)
  const widen = cli(app, ['baseline', '--widen'])
  const widened = readJson(baselineFileOf(app))
  check('--widen 成功并留痕', widen.code === 0 && widened.widenLog?.some((event) => event.type === 'widen'), JSON.stringify(widened.widenLog))
  const verifyWide = cli(app, ['baseline', '--verify', '--base', 'HEAD'])
  check('登记过的放宽能通过 --verify', verifyWide.code === 0, verifyWide.out)
}

// ================================================================ 6. 误报闭环

step('6. 误报反馈：可记录、可审计、可汇总，但不吞掉结果')
{
  const app = freshDir('feedback')
  writeText(path.join(app, 'src/x.js'), 'const x = 1 == 1\nexport default x\n')
  configOnly(app, { eslint: { enabled: true, targets: ['src'] } })
  writeText(
    path.join(app, 'eslint.config.mjs'),
    "export default [{ files: ['**/*.js'], rules: { eqeqeq: 'error' } }]\n",
  )
  symlinkSync(path.join(SAMPLE, 'node_modules'), path.join(app, 'node_modules'), 'dir')
  initGit(app)
  cli(app, ['baseline'])

  const added = cli(app, [
    'false-positive',
    '--file',
    'src/x.js',
    '--line',
    '1',
    '--rule',
    'eslint/eqeqeq',
    '--reason',
    '这里比较的是用户输入的字符串表单',
  ])
  const auditFile = path.join(app, '.fe-guard', 'false-positives.jsonl')
  check('误报命令成功', added.code === 0, added.out + added.err)
  check('记录文件存在且是一行 JSONL', existsSync(auditFile) && readFileSync(auditFile, 'utf8').trim().split('\n').length === 1)
  const record = JSON.parse(readFileSync(auditFile, 'utf8').trim())
  check('记录含时间、文件、规则、检查项、原因', Boolean(record.at && record.file && record.ruleId && record.check) && /用户输入/.test(record.reason), JSON.stringify(record))

  const missingReason = cli(app, ['false-positive', '--file', 'src/x.js', '--rule', 'eslint/eqeqeq'])
  check('没有原因时拒绝记录', missingReason.code === 2, missingReason.err)

  cli(app, [
    'false-positive',
    '--file',
    'src/y.js',
    '--rule',
    'eslint/eqeqeq',
    '--reason',
    '同类误判，用于验证汇总',
  ])
  const summary = cli(app, ['false-positive', '--summary'])
  check('汇总列出误报最多的规则', /eslint\/eqeqeq\s+2 条/.test(summary.out), summary.out)
  check('汇总列出检查项维度', /eslint\s+2 条/.test(summary.out), summary.out)
  check('汇总明确“不会自动忽略”', /不会自动忽略/.test(summary.out), summary.out)

  const listed = cli(app, ['false-positive', '--list'])
  check('--list 展示原因与时间', /理由: 这里比较的是用户输入的字符串表单/.test(listed.out) && /\d{4}-\d{2}-\d{2}/.test(listed.out), listed.out)

  const checked = cli(app, ['check'])
  const report = readJson(reportFileOf(app))
  check('标记误报后检查结果不被吞掉', checked.code === 0 && report.summary.known === 1, JSON.stringify(report.summary))
}

// ================================================================ 汇总

line('\n== 汇总 ==')
line(`  PASS: ${pass}   FAIL: ${fail}`)
if (fail > 0) {
  line(`\n验证失败：${fail} 项不符合预期`)
  process.exit(1)
}
line('\nv4 验证全部通过')
