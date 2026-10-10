/**
 * 时间线（P2-22）
 *
 * 不做花哨的年代推算 —— 只回答两个作者真正会问的问题：
 *   1. 到目前为止，故事里发生了什么，按什么顺序？
 *   2. 有没有前后打架的地方（后面某章写的时间比前面早）？
 *
 * 事件来源只有两处，都是作者自己的文字：
 *   - 设定/时间线/*.md 里手写的「- 时间：事件」条目
 *   - 正文里出现的时间短语（三年后、第二天、开元十二年……）
 */
import type { Chapter, SettingEntry } from './types'

export interface TimelineEvent {
  id: string
  /** 时间原文（作者怎么写就怎么显示） */
  when: string
  /** 可比较的排序值；null = 无法定位（如「很久以后」） */
  rank: number | null
  text: string
  /** 来源章序号（1 起）；来自设定文件则为 null */
  chapterNo: number | null
  chapterId: string | null
  chapterTitle: string
  /** 涉及的设定条目名 */
  actors: string[]
  source: '设定' | '正文'
}

export interface TimelineConflict {
  a: TimelineEvent
  b: TimelineEvent
  actor: string
  message: string
}

/** 相对时间：以「天」为单位，方便和绝对年份拉开量级 */
const RELATIVE: Array<[RegExp, number]> = [
  [/(\d+)\s*年后/, 365],
  [/(\d+)\s*个月后/, 30],
  [/(\d+)\s*周后/, 7],
  [/(\d+)\s*日后|(\d+)\s*天后/, 1],
  [/(\d+)\s*个?时辰后/, 0.08],
  [/(\d+)\s*小时后/, 0.04]
]

const ABSOLUTE_YEAR = /(?:公元|开元|天宝|贞观|庆历|万历|康熙|乾隆)?\s*(?:前)?(\d{1,4})\s*年/
const REIGN = /(开元|天宝|贞观|庆历|万历|康熙|乾隆|洪武|建安|正德|嘉靖)/

const SEASON: Record<string, number> = { 春: 0.0, 夏: 0.25, 秋: 0.5, 冬: 0.75, 初春: 0.05, 盛夏: 0.35, 深秋: 0.6, 严冬: 0.85 }
const DAYPART: Record<string, number> = { 清晨: 0.01, 拂晓: 0.02, 早晨: 0.03, 上午: 0.05, 正午: 0.08, 午后: 0.1, 黄昏: 0.14, 傍晚: 0.15, 夜里: 0.18, 深夜: 0.2, 子时: 0.19 }

/** 把一个时间短语折算成可比较的数字；认不出来返回 null（宁可不管，不能瞎排） */
export function timeRank(phrase: string): number | null {
  // 先归一化中文数字，这样调用方直接传「三年后」也能认，不必自己先转
  const p = normalizeDigits(phrase.trim())
  if (!p) return null

  for (const [re, unit] of RELATIVE) {
    const m = p.match(re)
    if (m) {
      const n = Number(m[1] || m[2])
      if (Number.isFinite(n)) return 1e6 + n * unit
    }
  }

  const ym = p.match(ABSOLUTE_YEAR)
  if (ym) {
    const year = Number(ym[1])
    if (Number.isFinite(year) && year > 0) {
      const negative = p.includes('前')
      const base = negative ? -year : year
      let frac = 0
      for (const [name, v] of Object.entries(SEASON)) if (p.includes(name)) frac = v
      for (const [name, v] of Object.entries(DAYPART)) if (p.includes(name)) frac += v * 0.1
      return base + frac
    }
  }

  // 只有季节 / 时辰，没有年份：给一个很小的量级，仅用于同一章内排序
  for (const [name, v] of Object.entries(SEASON)) if (p.includes(name)) return v
  for (const [name, v] of Object.entries(DAYPART)) if (p.includes(name)) return v

  return null
}

const TIME_RE = /([0-9一二三四五六七八九十百千两]{1,6}\s*(?:年|月|日|天|周|个?时辰|小时)(?:后|前)?|(?:公元|开元|天宝|贞观|庆历|万历|康熙|乾隆|洪武|建安|正德|嘉靖)?\s*(?:前)?[0-9一二三四五六七八九十百千]{1,4}\s*年(?:初|中|末)?|(?:清晨|拂晓|早晨|上午|正午|午后|黄昏|傍晚|夜里|深夜|子时)|(?:初春|盛夏|深秋|严冬|[春夏冬秋])(?:季|天|日)?)/g

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 }

function cnToNum(s: string): number {
  if (/^\d+$/.test(s)) return Number(s)
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    return (a ? CN_NUM[a] ?? 1 : 1) * 10 + (b ? CN_NUM[b] ?? 0 : 0)
  }
  return CN_NUM[s] ?? NaN
}

/** 把中文数字替换成阿拉伯数字，让后面的正则好干活 */
function normalizeDigits(s: string): string {
  return s.replace(/[一二三四五六七八九十百千两]+/g, (m) => {
    if (m.includes('百')) {
      const [a, b] = m.split('百')
      return String(((a ? cnToNum(a) : 1) * 100) + (b ? cnToNum(b) : 0))
    }
    return String(cnToNum(m))
  })
}

export interface TimeMark {
  phrase: string
  rank: number | null
  pos: number
}

