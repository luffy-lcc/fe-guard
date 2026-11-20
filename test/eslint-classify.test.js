import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMessage } from '../src/runners/eslint.js'

/**
 * ESLint 的 ruleId 为空时，消息可能是"文件被忽略"、真正的解析错误、
 * 未使用的 disable 指令，或其它工具提示。分类必须准确，否则会制造假违规。
 */

test('普通规则消息带 eslint/ 前缀', () => {
  assert.equal(classifyMessage({ ruleId: 'no-unused-vars', severity: 2, message: 'unused' }), 'eslint/no-unused-vars')
})

test('被 ignore 的文件不产生违规（两种提示文案）', () => {
  assert.equal(
    classifyMessage({
      ruleId: null,
      severity: 1,
      message: 'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
    }),
    null,
  )
  assert.equal(
    classifyMessage({ ruleId: null, severity: 1, message: 'File ignored because no matching configuration was supplied.' }),
    null,
  )
})

test('真正的解析错误仍归 parse-error', () => {
  assert.equal(
    classifyMessage({ ruleId: null, severity: 2, fatal: true, message: 'Parsing error: Unexpected token }' }),
    'eslint/parse-error',
  )
  // 老版本 ESLint 的 JSON 里可能没有 fatal 字段，只能靠文案判断。
  assert.equal(classifyMessage({ ruleId: null, severity: 2, message: 'Parsing error: Unexpected token }' }), 'eslint/parse-error')
})

test('未使用的 eslint-disable 指令单独归类，不冒充 parse-error', () => {
  assert.equal(
    classifyMessage({ ruleId: null, severity: 1, message: "Unused eslint-disable directive (no problems were reported from 'no-console')." }),
    'eslint/unused-disable-directive',
  )
})

test('未知的 ESLint 自身提示保留为 eslint/no-rule', () => {
  assert.equal(classifyMessage({ ruleId: null, severity: 2, message: 'Something unexpected from ESLint' }), 'eslint/no-rule')
})
