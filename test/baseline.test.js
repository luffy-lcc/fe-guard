import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  baselineKey,
  countByKey,
  evaluate,
  loadBaseline,
  partitionEntries,
  sameEntries,
  saveBaseline,
  toDiskShape,
} from '../src/baseline.js'

function violation(file, ruleId, line = 1, message = 'x') {
  return { file, ruleId, line, severity: 'error', message, fix: null }
}

test('空 baseline：所有违规都是新增，check 不会自动把它们吸收进 baseline', () => {
  const result = evaluate([violation('a.ts', 'eslint/eqeqeq'), violation('a.ts', 'eslint/eqeqeq', 2)], {})
  assert.equal(result.newCount, 2)
  assert.equal(result.knownCount, 0)
  // 想接受这批欠债必须显式运行 fe-guard baseline，check 只收紧、不扩额。
  assert.deepEqual(result.nextEntries, {})
})

test('存量违规在允许条数内：判定为 known，不写回变化', () => {
  const entries = { [baselineKey('a.ts', 'eslint/eqeqeq')]: 2 }
  const result = evaluate([violation('a.ts', 'eslint/eqeqeq'), violation('a.ts', 'eslint/eqeqeq', 5)], entries)
  assert.equal(result.newCount, 0)
  assert.equal(result.knownCount, 2)
  assert.deepEqual(result.nextEntries, entries)
})

test('超出允许条数：多余部分判为新增，且 nextEntries 不会把允许条数调大', () => {
  const entries = { [baselineKey('a.ts', 'eslint/eqeqeq')]: 1 }
  const result = evaluate(
    [violation('a.ts', 'eslint/eqeqeq', 1), violation('a.ts', 'eslint/eqeqeq', 9)],
    entries,
  )
  assert.equal(result.knownCount, 1)
  assert.equal(result.newCount, 1)
  assert.deepEqual(result.nextEntries, entries)
})

test('修掉一条存量违规：通过并自动收紧', () => {
  const entries = { [baselineKey('a.ts', 'eslint/eqeqeq')]: 3 }
  const result = evaluate([violation('a.ts', 'eslint/eqeqeq')], entries)
  assert.equal(result.newCount, 0)
  assert.deepEqual(result.tightened, [{ file: 'a.ts', ruleId: 'eslint/eqeqeq', from: 3, to: 1 }])
  assert.deepEqual(result.nextEntries, { [baselineKey('a.ts', 'eslint/eqeqeq')]: 1 })
})

test('存量全部修掉：条目从 baseline 删除（收紧到 0）', () => {
  const entries = { [baselineKey('a.ts', 'eslint/eqeqeq')]: 2, [baselineKey('b.ts', 'eslint/eqeqeq')]: 1 }
  const result = evaluate([violation('b.ts', 'eslint/eqeqeq')], entries)
  assert.deepEqual(result.removed, [{ file: 'a.ts', ruleId: 'eslint/eqeqeq', from: 2, to: 0 }])
  assert.deepEqual(result.nextEntries, { [baselineKey('b.ts', 'eslint/eqeqeq')]: 1 })
})

test('同一文件内修一条旧违规、加一条新规则违规：文件总数不变，但仍必须判为新增', () => {
  // 旧状态：a.ts 有 2 条 eqeqeq。修掉 1 条 eqeqeq，同时新增 1 条 no-unused-vars。
  const entries = { [baselineKey('a.ts', 'eslint/eqeqeq')]: 2 }
  const result = evaluate(
    [violation('a.ts', 'eslint/eqeqeq', 3), violation('a.ts', 'eslint/no-unused-vars', 8)],
    entries,
  )

  const perFileTotal = result.violations.length
  assert.equal(perFileTotal, 2, '文件级总数与 baseline 总数相同，只记总数会漏判')

  assert.equal(result.newCount, 1)
  const fresh = result.violations.find((item) => item.status === 'new')
  assert.equal(fresh.ruleId, 'eslint/no-unused-vars')
  assert.deepEqual(result.tightened, [{ file: 'a.ts', ruleId: 'eslint/eqeqeq', from: 2, to: 1 }])
  // 新增的那条不会被自动吸收进 baseline；要接受欠债必须显式 fe-guard baseline --widen。
  assert.deepEqual(result.nextEntries, { [baselineKey('a.ts', 'eslint/eqeqeq')]: 1 })
})

test('partitionEntries：只把范围内、且检查仍启用的条目交给评估', () => {
  const entries = {
    [baselineKey('a.ts', 'eslint/eqeqeq')]: 1,
    [baselineKey('b.ts', 'eslint/eqeqeq')]: 1,
    [baselineKey('a.ts', 'typescript/TS2322')]: 1,
  }
  const { scoped, rest } = partitionEntries(
    entries,
    (file, ruleId) => file === 'a.ts' && ruleId.startsWith('eslint/'),
  )
  assert.deepEqual(scoped, { [baselineKey('a.ts', 'eslint/eqeqeq')]: 1 })
  assert.deepEqual(rest, {
    [baselineKey('b.ts', 'eslint/eqeqeq')]: 1,
    [baselineKey('a.ts', 'typescript/TS2322')]: 1,
  })
})

test('磁盘格式：按文件分组、便于人读，读写可往返', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fe-guard-'))
  try {
    const file = path.join(dir, 'baseline.json')
    const entries = { [baselineKey('src/b.ts', 'eslint/eqeqeq')]: 1, [baselineKey('src/a.ts', 'eslint/eqeqeq')]: 2 }
    saveBaseline(file, entries)
    assert.deepEqual(Object.keys(toDiskShape(entries)), ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(loadBaseline(file).entries, entries)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('countByKey / sameEntries', () => {
  const counts = countByKey([violation('a.ts', 'eslint/eqeqeq'), violation('a.ts', 'eslint/eqeqeq', 2)])
  assert.deepEqual(counts, { [baselineKey('a.ts', 'eslint/eqeqeq')]: 2 })
  assert.equal(sameEntries(counts, { ...counts }), true)
  assert.equal(sameEntries(counts, { [baselineKey('a.ts', 'eslint/eqeqeq')]: 3 }), false)
})
