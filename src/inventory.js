import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { UserError, readJsonFile, walkSourceFiles, writeJsonFile } from './utils.js'

export const INVENTORY_VERSION = 1

const JSX_EXTENSIONS = ['.tsx', '.jsx']
const VUE_EXTENSIONS = ['.vue']

/** 文件名 → 组件名：UserCard.vue 保持，user-card.vue → UserCard，index.vue → 父目录名。 */
export function componentNameFromFile(file) {
  const extension = path.posix.extname(file)
  let base = path.posix.basename(file, extension)
  if (/^index$/i.test(base)) {
    // src/components/events/index.vue → Events，避免所有 index 都叫 Index。
    const parent = path.posix.basename(path.posix.dirname(file))
    if (parent && parent !== '.' && parent !== 'src') base = parent
  }
  if (/^[A-Z]/.test(base)) return base
  return base
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function uniqSorted(values) {
  return [...new Set(values.filter(Boolean))].sort()
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function keysOfTypeLiteral(source) {
  return [...source.matchAll(/(?:^|[{,;\n])\s*([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((match) => match[1])
}

function stringsIn(source) {
  return [...source.matchAll(/['"]([\w$-]+)['"]/g)].map((match) => match[1])
}

function parseVue(text, file) {
  const nameMatch =
    text.match(/defineOptions\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"]([\w$-]+)['"]/) ??
    text.match(/export\s+default\s*\{[\s\S]*?\bname\s*:\s*['"]([\w$-]+)['"]/)
  const name = nameMatch?.[1] ?? componentNameFromFile(file)

  let props = []
  const propGeneric = text.match(/defineProps\s*<\s*([\s\S]*?)\s*>\s*\(\s*\)/)
  if (propGeneric) {
    props = keysOfTypeLiteral(propGeneric[1])
  } else {
    const propArray = text.match(/defineProps\s*\(\s*\[([\s\S]*?)\]\s*\)/)
    if (propArray) props = stringsIn(propArray[1])
    else {
      const propObject = text.match(/defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/)
      if (propObject) props = keysOfTypeLiteral(propObject[1])
    }
  }

  let emits = []
  const emitGeneric = text.match(/defineEmits\s*<\s*([\s\S]*?)\s*>\s*\(\s*\)/)
  if (emitGeneric) {
    emits = [...emitGeneric[1].matchAll(/\be\s*:\s*['"]([\w-]+)['"]/g)].map((match) => match[1])
  } else {
    const emitCall = text.match(/defineEmits\s*\(([\s\S]*?)\)/)
    if (emitCall) emits = stringsIn(emitCall[1])
  }

  const scriptIndex = text.indexOf('<script')
  return {
    name,
    file,
    kind: 'vue',
    line: scriptIndex === -1 ? 1 : lineOf(text, scriptIndex),
    props: uniqSorted(props),
    emits: uniqSorted(emits),
  }
}

function parseJsx(text, file) {
  const declaration =
    text.match(/export\s+(?:default\s+)?function\s+([A-Za-z_$][\w$]*)/) ??
    text.match(/export\s+(?:default\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::|=)/)
  if (!declaration) return null
  const name = declaration[1]
  if (!/^[A-Z]/.test(name)) return null

  const after = text.slice(declaration.index)
  const params = after.match(/\(([^)]*)\)/)
  let props = []
  const paramText = params?.[1] ?? ''
  const inline = paramText.match(/\{([\s\S]*)\}/)
  if (inline) props = keysOfTypeLiteral(inline[1])
  else {
    const typeName = paramText.match(/\b(?:props\s*:\s*)?([A-Za-z_$][\w$]*)\s*$/)
    if (typeName) {
      const shape =
        text.match(new RegExp(`interface\\s+${typeName[1]}\\s*\\{([\\s\\S]*?)\\}`)) ??
        text.match(new RegExp(`type\\s+${typeName[1]}\\s*=\\s*\\{([\\s\\S]*?)\\}`))
      if (shape) props = keysOfTypeLiteral(shape[1])
    }
  }

  return {
    name,
    file,
    kind: file.endsWith('.tsx') ? 'tsx' : 'jsx',
    line: lineOf(text, declaration.index),
    props: uniqSorted(props),
    emits: [],
  }
}

/** 从单个文件提取组件；不是组件就返回 null。 */
export function extractComponent(text, file) {
  const extension = path.posix.extname(file)
  if (VUE_EXTENSIONS.includes(extension)) return parseVue(text, file)
  if (JSX_EXTENSIONS.includes(extension)) return parseJsx(text, file)
  return null
}

/** 扫描源码目录，得到完整组件清单。 */
export function collectComponents(root, { roots = ['src'], extensions } = {}) {
  const allowed = extensions ?? [...VUE_EXTENSIONS, ...JSX_EXTENSIONS]
  const files = walkSourceFiles(root, {
    roots,
    extensions: allowed.filter((extension) => VUE_EXTENSIONS.includes(extension) || JSX_EXTENSIONS.includes(extension)),
  })
  const components = []
  for (const file of files) {
    // Storybook story / 测试文件里的 Default、Primary 是故事或断言，不是业务组件。
    if (isStoryOrTest(file)) continue
    const text = readFileSync(path.join(root, file), 'utf8')
    const component = extractComponent(text, file)
    if (component) components.push(component)
  }
  return components.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** stories / 测试目录与同名的 *.stories / *.test / *.spec 文件不参与组件清单与重名检测。 */
export function isStoryOrTest(file) {
  return (
    /(^|\/)(__tests__|__mocks__|e2e)\//.test(file) ||
    /\.(stories|story|test|spec)\.[^/]+$/.test(file)
  )
}

export function buildInventory(root, uiConfig) {
  return {
    version: INVENTORY_VERSION,
    generatedAt: new Date().toISOString(),
    components: collectComponents(root, { roots: uiConfig?.roots, extensions: uiConfig?.extensions }),
  }
}

export function readInventory(file) {
  if (!existsSync(file)) return null
  const raw = readJsonFile(file, {})
  if (!Array.isArray(raw.components)) throw new UserError(`${file} 格式损坏：缺少 components 数组`)
  return raw
}

export function writeInventory(root, relative, inventory) {
  writeJsonFile(path.join(root, relative), inventory)
  return relative
}

/**
 * 同名组件的严重级别：
 * - 任意一方在共享组件目录（src/components/，或 app 根的 components/）→ error；
 * - 两边都在 feature 目录（包括 views/x/components/）→ warn，业务分区同名很常见，误伤成本高。
 */
function nameSeverity(a, b) {
  const shared = (file) => {
    const parts = file.split('/')
    if (parts[0] === 'components') return true
    const index = parts.lastIndexOf('src')
    return index >= 0 && parts[index + 1] === 'components'
  }
  return shared(a.file) || shared(b.file) ? 'error' : 'warn'
}

function jaccard(a, b) {
  const left = new Set(a)
  const right = new Set(b)
  const intersection = [...left].filter((item) => right.has(item))
  const union = new Set([...left, ...right])
  return union.size === 0 ? 0 : intersection.length / union.size
}

function isEntryFile(file) {
  return /(^|\/)index\.(vue|tsx|jsx)$/.test(file)
}

/**
 * 重复实现检测（启发式）：
 * - 同名：两个不同文件导出同名组件（index.* 入口文件不参与，避免“入口包一层同名组件”误报）；
 * - 高重合 props：两边 props 都 ≥ minProps，且 Jaccard 相似度 ≥ propOverlap。
 * 只比较“清单里的组件”，命中后由调用方决定是否在本次改动范围内上报。
 */
export function findDuplicates(components, { propOverlap = 0.8, minProps = 2 } = {}) {
  const results = []
  const seen = new Set()
  const push = (item) => {
    const key = `${item.file}::${item.ruleId}::${item.otherFile}`
    if (seen.has(key)) return
    seen.add(key)
    results.push(item)
  }

  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      const a = components[left]
      const b = components[right]
      if (a.file === b.file) continue
      if (isEntryFile(a.file) || isEntryFile(b.file)) continue

      if (a.name === b.name) {
        const severity = nameSeverity(a, b)
        push({
          file: a.file,
          line: a.line,
          ruleId: 'ui/duplicate-name',
          severity,
          message: `组件名 "${a.name}" 与 ${b.file} 重名。重造一个同名组件会让引用和排查都变混乱。`,
          fix: `先复用 ${b.file}；确属不同职责请改名（例如 ${a.name}Compact）并在提交说明里写清差异。`,
          otherFile: b.file,
        })
        push({
          file: b.file,
          line: b.line,
          ruleId: 'ui/duplicate-name',
          severity,
          message: `组件名 "${b.name}" 与 ${a.file} 重名。`,
          fix: `先复用 ${a.file}；确属不同职责请改名并在提交说明里写清差异。`,
          otherFile: a.file,
        })
        continue
      }

      if (a.props.length < minProps || b.props.length < minProps) continue
      const similarity = jaccard(a.props, b.props)
      if (similarity < propOverlap) continue
      const shared = a.props.filter((prop) => b.props.includes(prop))
      push({
        file: a.file,
        line: a.line,
        ruleId: 'ui/duplicate-props',
        severity: 'warn',
        message: `组件 ${a.name} 与 ${b.file} 的 ${b.name} props 重合 ${shared.length} 个（${shared.slice(0, 6).join(', ')}），相似度 ${(similarity * 100).toFixed(0)}%。`,
        fix: `优先复用 ${b.file}；如果只是外观差异，用 props/插槽扩展它，而不是复制一份。`,
        otherFile: b.file,
      })
      push({
        file: b.file,
        line: b.line,
        ruleId: 'ui/duplicate-props',
        severity: 'warn',
        message: `组件 ${b.name} 与 ${a.file} 的 ${a.name} props 重合 ${shared.length} 个，相似度 ${(similarity * 100).toFixed(0)}%。`,
        fix: `优先复用 ${a.file}；确需独立实现请在提交说明里写清差异。`,
        otherFile: a.file,
      })
    }
  }
  return results
}

/** MCP ui_lookup 用：按名称/文件/关键词过滤，返回尽量短的摘要。 */
export function lookupComponents(inventory, query, limit = 5) {
  const text = String(query ?? '').trim().toLowerCase()
  const components = inventory?.components ?? []
  const matches = text
    ? components.filter((component) =>
        [component.name, component.file, ...(component.props ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(text),
      )
    : components
  return {
    total: matches.length,
    matches: matches.slice(0, limit).map((component) => ({
      name: component.name,
      file: component.file,
      props: (component.props ?? []).slice(0, 8),
      emits: (component.emits ?? []).slice(0, 8),
    })),
  }
}
