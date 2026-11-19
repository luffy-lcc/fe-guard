import { readFileSync } from 'node:fs'
import path from 'node:path'
import { matchesIgnore, walkSourceFiles } from '../utils.js'
import { countAny, countLines, duplicationScores, functionLengths } from '../metrics.js'

export const id = 'metrics'

const round = (value) => Math.round(value * 1000) / 1000

/** 最长目录前缀匹配 overrides：与 workspace 识别解耦，monorepo / 单仓库都可用。 */
function resolveFor(file, check) {
  const overrides = check.overrides ?? {}
  let best = null
  for (const prefix of Object.keys(overrides)) {
    if ((file === prefix || file.startsWith(`${prefix}/`)) && (!best || prefix.length > best.length)) best = prefix
  }
  if (!best) return check
  const override = overrides[best]
  return { ...check, ...override, duplication: { ...check.duplication, ...(override.duplication ?? {}) } }
}

/**
 * 腐化指标。每条违规都带 value，check-core 会把它交给“值棘轮”：
 * 只拦“比 baseline 记录的更差”，存量入账后不会全红。
 */
export async function runCheck({ root, check, changedFiles }) {
  const files = walkSourceFiles(root, { roots: check.roots, extensions: check.extensions })
  const contents = files.map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') }))
  const duplication = duplicationScores(contents, check.duplication)
  const scope = changedFiles ? new Set(changedFiles) : null

  const violations = []
  for (const { file, text } of contents) {
    if (scope && !scope.has(file)) continue
    const thresholds = resolveFor(file, check)

    const lines = countLines(text)
    if (lines > thresholds.maxFileLines) {
      violations.push({
        ruleId: 'metrics/file-lines',
        file,
        line: null,
        severity: 'error',
        value: lines,
        message: `文件 ${lines} 行，超过阈值 ${thresholds.maxFileLines}。单文件失控通常不是一次写出来的，而是每次追加一点。`,
        fix: `按职责拆文件（例如把纯函数移到 src/utils/），或先抽走与本次需求无关的代码；拆不动时在 PR 说明里写清原因。`,
      })
    }

    const longest = functionLengths(text)[0]
    if (longest && longest.lines > thresholds.maxFunctionLines) {
      violations.push({
        ruleId: 'metrics/function-lines',
        file,
        line: longest.startLine,
        severity: 'error',
        value: longest.lines,
        message: `最长函数 ${longest.name}() ${longest.lines} 行，超过阈值 ${thresholds.maxFunctionLines}。长函数是“AI 一次生成一大段”的典型痕迹。`,
        fix: '按输入/计算/输出拆成小函数；纯逻辑移到可单测的模块。',
      })
    }

    const anyCount = countAny(text)
    if (anyCount > thresholds.maxAny) {
      violations.push({
        ruleId: 'metrics/any',
        file,
        line: null,
        severity: 'error',
        value: anyCount,
        message: `显式 any ${anyCount} 处，超过阈值 ${thresholds.maxAny}。any 会让 tsc 和后续改动都失去保护。`,
        fix: '补具体类型；暂时未知用 unknown 并在边界处收窄，不要用 any 绕过类型检查。',
      })
    }

    const score = duplication.get(file)
    if (score && score.ratio > thresholds.duplication.maxRatio && !matchesIgnore(file, check.duplication.ignore)) {
      const percent = (score.ratio * 100).toFixed(1)
      const other = score.otherFile && score.otherFile !== file ? `，最像 ${score.otherFile}` : ''
      violations.push({
        ruleId: 'metrics/duplication',
        file,
        line: null,
        severity: 'error',
        value: round(score.ratio),
        message: `重复 token 块占比 ${percent}%（阈值 ${(thresholds.duplication.maxRatio * 100).toFixed(0)}%）${other}。`,
        fix: `把重复块抽成共享实现（优先放进 src/utils/ 或已有封装），另一处改为引用。`,
      })
    }
  }
  return violations
}
