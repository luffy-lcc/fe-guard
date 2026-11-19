/**
 * 粗略 token 估算（不引入分词依赖）：
 * 中日韩字符按 1 token，其余按 4 个字符 1 token 折算。
 * 只用于给 AGENTS.md 片段设上限，量级足够，不追求精确。
 */
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

export const AGENTS_TOKEN_LIMIT = 600

export function estimateTokens(text) {
  let tokens = 0
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    let cjk = 0
    let ascii = 0
    for (const char of word) {
      if (CJK.test(char)) cjk += 1
      else ascii += 1
    }
    tokens += cjk
    if (ascii > 0) tokens += Math.max(1, Math.ceil(ascii / 4))
  }
  return tokens
}
