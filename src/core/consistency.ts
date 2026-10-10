/**
 * 一致性初筛（开发文档 A6 —— 无需 AI 的那一半）
 *
 * 只做「机器能对账」的部分：断链、疑似笔误、伏笔超期、角色失踪、[[链接]]指向空条目。
 * 文学判断不在这里做，那是作者的事。
 */
import type { Chapter, SettingEntry } from './types'
import { buildNameMap, type SettingEntry as SE } from './codex'
import { extractRefs } from './links'
import { presenceStats } from './links'
import { chapterNo, parseTable, warnings } from './foreshadow'

export type IssueKind = 'broken-link' | 'typo' | 'overdue' | 'missing' | 'draft-left' | 'unknown-ref'

export interface ConsistencyIssue {
  kind: IssueKind
  level: 'warn' | 'info'
  message: string
  chapterId?: string
  chapterTitle?: string
  /** 章节内位置（字符下标），用于跳转 */
  pos?: number
  suggest?: string
}

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  'broken-link': '双链断链',
  typo: '疑似笔误',
  overdue: '伏笔超期',
  missing: '角色失踪',
  'draft-left': '未收尾',
  'unknown-ref': '未登记名词'
}

/** 同长度字符串的汉明距离是否为 1（比 DP 编辑距离快得多，够用于笔误初筛） */
function hamming1(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++diff > 1) return false
  }
  return diff === 1
}

/** 编辑距离（用于候选推荐） */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

export interface CheckInput {
  entries: SettingEntry[]
  chapters: Chapter[]
  bodies: Record<string, string>
  foreshadowRaw: string
  currentId: string
  /** 连续多少章没出场算「失踪」 */
  missingAfter?: number
}

