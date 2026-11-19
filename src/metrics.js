/**
 * 腐化指标的纯函数实现（零依赖）。
 *
 * 选择自实现而不是引入 jscpd / ts-morph 之类：
 * - 只有“重复 token 块比例”需要专门算法，n-gram 哈希 30 行就够；
 * - 引入解析器会把安装体积和 Node 版本要求一起抬高，而这里只需要“相对变化”的趋势，
 *   不需要精确到 AST。代价写在 README 的检测边界里。
 */

const STRING_OR_COMMENT = [
  /\/\*[\s\S]*?\*\//g,
  /\/\/[^\n]*/g,
  /'(?:\\.|[^'\\])*'/g,
  /"(?:\\.|[^"\\])*"/g,
  /`(?:\\.|[^`\\])*`/g,
]

/** 归一化时保留的关键字/字面量：它们是结构，不是名字。 */
const KEEP_TOKENS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'function', 'return', 'const', 'let', 'var', 'class', 'extends', 'super', 'this',
  'new', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
  'import', 'export', 'from', 'default', 'async', 'await', 'yield',
  'try', 'catch', 'finally', 'throw', 'true', 'false', 'null', 'undefined',
])

/**
 * 去掉注释和字符串内容，再切成 token。字符串统一成 "S"，避免文案差异造成假重复。
 * normalizeIdentifiers（可选）：非关键字标识符按文件内首次出现顺序映射成 @1/@2…，
 * 让「复制后改名」的重复也能命中；代价是结构相同但语义不同的代码会被视为重复。
 */
export function tokenize(text, { normalizeIdentifiers = false } = {}) {
  let cleaned = String(text)
  for (const pattern of STRING_OR_COMMENT) cleaned = cleaned.replace(pattern, ' "S" ')
  const tokens = cleaned.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/g) ?? []
  if (!normalizeIdentifiers) return tokens
  const ids = new Map()
  return tokens.map((token) => {
    if (!/^[A-Za-z_$]/.test(token) || KEEP_TOKENS.has(token)) return token
    if (!ids.has(token)) ids.set(token, `@${ids.size + 1}`)
    return ids.get(token)
  })
}

export function countLines(text) {
  const value = String(text)
  if (value.length === 0) return 0
  return value.split('\n').length
}

/** 统计显式 any：`: any`、`as any`、`<any>`、`any[]`。 */
export function countAny(text) {
  const matches = String(text).match(/(?::\s*any\b|\bas\s+any\b|<\s*any\s*>|\bany\s*\[\s*\])/g)
  return matches?.length ?? 0
}

const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else', 'try', 'with',
])

/**
 * 找出函数并计算行数（含签名到右花括号）。用花括号配对，不解析 AST：
 * - 只认 function 声明、const/let 箭头函数、类/对象里的方法简写；
 * - 嵌套函数各自计算，最长的那条代表这个文件。
 */
export function functionLengths(text) {
  const source = String(text)
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)?\s*\([^)]*\)[^{;]*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
    /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
  ]
  const results = []
  const seen = new Set()
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1] ?? '(anonymous)'
      if (CONTROL_KEYWORDS.has(name)) continue
      const brace = source.indexOf('{', match.index + match[0].length - 1)
      if (brace === -1 || seen.has(brace)) continue
      seen.add(brace)
      const end = matchBrace(source, brace)
      if (end === -1) continue
      const lines = source.slice(brace, end + 1).split('\n').length
      const startLine = source.slice(0, match.index).split('\n').length
      results.push({ name, lines, startLine })
    }
  }
  return results.sort((a, b) => b.lines - a.lines)
}

function matchBrace(source, start) {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function scriptPortion(file, text) {
  if (!String(file).endsWith('.vue')) return String(text)
  const blocks = [...String(text).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  return blocks.join('\n')
}

/**
 * 跨文件重复块检测：把每个文件切成固定长度的 token 窗口，
 * 同一个窗口出现在 ≥2 个文件才算重复（同文件内部重复多半是循环/模板展开，噪声大）。
 *
 * Vue 文件只比较 <script> 部分：模板里的组件堆叠天然相似，算进来会让几乎所有页面都“重复”。
 */
export function duplicationScores(files, { windowTokens = 50, minTokens = 200, normalizeIdentifiers = false } = {}) {
  const tokenized = files.map((file) => ({
    file: file.file,
    tokens: tokenize(scriptPortion(file.file, file.text), { normalizeIdentifiers }),
  }))
  const windows = new Map()

  for (const { file, tokens } of tokenized) {
    if (tokens.length < minTokens || tokens.length < windowTokens) continue
    const total = tokens.length - windowTokens + 1
    for (let index = 0; index < total; index += 1) {
      const key = tokens.slice(index, index + windowTokens).join(' ')
      const entry = windows.get(key) ?? new Set()
      entry.add(file)
      windows.set(key, entry)
    }
  }

  const duplicated = new Set()
  const samples = new Map()
  for (const [key, filesHere] of windows) {
    if (filesHere.size < 2) continue
    duplicated.add(key)
    for (const file of filesHere) {
      if (samples.has(file)) continue
      samples.set(file, [...filesHere].find((item) => item !== file) ?? file)
    }
  }

  const scores = new Map()
  for (const { file, tokens } of tokenized) {
    if (tokens.length < minTokens || tokens.length < windowTokens) {
      scores.set(file, { ratio: 0, otherFile: null, tokens: tokens.length })
      continue
    }
    const total = tokens.length - windowTokens + 1
    let hit = 0
    for (let index = 0; index < total; index += 1) {
      const key = tokens.slice(index, index + windowTokens).join(' ')
      if (duplicated.has(key)) hit += 1
    }
    scores.set(file, { ratio: total > 0 ? hit / total : 0, otherFile: samples.get(file) ?? null, tokens: tokens.length })
  }
  return scores
}
