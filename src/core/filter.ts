/**
 * 章节树筛选：纯函数，不碰 DOM。
 *
 * 章节目录在长篇里会到几百上千条，靠滚动找一章很难受。
 * 这里给一个很轻的查询语法，作者不用学：
 *
 *   `启程`        标题 / 文件名 / 标签里包含「启程」
 *   `#草稿`       只看某个状态（#待写 / #草稿 / #待修 / #已定稿，支持只写前一个字，如 #待）
 *   `>3000`       只看本章字数大于 3000 的
 *   `<1000`       只看还没写够 1000 字的
 *   可以叠：`启程 #草稿`、`#待修 >2000`
 *
 * 认不出来的写法（比如 `#abc`）会当成普通关键词，不会把作者的输入吃掉。
 */
import { STATUS_LIST, type Chapter, type ChapterStatus, type Volume } from './types'

export interface ChapterFilterQuery {
  raw: string
  /** 普通关键词（多个词用空格连起来当整串匹配） */
  text: string
  status: ChapterStatus | null
  minWords: number | null
  maxWords: number | null
}

export interface ChapterMatch {
  hit: boolean
  /** 命中原因，给 UI 显示（如「状态 草稿」「标题命中」） */
  reasons: string[]
  /** 标题里命中的字符区间，供高亮 */
  ranges: Array<[number, number]>
}

export interface VolumeHit {
  volume: Volume
  chapters: Chapter[]
  matched: boolean
  /** 卷名本身命中关键词（命中的话卷名也高亮） */
  nameHit: boolean
}

export interface FilteredTree {
  active: boolean
  query: ChapterFilterQuery
  root: Chapter[]
  volumes: VolumeHit[]
  /** 筛出来的章数 */
  hits: number
  /** 筛之前的章数 */
  total: number
}

/** 把输入串解析成查询条件 */
export function parseFilter(raw: string): ChapterFilterQuery {
  const q: ChapterFilterQuery = { raw: raw || '', text: '', status: null, minWords: null, maxWords: null }
  const words: string[] = []
  for (const tok of (raw || '').split(/\s+/)) {
    if (!tok) continue
    if (tok.startsWith('#')) {
      const name = tok.slice(1)
      const hit = STATUS_LIST.find((s) => s === name || (!!name && s.startsWith(name)))
      if (hit) {
        q.status = hit
        continue
      }
      words.push(tok) // 不认识的 #xxx 当普通词
      continue
    }
    const m = /^([<>])(\d+)$/.exec(tok)
    if (m) {
      const n = Number(m[2])
      if (m[1] === '>') q.minWords = n
      else q.maxWords = n
      continue
    }
    words.push(tok)
  }
  q.text = words.join(' ')
  return q
}

/** 查询是否「有效」：空输入表示不过滤 */
export function isFilterActive(q: ChapterFilterQuery): boolean {
  return !!q.text || !!q.status || q.minWords !== null || q.maxWords !== null
}

/** 单个章节是否命中 */
export function matchChapter(ch: Chapter, q: ChapterFilterQuery): ChapterMatch {
  const reasons: string[] = []
  const ranges: Array<[number, number]> = []

  if (q.status) {
    if (ch.status !== q.status) return { hit: false, reasons, ranges }
    reasons.push('状态 ' + q.status)
  }
  if (q.minWords !== null && ch.wordCount < q.minWords) return { hit: false, reasons, ranges }
  if (q.maxWords !== null && ch.wordCount > q.maxWords) return { hit: false, reasons, ranges }
  if (q.minWords !== null || q.maxWords !== null) reasons.push(ch.wordCount + ' 字')

  if (q.text) {
    const t = q.text.toLowerCase()
    const lowerTitle = ch.title.toLowerCase()
    let from = 0
    for (;;) {
      const i = lowerTitle.indexOf(t, from)
      if (i < 0) break
      ranges.push([i, i + t.length])
      from = i + t.length
    }
    if (ranges.length) {
      reasons.push('标题命中')
    } else {
      const hay = (ch.file + ' ' + ch.tags.join(' ')).toLowerCase()
      if (!hay.includes(t)) return { hit: false, reasons, ranges }
      reasons.push('文件名 / 标签命中')
    }
  }
  return { hit: true, reasons, ranges }
}

