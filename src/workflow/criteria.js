import { checkTestFile } from './tests.js'

/** 验收条件的类型：要求每条条件写出处与类型。 */
export const CRITERION_TYPES = ['ui', 'interaction', 'data', 'tracking', 'compat', 'performance']

/** 验收方式：门禁证据 / 真实测试 / 手工证据。 */
export const VERIFY_MODES = ['gate', 'test', 'manual']

const ALLOWED_FIELDS = ['id', 'text', 'type', 'source', 'verify', 'testFile', 'evidenceFile']
const MAX_ITEMS = 20

const clip = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

const isText = (value) => typeof value === 'string' && value.trim().length > 0

/** source 以 assumption 开头的条件属于推断项，交付前必须由人确认。 */
export function isAssumption(source) {
  return typeof source === 'string' && /^assumption\b/i.test(source.trim())
}

/** 验收方式缺省时按字段推断：testFile → test、evidenceFile → manual、否则 gate。 */
export function verifyMode(criterion) {
  if (criterion?.verify) return criterion.verify
  if (criterion?.testFile) return 'test'
  if (criterion?.evidenceFile) return 'manual'
  return 'gate'
}

/** 按类型统计条件数量；历史事件缺少 type 的归入 unknown。 */
export function countByType(criteria = []) {
  const counts = {}
  for (const criterion of criteria) {
    const key = isText(criterion?.type) ? criterion.type.trim() : 'unknown'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * 校验并归一化一批验收条件。
 * 抛出普通 Error（中文文案），由 tools.js 统一转成 ToolError。
 * `nextIndex` 既接受 { value } 游标，也接受数字起始值。
 */
export function normalizeCriteriaList({ items, existingIds = new Set(), nextIndex = { value: 0 } } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('task_criteria 需要非空的 criteria 数组')
  }
  if (items.length > MAX_ITEMS) throw new Error(`一次最多写入 ${MAX_ITEMS} 条验收条件`)

  const ids = existingIds instanceof Set ? existingIds : new Set(existingIds ?? [])
  const cursor = nextIndex && typeof nextIndex === 'object' ? nextIndex : { value: Number(nextIndex) || 0 }
  return items.map((item, index) => normalizeCriterion(item, index, ids, cursor))
}

function normalizeCriterion(item, index, ids, cursor) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`第 ${index + 1} 条验收条件必须是对象`)
  }
  const extra = Object.keys(item).filter((key) => !ALLOWED_FIELDS.includes(key))
  if (extra.length > 0) {
    throw new Error(
      `验收条件不接受字段 ${extra.join(', ')}：条件是否达成由门禁证据推导，模型不能自行标记为达成。`,
    )
  }
  if (!isText(item.text)) throw new Error('每条验收条件都需要非空 text')

  const type = isText(item.type) ? item.type.trim() : ''
  if (!type) throw new Error(`每条验收条件都需要 type：${CRITERION_TYPES.join(' / ')}`)
  if (!CRITERION_TYPES.includes(type)) {
    throw new Error(`验收条件 type 只能是 ${CRITERION_TYPES.join(' / ')}，当前为 "${type}"`)
  }

  const source = clip(item.source, 200)
  if (!source) {
    throw new Error('每条验收条件都需要 source：写明需求/设计稿/代码出处；无法确认的写 assumption: 原因')
  }

  const hasTest = item.testFile !== undefined
  const hasEvidence = item.evidenceFile !== undefined
  if (hasTest && hasEvidence) {
    throw new Error('验收条件不能同时提供 testFile 与 evidenceFile：请按验收方式二选一')
  }

  let verify
  if (item.verify !== undefined) {
    verify = isText(item.verify) ? item.verify.trim() : ''
    if (!VERIFY_MODES.includes(verify)) {
      throw new Error(`验收条件 verify 只能是 ${VERIFY_MODES.join(' / ')}，当前为 "${item.verify}"`)
    }
  } else {
    verify = hasTest ? 'test' : hasEvidence ? 'manual' : 'gate'
  }

  if (verify === 'test' && !hasTest) throw new Error('verify=test 必须提供 testFile')
  if (verify === 'manual' && !hasEvidence) throw new Error('verify=manual 必须提供 evidenceFile')
  if (verify === 'gate' && hasTest) throw new Error('verify=gate 不接受 testFile；要跑测试请用 verify=test')
  if (verify === 'gate' && hasEvidence) {
    throw new Error('verify=gate 不接受 evidenceFile；要手工证据请用 verify=manual')
  }

  const testFile = hasTest ? checkRelativePath('testFile', item.testFile) : undefined
  const evidenceFile = hasEvidence ? checkRelativePath('evidenceFile', item.evidenceFile) : undefined

  let id = item.id === undefined ? '' : typeof item.id === 'string' ? item.id.trim() : null
  if (id === null) throw new Error('验收条件 id 必须是字符串')
  if (id && !/^[A-Za-z0-9_-]{1,16}$/.test(id)) {
    throw new Error(`验收条件 id "${id}" 不合法（1-16 位字母数字下划线）`)
  }
  if (!id) {
    do {
      cursor.value += 1
      id = `C${cursor.value}`
    } while (ids.has(id))
  }
  if (ids.has(id)) throw new Error(`验收条件 id "${id}" 重复`)
  ids.add(id)

  return {
    id,
    text: clip(item.text, 200),
    type,
    source,
    verify,
    ...(testFile ? { testFile } : {}),
    ...(evidenceFile ? { evidenceFile } : {}),
  }
}

/** testFile / evidenceFile 共用同一套相对路径校验，只替换报错里的字段名。 */
function checkRelativePath(field, value) {
  try {
    return checkTestFile(value)
  } catch (error) {
    throw new Error(error.message.replaceAll('testFile', field))
  }
}