/** 从一段正文里抽出所有时间短语 */
export function extractTimeMarks(text: string): TimeMark[] {
  const norm = normalizeDigits(text)
  const out: TimeMark[] = []
  const seen = new Set<number>()
  for (const m of norm.matchAll(TIME_RE)) {
    const phrase = m[1]?.trim()
    if (!phrase || phrase.length > 20) continue
    // 原文里对应的位置（normalizeDigits 可能改变长度，用索引近似即可）
    const pos = m.index ?? 0
    const key = Math.round(pos / 4)
    if (seen.has(key)) continue
    seen.add(key)
    const rank = timeRank(phrase)
    if (rank === null) continue
    out.push({ phrase, rank, pos })
  }
  return out
}

/** 设定/时间线 里的条目：每行写成「- 时间：事件」或「| 时间 | 事件 |」 */
function parseTimelineEntry(e: SettingEntry): TimelineEvent[] {
  const out: TimelineEvent[] = []
  const lines = e.body.split('\n')
  lines.forEach((line, i) => {
    const m = line.match(/^\s*[-*]\s*(.+?)\s*[:：]\s*(.+)$/) || line.match(/^\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|?\s*$/)
    if (!m) return
    const when = m[1].trim()
    const text = m[2].trim()
    if (!when || !text) return
    if (/^[-: ]+$/.test(text)) return
    out.push({
      id: `${e.id}#${i}`,
      when,
      rank: timeRank(when),
      text,
      chapterNo: null,
      chapterId: null,
      chapterTitle: e.name,
      actors: [e.name],
      source: '设定'
    })
  })
  return out
}

/**
 * 汇总全书事件
 * @param maxPerChapter 每章最多取几个时间点，避免长章刷屏
 */
export function buildTimeline(
  entries: SettingEntry[],
  chapters: Chapter[],
  bodies: Record<string, string>,
  maxPerChapter = 6
): TimelineEvent[] {
  const events: TimelineEvent[] = []

  for (const e of entries.filter((x) => x.kind === 'timeline')) {
    events.push(...parseTimelineEntry(e))
  }

  const names = entries.flatMap((e) => [e.name, ...e.aliases]).filter(Boolean)

  chapters.forEach((ch, idx) => {
    const text = bodies[ch.id] || ''
    if (!text.trim()) return
    const marks = extractTimeMarks(text).slice(0, maxPerChapter)
    for (const mk of marks) {
      const from = Math.max(0, mk.pos - 30)
      const snippet = text.slice(from, mk.pos + 40).replace(/\s+/g, ' ')
      const actors = names.filter((n) => snippet.includes(n)).slice(0, 4)
      events.push({
        id: `${ch.id}#${mk.pos}`,
        when: mk.phrase,
        rank: mk.rank,
        text: (from > 0 ? '…' : '') + snippet + '…',
        chapterNo: idx + 1,
        chapterId: ch.id,
        chapterTitle: ch.title,
        actors,
        source: '正文'
      })
    }
  })

  return events
}

/**
 * 时序矛盾：同一个实体，在靠后的章里却写了更早的时间。
 * 只报「章节顺序」与「时间顺序」相反的情况，不猜作者意图。
 */
export function findConflicts(events: TimelineEvent[]): TimelineConflict[] {
  const withRank = events.filter((e) => e.rank !== null && e.chapterNo !== null)
  const out: TimelineConflict[] = []

  // 按实体分组比较
  const byActor = new Map<string, TimelineEvent[]>()
  for (const e of withRank) {
    for (const a of e.actors.length ? e.actors : ['（无明确实体）']) {
      const arr = byActor.get(a) || []
      arr.push(e)
      byActor.set(a, arr)
    }
  }

  for (const [actor, arr] of byActor) {
    // 同一实体在同一章内的多次出现不算矛盾
    const byChapter = new Map<number, TimelineEvent>()
    for (const e of arr) {
      const prev = byChapter.get(e.chapterNo!)
      if (!prev || (e.rank! < prev.rank! && e.source === '正文')) byChapter.set(e.chapterNo!, e)
    }
    const sorted = [...byChapter.values()].sort((a, b) => a.chapterNo! - b.chapterNo!)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      if (cur.rank! < prev.rank! - 0.01) {
        out.push({
          a: prev,
          b: cur,
          actor,
          message: `第 ${prev.chapterNo} 章已写到「${prev.when}」，第 ${cur.chapterNo} 章却回到「${cur.when}」`
        })
      }
    }
  }

  // 全局的章节顺序 vs 时间顺序（不限实体），只报最明显的一处
  const global = [...withRank].filter((e) => e.source === '正文')
  const byCh = new Map<number, number>()
  for (const e of global) {
    const prev = byCh.get(e.chapterNo!)
    if (prev === undefined || e.rank! < prev) byCh.set(e.chapterNo!, e.rank!)
  }
  const seq = [...byCh.entries()].sort((a, b) => a[0] - b[0])
  for (let i = 1; i < seq.length; i++) {
    if (seq[i][1] < seq[i - 1][1] - 0.01) {
      out.push({
        a: global.find((e) => e.chapterNo === seq[i - 1][0])!,
        b: global.find((e) => e.chapterNo === seq[i][0])!,
        actor: '（全书）',
        message: `第 ${seq[i - 1][0]} 章到第 ${seq[i][0]} 章，时间标记往回走了`
      })
      break
    }
  }

  return out
}

/** 按可比较值排序；认不出时间的挂在最后，保持章节顺序 */
export function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank
    const ca = a.chapterNo ?? 0
    const cb = b.chapterNo ?? 0
    return ca - cb
  })
}
