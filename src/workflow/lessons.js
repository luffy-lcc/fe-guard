import path from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'

export const LESSONS_FILE = '.fe-guard/lessons.jsonl'

/**
 * 复盘记录按 JSONL 追加：一次失败只写一行，历史永远保留。
 * Task 8 才会把它接进 task_lesson / workflow.distill，这里先提供读写能力。
 */
export function appendLesson(root, record = {}) {
  const entry = { at: new Date().toISOString(), ...record }
  const file = path.join(root, LESSONS_FILE)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  } catch {
    return null
  }
}

/** 读取复盘记录：损坏的行直接跳过，不能让一条坏记录阻塞审计。 */
export function readLessons(root) {
  const file = path.join(root, LESSONS_FILE)
  if (!existsSync(file)) return []
  const lessons = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      lessons.push(JSON.parse(text))
    } catch {
      // 损坏行跳过
    }
  }
  return lessons
}