export function checkAll(input: CheckInput): ConsistencyIssue[] {
  const { entries, chapters, bodies, foreshadowRaw, currentId } = input
  const missingAfter = input.missingAfter ?? 8
  const issues: ConsistencyIssue[] = []
  const map = buildNameMap(entries)
  const known = [...map.keys()]

  /* 1. 双链断链 + 未登记名词（@X 但设定库没有） */
  const unknownSeen = new Set<string>()
  for (const ch of chapters) {
    const text = bodies[ch.id]
    if (!text) continue
    for (const ref of extractRefs(text)) {
      if (map.has(ref)) continue
      if (unknownSeen.has(ref)) continue
      unknownSeen.add(ref)
      const near = findNear(ref, known)
      const pos = text.indexOf(ref)
      issues.push({
        kind: near ? 'broken-link' : 'unknown-ref',
        level: 'info',
        message: near ? `《${ch.title}》里的「${ref}」设定库没有，最接近的是「${near}」` : `《${ch.title}》里的「${ref}」没有对应设定条目`,
        chapterId: ch.id,
        chapterTitle: ch.title,
        pos: pos >= 0 ? pos : undefined,
        suggest: near ? `改成 [[${near}]]，或在设定库补一条「${ref}」` : '到「设定库」面板补一条条目'
      })
    }
  }

  /* 2. 疑似笔误：正文里与已知名称编辑距离 1 的词（如 林晚 → 林浼 这类手误）
   *
   * 朴素写法是「每章 × 每个名字 × 每个字符位置」三层循环，等于把同一份正文按名字个数重扫一遍。
   * 300 章 85 万字的实测是 12 秒 —— 作者点一下「开始检查」，界面就僵在那里。
   * 现在做两个预处理，判定口径一个字没改（仍然只报「长度相同且恰好差一个字」）：
   *   ① 每章只滑一遍窗，把候选词按**名字长度**分组收起来。
   *      原来每个名字各收一遍候选集，长度相同的名字收出来的东西一模一样 —— 白干 120 倍。
   *   ② 名字按「删掉第 i 个字之后长什么样」建索引。
   *      两个等长的词如果只差一个字，把那个位置从双方都删掉，剩下的串必然相同；
   *      所以拿候选词的各种「删一字」去查索引，就能捞出可能的名字，再用 hamming1 确认
   *      （索引只保证距离 ≤ 2，所以要确认）。这样比较次数从「候选 × 名字」降到「候选」。
   */
  const shortNames = known.filter((nm) => nm.length >= 2 && nm.length <= 4)
  const sigIndex = new Map<string, string[]>()
  for (const nm of shortNames) {
    for (let i = 0; i < nm.length; i++) {
      const sig = nm.slice(0, i) + nm.slice(i + 1)
      const arr = sigIndex.get(sig)
      if (arr) arr.push(nm)
      else sigIndex.set(sig, [nm])
    }
  }
  const NAME_LENS = [...new Set(shortNames.map((nm) => nm.length))].sort((a, b) => a - b)
  const CJK_RUN = /[\u4e00-\u9fff]+/g
  for (const ch of chapters) {
    const text = bodies[ch.id] || ''
    if (!text || !NAME_LENS.length) continue
    // 候选词按长度分组（同一章只扫一遍正文）
    const byLen = new Map<number, Set<string>>()
    for (const run of text.match(CJK_RUN) || []) {
      for (const len of NAME_LENS) {
        if (run.length < len) continue
        let set = byLen.get(len)
        if (!set) {
          set = new Set()
          byLen.set(len, set)
        }
        for (let i = 0; i + len <= run.length; i++) {
          const slice = run.slice(i, i + len)
          if (map.has(slice)) continue // 它本身就是个已知名称，不算笔误
          set.add(slice)
        }
      }
    }
    for (const [len, set] of byLen) {
      for (const c of set) {
        for (let i = 0; i < len; i++) {
          const cands = sigIndex.get(c.slice(0, i) + c.slice(i + 1))
          if (!cands) continue
          for (const nm of cands) {
            if (!hamming1(c, nm)) continue
            const pos = text.indexOf(c)
            issues.push({
              kind: 'typo',
              level: 'warn',
              message: `《${ch.title}》出现「${c}」，与设定里的「${nm}」只差一个字 —— 是不是笔误？`,
              chapterId: ch.id,
              chapterTitle: ch.title,
              pos: pos >= 0 ? pos : undefined,
              suggest: `若为同一人，统一写成「${nm}」`
            })
          }
        }
      }
    }
  }

  /* 3. 伏笔超期 */
  const rows = parseTable(foreshadowRaw)
  const currentIndex = chapters.findIndex((c) => c.id === currentId) + 1 || chapters.length
  for (const w of warnings(rows, currentIndex, chapters.map((c) => c.title))) {
    issues.push({
      kind: w.level === 'overdue' ? 'overdue' : 'unknown-ref',
      level: w.level === 'overdue' ? 'warn' : 'info',
      message: w.message
    })
  }

  /* 4. 角色失踪 */
  const stats = presenceStats(entries.filter((e) => e.kind === 'character'), chapters, bodies)
  for (const s of stats) {
    if (!s.chapters.length) continue
    if (s.gapFromEnd >= missingAfter) {
      issues.push({
        kind: 'missing',
        level: 'warn',
        message: `「${s.entry.name}」已连续 ${s.gapFromEnd} 章没出场（上次在第 ${s.lastChapter} 章）`,
        suggest: '安排一次出场，或在本章用别人的台词提一句'
      })
    }
  }

  /* 5. 草稿残留标记 */
  for (const ch of chapters) {
    const text = bodies[ch.id] || ''
    for (const m of text.matchAll(/(TODO|待补|xxx|这里要写|未完待续)/gi)) {
      issues.push({
        kind: 'draft-left',
        level: 'info',
        message: `《${ch.title}》里有草稿痕迹：「${m[0]}」`,
        chapterId: ch.id,
        chapterTitle: ch.title,
        pos: m.index
      })
    }
  }

  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1))
}

function findNear(ref: string, known: string[]): string | null {
  let best: string | null = null
  let bestDist = 3
  for (const k of known) {
    const d = editDistance(ref, k)
    if (d < bestDist) {
      best = k
      bestDist = d
    }
  }
  return best
}

export function findSimilars(ref: string, known: string[]): string[] {
  return known.filter((k) => editDistance(ref, k) <= 2).slice(0, 3)
}

/** 给外部复用：某文本里的所有引用名是否都能在设定库找到 */
export function unresolvedRefs(text: string, entries: SE[]): string[] {
  const map = buildNameMap(entries)
  return extractRefs(text).filter((r) => !map.has(r))
}
