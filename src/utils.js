import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 用户可修正的错误（配置缺失、工具未安装等），统一映射为退出码 2。 */
export class UserError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UserError'
  }
}

export function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback
  const text = readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UserError(`${file} 不是合法 JSON：${error.message}`)
  }
}

export function writeJsonFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeTextFile(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

export function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

/** 配置里的超时字段：省略用默认值，非法值统一按配置错误处理。 */
export function normalizeTimeout(value, fallback, label, source) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UserError(`${source} 中 ${label} 必须是正数（毫秒）`)
  }
  return value
}

/** 把工具输出的绝对路径/相对路径统一成相对仓库根的 posix 路径。base 是工具的执行目录。 */
export function toRepoPath(root, filePath, base = root) {
  if (!filePath) return ''
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath)
  // macOS 的 /tmp 是 /private/tmp 的符号链接，工具可能返回 realpath，
  // 不统一会导致报告里出现 ../../../private/tmp/... 这种越界路径。
  const realRoot = safeRealpath(root)
  const realFile = safeRealpath(absolute)
  return toPosix(path.relative(realRoot, realFile))
}

function safeRealpath(file) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** 优先使用目标仓库本地安装的 bin，避免依赖全局环境。 */
export function resolveBin(root, bin) {
  if (bin.includes('/') || bin.includes(path.sep)) return path.resolve(root, bin)
  const local = path.join(root, 'node_modules', '.bin', bin)
  return existsSync(local) ? local : bin
}

export function run(bin, args, { cwd, timeoutMs = 120000, maxOutput = 8 * 1024 * 1024, env, input } = {}) {
  return new Promise((resolve) => {
    // POSIX 下让子进程自成进程组：超时时整组杀掉，避免孤儿子进程（如 shell 里的 sleep）
    // 继续持有 stdio 管道，让 close 迟迟不触发、超时上限形同虚设。
    const detached = process.platform !== 'win32'
    const child = spawn(bin, args, {
      cwd,
      env: env ?? process.env,
      stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached,
    })
    if (input !== undefined) {
      child.stdin.on('error', () => {}) // 子进程提前退出时写入可能 EPIPE，不应抛栈
      child.stdin.end(input)
    }
    const kill = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try { child.kill(signal) } catch { /* 进程已退出 */ }
      }
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let killedByTimeout = false
    let truncated = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ truncated, ...result })
    }

    const timer = setTimeout(() => {
      killedByTimeout = true
      kill('SIGTERM')
      // 有些工具会忽略 SIGTERM（或卡在系统调用里），再给 2s 后强杀。
      killTimer = setTimeout(() => kill('SIGKILL'), 2000)
    }, timeoutMs)
    let killTimer = null

    const append = (current, chunk) => {
      if (current.length >= maxOutput) {
        truncated = true
        return current
      }
      const next = current + chunk
      if (next.length > maxOutput) {
        truncated = true
        return next.slice(0, maxOutput)
      }
      return next
    }

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        finish({ code: 127, stdout, stderr: `找不到可执行文件：${bin}`, missing: true })
        return
      }
      finish({ code: 1, stdout, stderr: String(error.message) })
    })
    child.on('close', (code) => {
      if (killedByTimeout) {
        finish({
          code: 124,
          stdout,
          stderr: `${stderr}\n执行超时（${timeoutMs}ms），已终止：${bin} ${args.join(' ')}`,
          timedOut: true,
        })
        return
      }
      finish({ code: code ?? 1, stdout, stderr })
    })
  })
}

export function tail(text, lines = 8) {
  return String(text).trim().split('\n').slice(-lines).join('\n')
}

export const SKIP_DIRS = new Set(['node_modules', '.git', '.fe-guard', 'dist', 'build', 'coverage', 'out'])

/**
 * 按配置的目录与扩展名收集源文件，统一返回相对仓库根的 posix 路径。
 * 只读文件系统，不依赖 git，供 deps / ui / metrics 三个检查复用。
 */
export function walkSourceFiles(root, { roots = ['src'], extensions = [] } = {}) {
  const results = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (extensions.length > 0 && !extensions.some((ext) => entry.name.endsWith(ext))) continue
      results.push(toPosix(path.relative(root, full)))
    }
  }
  for (const entry of roots) walk(path.resolve(root, entry))
  return results.sort()
}

/** 极简 glob：支持 `*.ext`、`dir/**`、以及包含 `*` 的单段通配。 */
export function matchesIgnore(file, patterns = []) {
  const name = path.posix.basename(file)
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3)
      if (prefix.startsWith('**/')) {
        const needle = `/${prefix.slice(3)}/`
        return file.includes(needle) || file.startsWith(`${prefix.slice(3)}/`)
      }
      return file === prefix || file.startsWith(`${prefix}/`)
    }
    if (pattern.startsWith('*.') && !pattern.slice(1).includes('*')) return file.endsWith(pattern.slice(1))
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
      return regex.test(file) || regex.test(name)
    }
    return file === pattern || name === pattern
  })
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
