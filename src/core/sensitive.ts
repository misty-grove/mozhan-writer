/**
 * 敏感词检查（P2-26）
 *
 * 纯本地词表扫描，不联网、不上报。
 * 词表在作者自己的 记忆/敏感词.txt 里，一行一个词，改起来和改别处一样：记事本就行。
 * 内置的那几个只是告诉你格式的示例，作者想换成自己平台的违禁表，覆盖即可。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { DIRS } from './workspace'

export const SENSITIVE_FILE = '敏感词.txt'

/** 内置示例词（只演示格式，作者可完全覆盖） */
export const BUILTIN_WORDS = ['赌博', '毒品', '走私', '诈骗']

export interface SensitiveHit {
  word: string
  /** 在全文中的字符位置 */
  pos: number
  context: string
}

export interface SensitiveReport {
  word: string
  count: number
  hits: SensitiveHit[]
}

/** 解析词表文本：忽略空行和 # 注释，支持「词 || 替换建议」写法 */
export function parseWords(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('||')[0].trim())
        .filter(Boolean)
    )
  ]
}

export function serializeWords(words: string[], header = '一行一个词，# 开头是注释。也可以用「词 || 建议替换成什么」的写法。'): string {
  return `# ${header}\n\n${[...new Set(words)].filter(Boolean).join('\n')}\n`
}

export async function loadWords(ref: DirRef): Promise<string[]> {
  try {
    const raw = await fs().readFile(ref, [DIRS.memory, SENSITIVE_FILE])
    const custom = parseWords(raw)
    return custom.length ? custom : BUILTIN_WORDS
  } catch {
    return BUILTIN_WORDS
  }
}

export async function saveWords(ref: DirRef, words: string[]) {
  await fs().writeFile(ref, [DIRS.memory, SENSITIVE_FILE], serializeWords(words))
}

/** 扫一段文本；返回按词分组的结果 */
export function scan(text: string, words: string[]): SensitiveReport[] {
  const out: SensitiveReport[] = []
  const list = [...new Set(words)].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const word of list) {
    const hits: SensitiveHit[] = []
    let i = text.indexOf(word)
    while (i >= 0) {
      const from = Math.max(0, i - 16)
      hits.push({
        word,
        pos: i,
        context: (from > 0 ? '…' : '') + text.slice(from, i + word.length + 16).replace(/\s+/g, ' ') + '…'
      })
      i = text.indexOf(word, i + word.length)
    }
    if (hits.length) out.push({ word, count: hits.length, hits })
  }
  return out.sort((a, b) => b.count - a.count)
}

/** 扫全书；章节顺序由调用方给定 */
export function scanWork(
  chapters: Array<{ id: string; title: string }>,
  bodies: Record<string, string>,
  words: string[]
): Array<{ id: string; title: string; reports: SensitiveReport[]; total: number }> {
  const out: Array<{ id: string; title: string; reports: SensitiveReport[]; total: number }> = []
  for (const ch of chapters) {
    const text = bodies[ch.id] || ''
    if (!text.trim()) continue
    const reports = scan(text, words)
    if (!reports.length) continue
    out.push({ id: ch.id, title: ch.title, reports, total: reports.reduce((s, r) => s + r.count, 0) })
  }
  return out.sort((a, b) => b.total - a.total)
}
