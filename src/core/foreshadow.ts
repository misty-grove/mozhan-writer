/**
 * 伏笔台账（开发文档 A4 / P1-11）
 *
 * 数据仍然是「记忆/伏笔台账.md」里那张人能看懂的 Markdown 表格：
 *
 * | 伏笔 | 埋设章节 | 状态 | 计划回收 | 优先级 |
 * |---|---|---|---|---|
 * | 云杉的血统秘密 | 第003章 | 未回收 | 第030章 | 高 |
 *
 * 软件负责把它读成结构化条目、让你改、并对超期未回收的条目预警。
 */
import { parseDoc, serializeDoc } from './frontmatter'

export type ForeshadowStatus = '未回收' | '已回收' | '废弃'

export interface Foreshadow {
  id: number
  text: string
  planted: string
  status: ForeshadowStatus
  planned: string
  priority: string
  /** 备注栏（可选） */
  note: string
}

const HEADER = ['伏笔', '埋设章节', '状态', '计划回收', '优先级', '备注']

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((s) => s.trim())
}

function isSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s|:-]*$/.test(line) && line.includes('-')
}

export function parseTable(raw: string): Foreshadow[] {
  const { body } = parseDoc(raw)
  const lines = body.split(/\r?\n/)
  const out: Foreshadow[] = []
  for (const line of lines) {
    if (!line.trim().startsWith('|') || isSeparator(line)) continue
    const cells = splitRow(line)
    if (cells[0] === '伏笔' || cells[0] === '' && cells.length < 3) continue
    if (cells.length < 3) continue
    out.push({
      id: out.length,
      text: cells[0] || '',
      planted: cells[1] || '',
      status: (cells[2] === '已回收' || cells[2] === '废弃' ? cells[2] : '未回收') as ForeshadowStatus,
      planned: cells[3] || '',
      priority: cells[4] || '',
      note: cells[5] || ''
    })
  }
  return out
}

export function serializeTable(title: string, intro: string, rows: Foreshadow[]): string {
  const lines = [`# ${title}`, '']
  if (intro) lines.push(intro, '')
  lines.push(`| ${HEADER.join(' | ')} |`, `|${HEADER.map(() => '---').join('|')}|`)
  for (const r of rows) {
    lines.push(`| ${r.text} | ${r.planted} | ${r.status} | ${r.planned} | ${r.priority} | ${r.note} |`)
  }
  lines.push('')
  return serializeDoc({ title }, lines.join('\n'), ['title'])
}

/** 从「第NNN章」抽序号；抽不到返回 null */
export function chapterNo(s: string, titles: string[] = []): number | null {
  const m = /第\s*(\d+)\s*章/.exec(s || '')
  if (m) return Number(m[1])
  const name = (s || '').trim()
  const i = titles.findIndex((t) => t === name)
  return i >= 0 ? i + 1 : null
}

export interface WarnItem {
  row: Foreshadow
  level: 'overdue' | 'soondue' | 'unplanted'
  message: string
}

/**
 * 超期预警
 * @param currentIndex 当前是第几章（1 起）
 * @param nearWindow 距离计划回收还剩多少章算「快到期」
 */
export function warnings(rows: Foreshadow[], currentIndex: number, titles: string[] = [], nearWindow = 5): WarnItem[] {
  const out: WarnItem[] = []
  for (const r of rows) {
    if (!r.text.trim()) continue
    if (r.status !== '未回收') continue
    const planted = chapterNo(r.planted, titles)
    if (planted === null) {
      out.push({ row: r, level: 'unplanted', message: `「${r.text}」没写埋设章节，无法判断是否超期` })
      continue
    }
    const planned = chapterNo(r.planned, titles)
    if (planned === null) {
      out.push({ row: r, level: 'unplanted', message: `「${r.text}」没写计划回收章节` })
      continue
    }
    if (currentIndex > planned) {
      out.push({ row: r, level: 'overdue', message: `「${r.text}」已超期 ${currentIndex - planned} 章（计划第${planned}章回收）` })
    } else if (planned - currentIndex <= nearWindow) {
      out.push({ row: r, level: 'soondue', message: `「${r.text}」还有 ${planned - currentIndex} 章就该回收了` })
    }
  }
  return out
}

export function emptyRow(): Foreshadow {
  return { id: -1, text: '', planted: '', status: '未回收', planned: '', priority: '中', note: '' }
}
