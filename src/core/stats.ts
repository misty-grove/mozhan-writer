/**
 * 写作统计（开发文档 A6 / P2-23）
 * 数据来源：本地 Markdown + localStorage 的每日字数，不联网。
 */
import type { Chapter, Volume } from './types'

export interface DailyWord {
  date: string
  words: number
}

export interface Overview {
  totalWords: number
  chapterCount: number
  volumeCount: number
  avgChapter: number
  maxChapter: { title: string; words: number } | null
  minChapter: { title: string; words: number } | null
  byStatus: Record<string, number>
  byVolume: Array<{ name: string; words: number; chapters: number }>
  /** 连续写作天数与最长纪录 */
  streak: number
  bestStreak: number
  todayWords: number
  targetProgress: number
}

const K_STATS = 'writer.stats'

export function loadDaily(): DailyWord[] {
  try {
    const s = JSON.parse(localStorage.getItem(K_STATS) || '{"words":{}}')
    return Object.entries(s.words || {}).map(([date, words]) => ({ date, words: Number(words) || 0 })).sort((a, b) => a.date.localeCompare(b.date))
  } catch {
    return []
  }
}

function dayDiff(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00').getTime()
  const db = new Date(b + 'T00:00:00').getTime()
  return Math.round((db - da) / 86400000)
}

export function summarize(volumes: Volume[], rootChapters: Chapter[], daily: DailyWord[], target = 0): Overview {
  const chapters = [...rootChapters, ...volumes.flatMap((v) => v.chapters)]
  const words = chapters.map((c) => c.wordCount)
  const byStatus: Record<string, number> = {}
  for (const c of chapters) byStatus[c.status] = (byStatus[c.status] || 0) + 1
  const max = chapters.reduce<Chapter | null>((m, c) => (!m || c.wordCount > m.wordCount ? c : m), null)
  const min = chapters.reduce<Chapter | null>((m, c) => (!m || c.wordCount < m.wordCount ? c : m), null)
  const written = daily.filter((d) => d.words > 0).map((d) => d.date)
  let streak = 0
  let best = 0
  let run = 0
  for (let i = 0; i < written.length; i++) {
    if (i > 0 && dayDiff(written[i - 1], written[i]) === 1) run++
    else run = 1
    best = Math.max(best, run)
  }
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const lastDay = written[written.length - 1]
  streak = lastDay && dayDiff(lastDay, key) <= 1 ? run : 0
  const totalWords = words.reduce((s, n) => s + n, 0)
  return {
    totalWords,
    chapterCount: chapters.length,
    volumeCount: volumes.length,
    avgChapter: chapters.length ? Math.round(totalWords / chapters.length) : 0,
    maxChapter: max ? { title: max.title, words: max.wordCount } : null,
    minChapter: min ? { title: min.title, words: min.wordCount } : null,
    byStatus,
    byVolume: volumes.map((v) => ({ name: v.name, words: v.wordCount, chapters: v.chapters.length })),
    streak,
    bestStreak: best,
    todayWords: daily.find((d) => d.date === key)?.words || 0,
    targetProgress: target ? Math.min(100, Math.round((daily.find((d) => d.date === key)?.words || 0) / target * 100)) : 0
  }
}

/** 最近 N 天的连续日期序列（没有记录的日子补 0），用于画柱状图 */
export function recentDays(daily: DailyWord[], n = 30): DailyWord[] {
  const map = new Map(daily.map((d) => [d.date, d.words]))
  const out: DailyWord[] = []
  const today = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date: key, words: map.get(key) || 0 })
  }
  return out
}
