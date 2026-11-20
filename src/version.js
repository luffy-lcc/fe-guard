import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 工具版本：SARIF driver、HTML 页脚与 --version 共用，避免三处各读一次 package.json。 */
export const TOOL_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
