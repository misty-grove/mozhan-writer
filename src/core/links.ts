/**
 * 双链与反向引用（开发文档 A5）
 * 支持两种写法：[[名称]]（Obsidian 式双链）与 @名称（写作时顺手 @ 一下）
 */
import type { Chapter, SettingEntry } from './types'

export interface RefHit {
  id: string
  title: string
  /** 命中的原文 */
  match: string
  pos: number
  count: number
  snippet: string
}

export interface Presence {
  entry: SettingEntry
  /** 出现过的章节序号（1 起） */
  chapters: number[]
  total: number
  /** 距离最后一章隔了多少章（0 = 最近一章也出场） */
  gapFromEnd: number
  lastChapter: number | null
}

const LINK_RE = /\[\[([^\]\n]{1,30})\]\]/g
const AT_RE = /@([^\s@,，。；;：:"'“”《》\[\]]{1,20})/g

/** 抽出一段正文里出现的所有引用名（去重保序） */
export function extractRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(LINK_RE)) out.push(m[1])
  for (const m of text.matchAll(AT_RE)) out.push(m[1])
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))]
}

function countIn(hay: string, needle: string): number {
  if (!needle) return 0
  let c = 0
  let i = hay.indexOf(needle)
  while (i >= 0) {
    c++
    i = hay.indexOf(needle, i + needle.length)
  }
  return c
}

/**
 * 建立「名称 → 在哪些章节出现过」的索引
 *
 * 注意：显式引用的解析（extractRefs）在**每章只做一次**。
 * 这段原来是写在 `for (const key of keySet)` 里面的 —— 也就是同一章正文会被
 * 按名字个数重扫上百遍正则。设定库一百多条时，作者在「设定」面板点一个条目
 * 就要多等两百毫秒，纯属白干。
 *
 * @param bodies 章节正文（由调用方一次性读取，避免重复 IO）
 */
export function buildRefIndex(
  chapters: Chapter[],
  bodies: Record<string, string>,
  keys: string[]
): Map<string, RefHit[]> {
  const index = new Map<string, RefHit[]>()
  const keySet = [...new Set(keys)].sort((a, b) => b.length - a.length)
  for (const ch of chapters) {
    const text = bodies[ch.id] || ''
    if (!text) continue
    const refs = new Set(extractRefs(text))
    for (const key of keySet) {
      // 优先识别显式写法，其次才是裸名称
      const explicit = refs.has(key)
      const count = explicit ? countIn(text, `[${key}]`) + countIn(text, `@${key}`) : 0
      const total = count > 0 ? count : countIn(text, key)
      if (!total) continue
      const pos = text.indexOf(`[[${key}]]`) >= 0 ? text.indexOf(`[[${key}]]`) : text.indexOf(key)
      const snippet = (pos > 20 ? '…' : '') + text.slice(Math.max(0, pos - 20), pos + 60).replace(/\s+/g, ' ') + '…'
      const arr = index.get(key) || []
      arr.push({ id: ch.id, title: ch.title, match: key, pos, count: total, snippet })
      index.set(key, arr)
    }
  }
  return index
}

/**
 * 某个设定条目在全书中的出场情况（防「角色失踪」）
 *
 * 每章正文的显式引用只解析一次（原来是「每条目 × 每章」各解析一遍：
 * 设定库一百多条时，一致性检查里光是这一项就要多花掉一百倍的正则时间）。
 */
export function presenceStats(entries: SettingEntry[], chapters: Chapter[], bodies: Record<string, string>): Presence[] {
  const ordered = chapters
  const refSets = ordered.map((ch) => {
    const text = bodies[ch.id] || ''
    return text ? new Set(extractRefs(text)) : null
  })
  const out: Presence[] = []
  for (const entry of entries) {
    const names = [entry.name, ...entry.aliases]
    const hits: number[] = []
    ordered.forEach((ch, i) => {
      const text = bodies[ch.id] || ''
      if (!text) return
      const refs = refSets[i]!
      const hit = names.some((n) => refs.has(n)) || names.some((n) => text.includes(n))
      if (hit) hits.push(i + 1)
    })
    const last = hits.length ? hits[hits.length - 1] : null
    out.push({
      entry,
      chapters: hits,
      total: countTotal(ordered, bodies, names),
      gapFromEnd: last === null ? ordered.length : ordered.length - last,
      lastChapter: last
    })
  }
  return out
}

function countTotal(chapters: Chapter[], bodies: Record<string, string>, names: string[]): number {
  let c = 0
  for (const ch of chapters) {
    const text = bodies[ch.id] || ''
    for (const n of names) c += countIn(text, n)
  }
  return c
}

/** 在正文里把 [[名称]] / @名称 渲染成可点击的标记（源码预览用） */
export function highlightRefs(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\[\[([^\]\n]{1,30})\]\]/g, '<a class="reflink" data-ref="$1">$1</a>')
    .replace(/@([^\s@,，。；;：:"'“”《》\[\]]{1,20})/g, '<a class="reflink" data-ref="$1">@$1</a>')
}
