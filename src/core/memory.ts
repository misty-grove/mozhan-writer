/** 记忆库：逐章摘要 / 状态表 / 伏笔台账 / 时间线的读写（均为纯 Markdown，可用记事本改） */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { DIRS } from './workspace'
import type { Chapter } from './types'

export const MEMORY_FILES = ['逐章摘要.md', '状态表.md', '伏笔台账.md', '时间线.md'] as const

function sectionRegex(key: string) {
  return new RegExp(`^##\\s+${escapeReg(key)}\\s*$`, 'm')
}

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把某个 key 的正文写入（已存在则替换，不存在则追加） */
export function updateMemorySection(raw: string, key: string, text: string): string {
  const re = sectionRegex(key)
  const block = `## ${key}\n\n${text.trim()}\n`
  if (re.test(raw)) {
    const m = re.exec(raw)!
    const idx = m.index!
    const rest = raw.slice(idx + m[0].length)
    const nextSec = /^##\s+/m.exec(rest)
    const end = nextSec ? nextSec.index! : rest.length
    return `${raw.slice(0, idx).replace(/\n*$/, '\n\n')}${block}\n${rest.slice(end).replace(/^\n+/, '')}`
  }
  return `${raw.replace(/\n*$/, '\n\n')}${block}\n`
}

export function readMemorySection(raw: string, key: string): string {
  const re = sectionRegex(key)
  const m = re.exec(raw)
  if (!m) return ''
  const rest = raw.slice(m.index! + m[0].length)
  const nextSec = /^##\s+/m.exec(rest)
  return (nextSec ? rest.slice(0, nextSec.index) : rest).trim()
}

export async function readMemoryFile(ref: DirRef, file: string): Promise<string> {
  try {
    return await fs().readFile(ref, [DIRS.memory, file])
  } catch {
    return `# ${file.replace('.md', '')}\n`
  }
}

export async function writeMemoryFile(ref: DirRef, file: string, content: string) {
  await fs().writeFile(ref, [DIRS.memory, file], content)
}

/* ------------------------------------------------------------------ 自动生成区（P1-18）

  规则：生成的内容一律包在 <!-- writer:xxx --> … <!-- /writer:xxx --> 之间。
  这样重复生成是幂等的，作者手写的部分永远不会被覆盖。
*/

const TAG_RE = (tag: string) => new RegExp(`<!--\\s*writer:${tag}\\s*-->[\\s\\S]*?<!--\\s*/writer:${tag}\\s*-->`, 'm')

/** 把一段生成内容写进 raw：已存在则整块替换，不存在则追加到末尾 */
export function writeGeneratedBlock(raw: string, tag: string, content: string): string {
  const block = `<!-- writer:${tag} -->\n${content.trim()}\n<!-- /writer:${tag} -->`
  const re = TAG_RE(tag)
  if (re.test(raw)) return raw.replace(re, block)
  return `${raw.replace(/\n*$/, '\n\n')}${block}\n`
}

export function readGeneratedBlock(raw: string, tag: string): string {
  const m = TAG_RE(tag).exec(raw)
  return m ? m[0] : ''
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 取一段文字的第一句（用于摘要压缩） */
function firstSentence(text: string, max = 60): string {
  const t = text.replace(/[#>*`_\-|]/g, '').replace(/\s+/g, ' ').trim()
  const m = /^[^。！？；]{0,80}[。！？；]?/.exec(t)
  const s = (m ? m[0] : t).trim()
  return s.length > max ? s.slice(0, max) + '…' : s || '（摘要为空）'
}

/**
 * 滚动总述：由逐章摘要压缩出的「写到哪了 + 近十章发生了什么」。
 * 没有 AI 也能生成 —— 只是抽取，不做改写。
 */
export function buildRollingSummary(chapters: Chapter[], summaries: Record<string, string>, recentCount = 10): string {
  if (!chapters.length) return '还没有章节。'
  const last = chapters[chapters.length - 1]
  const recent = chapters.slice(-recentCount)
  const lines: string[] = []
  lines.push(`> 本块由软件生成于 ${stamp()}，来源：记忆/逐章摘要.md。不想要可以整块删掉。`, '')
  lines.push(`## 写到哪儿了`, '', `第 ${chapters.length} 章《${last.title}》（${last.status}，${last.wordCount} 字）`, '')
  lines.push(`## 近 ${recent.length} 章`, '')
  for (const c of recent) {
    const s = summaries[c.title] ? firstSentence(summaries[c.title]) : '尚无摘要'
    lines.push(`- 第 ${c.order} 章《${c.title}》：${s}`)
  }
  return lines.join('\n')
}

/** 状态表：全书章节进展一览（标题/状态/字数/更新时间） */
export function buildStatusTable(chapters: Chapter[]): string {
  if (!chapters.length) return '还没有章节。'
  const head = ['章节', '标题', '状态', '字数', '更新时间']
  const lines: string[] = [
    `> 本块由软件生成于 ${stamp()}，来源：作品目录。`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`
  ]
  for (const c of chapters) {
    lines.push(`| 第${c.order}章 | ${c.title} | ${c.status} | ${c.wordCount} | ${c.updated || ''} |`)
  }
  return lines.join('\n')
}

/**
 * 时间线抽取：把「章节 + 该章摘要首句 + 出场角色」排成一张表。
 * 只做结构化搬运，不替作者判断因果。
 */
export function buildTimeline(chapters: Chapter[], summaries: Record<string, string>): string {
  const rows = chapters.filter((c) => summaries[c.title])
  if (!rows.length) return '还没有可用于抽取的摘要。'
  const head = ['章节', '事件（摘要首句）', '在场角色', '状态']
  const lines: string[] = [
    `> 本块由软件生成于 ${stamp()}，来源：逐章摘要 + 章节卡片的出场人物。`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`
  ]
  for (const c of rows) {
    const who = (c.meta.characters || []).join('、')
    lines.push(`| 第${c.order}章 《${c.title}》 | ${firstSentence(summaries[c.title], 48)} | ${who || '—'} | ${c.status} |`)
  }
  return lines.join('\n')
}
