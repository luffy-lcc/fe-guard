/**
 * TypeScript 7 冒烟验证（非 Vue 项目）。
 *
 * 目的：fe-guard 文档声明“非 Vue 项目可以直接使用 TypeScript 7”，
 * 但 TS 7 是 Go 原生编译器，诊断格式若发生漂移，适配器会解析不到任何诊断，
 * 退化成 `typescript/not-executed`。这条脚本用真实安装的 typescript@7 守住这个承诺：
 *   1. 真实安装 typescript@7，跑 fe-guard check，必须解析出 TS2322 且定位到文件与行号；
 *   2. 修掉错误后必须恢复通过（证明不是“永远失败”）；
 *   3. 打印实际 tsc 版本，便于回溯是哪一版 TS 7 通过/失败。
 *
 * 用法: node verify-ts7.mjs   （或 npm run verify:ts7）
 * 依赖: 网络（下载 typescript@7）+ git；不依赖仓库 node_modules。
 * 退出码: 0 = 全部通过，1 = 有失败项。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(ROOT, 'bin', 'fe-guard.js')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let pass = 0
let fail = 0

const line = (text) => console.log(text)
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
  if (result.error) throw new Error(`${command} 无法执行: ${result.error.message}`)
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(' ')} 失败: ${result.stderr || result.stdout}`)
  }
  return result
}

const git = (cwd, args) => sh(cwd, 'git', args)
const cli = (args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { code: result.status ?? 2, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const writeText = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

line('\n== TypeScript 7 冒烟验证（非 Vue） ==')

const app = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-ts7-'))
try {
  writeJson(path.join(app, 'package.json'), { name: 'fe-guard-ts7-smoke', private: true, version: '1.0.0' })
  writeJson(path.join(app, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  })
  writeText(
    path.join(app, 'src/bad.ts'),
    "export const n: number = 'not a number'\nexport function f(a: string): number { return a }\n",
  )
  // 只开 typescript，聚焦“诊断解析”这一件事。
  writeJson(path.join(app, 'fe-guard.config.json'), {
    checks: {
      typescript: { enabled: true, level: 'error' },
    },
  })

  line('  安装 typescript@7 ...')
  const install = sh(app, NPM, ['i', '-D', 'typescript@7', '--no-audit', '--no-fund'], true)
  if (install.status !== 0) {
    check('安装 typescript@7 成功', false, `${install.stderr || install.stdout}`)
    throw new Error('无法安装 typescript@7，跳过后续断言')
  }
  const tsVersion = JSON.parse(readFileSync(path.join(app, 'node_modules/typescript/package.json'), 'utf8')).version
  line(`  实际 tsc 版本: ${tsVersion}`)
  check('安装到 TypeScript 7.x', /^7\./.test(tsVersion), tsVersion)

  git(app, ['init', '-q'])
  git(app, ['config', 'user.email', 'ts7@fe-guard.local'])
  git(app, ['config', 'user.name', 'ts7'])
  git(app, ['add', '-A'])
  git(app, ['commit', '-qm', 'ts7: initial'])

  const first = cli(['check', '--root', app, '--full'])
  const reportFile = path.join(app, '.fe-guard', 'report.json')
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  const tsViolations = report.violations.filter((violation) => violation.ruleId === 'typescript/TS2322')

  check('TS 7 的诊断能被解析（不是 not-executed）', report.violations.every((violation) => !String(violation.ruleId).includes('not-executed')), JSON.stringify(report.violations))
  check('抓到 2 条 TS2322', tsViolations.length === 2, JSON.stringify(tsViolations))
  check('违规定位到文件与行号', tsViolations.every((violation) => violation.file === 'src/bad.ts' && Number.isInteger(violation.line)), JSON.stringify(tsViolations))
  check('存在新增违规时退出码为 1', first.code === 1, `code=${first.code}\n${first.out}`)

  writeText(path.join(app, 'src/bad.ts'), 'export const n: number = 1\nexport function f(a: string): number { return a.length }\n')
  const second = cli(['check', '--root', app, '--full'])
  const after = JSON.parse(readFileSync(reportFile, 'utf8'))
  check('修掉错误后恢复通过', second.code === 0, `code=${second.code}\n${second.out}`)
  check('修复后不再有类型违规', after.violations.every((violation) => !String(violation.ruleId).startsWith('typescript/')), JSON.stringify(after.violations))
} catch (error) {
  fail += 1
  line(`  FAIL  ${error.message}`)
} finally {
  rmSync(app, { recursive: true, force: true })
}

line(`\n== 汇总 ==\n  PASS: ${pass}   FAIL: ${fail}\n`)
if (fail === 0) line('TypeScript 7 冒烟验证全部通过')
process.exit(fail === 0 ? 0 : 1)