/** 把标题按命中区间切成「普通 / 高亮」片段，模板直接 v-for */
export function highlightParts(text: string, ranges: Array<[number, number]>): Array<{ text: string; hit: boolean }> {
  if (!ranges.length) return [{ text, hit: false }]
  const merged: Array<[number, number]> = []
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const out: Array<{ text: string; hit: boolean }> = []
  let at = 0
  for (const [s, e] of merged) {
    const from = Math.max(at, Math.min(s, text.length))
    const to = Math.max(from, Math.min(e, text.length))
    if (from > at) out.push({ text: text.slice(at, from), hit: false })
    if (to > from) out.push({ text: text.slice(from, to), hit: true })
    at = to
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out.length ? out : [{ text, hit: false }]
}

/** 键盘导航里的一行：卷标题行或章节行 */
export interface FlatRow {
  kind: 'volume' | 'chapter'
  /** 章 id（chapter）或 `v:卷id`（volume）；未分卷那段用 `v:` */
  key: string
  title: string
  volumeId: string | null
  /** 卷行能不能折叠（「未分卷」这段是虚拟的，不能） */
  collapsible: boolean
}

/**
 * 把过滤后的树摊平成一维可见行 —— 上下键移动的就是这个索引空间。
 *
 * 折叠状态必须在这里考虑：卷收起来时它的章不该被方向键走到，
 * 否则光标会「跳」到看不见的地方去。
 */
export function flattenTree(tree: FilteredTree, collapsed: Record<string, boolean> = {}): FlatRow[] {
  const rows: FlatRow[] = []
  if (tree.root.length) {
    rows.push({ kind: 'volume', key: 'v:', title: '未分卷', volumeId: null, collapsible: false })
    for (const c of tree.root) rows.push({ kind: 'chapter', key: c.id, title: c.title, volumeId: null, collapsible: false })
  }
  for (const hit of tree.volumes) {
    rows.push({ kind: 'volume', key: 'v:' + hit.volume.id, title: hit.volume.name, volumeId: hit.volume.id, collapsible: true })
    // 筛选状态下卷是强制展开的（不展开就看不见命中在哪），跟着模板走
    if (tree.active || !collapsed[hit.volume.id]) {
      for (const c of hit.chapters) {
        rows.push({ kind: 'chapter', key: c.id, title: c.title, volumeId: hit.volume.id, collapsible: false })
      }
    }
  }
  return rows
}

/** 按查询过滤整棵树；查询为空时原样返回（active=false） */
export function filterTree(volumes: Volume[], rootChapters: Chapter[], raw: string): FilteredTree {
  const q = parseFilter(raw)
  const active = isFilterActive(q)
  const total = volumes.reduce((n, v) => n + v.chapters.length, 0) + rootChapters.length
  if (!active) {
    return {
      active: false,
      query: q,
      root: rootChapters.slice(),
      volumes: volumes.map((v) => ({ volume: v, chapters: v.chapters.slice(), matched: true, nameHit: false })),
      hits: total,
      total
    }
  }

  const keep = (list: Chapter[]) => list.filter((c) => matchChapter(c, q).hit)
  const root = keep(rootChapters)
  let hits = root.length
  const vols: VolumeHit[] = []
  for (const v of volumes) {
    const chapters = keep(v.chapters)
    hits += chapters.length
    if (!chapters.length) continue // 整卷都没命中就整卷收起，少一层视觉噪音
    vols.push({ volume: v, chapters, matched: true, nameHit: !!q.text && v.name.toLowerCase().includes(q.text.toLowerCase()) })
  }
  return { active: true, query: q, root, volumes: vols, hits, total }
}
