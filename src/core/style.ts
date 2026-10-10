/**
 * 文风基线 / 去 AI 味（开发文档 B5 · 首版必含）
 *
 * 这里是**纯本地统计**，不花 token：
 * - 文风基线：句长分布、对话占比、段落节奏、高频词、成语密度
 * - 去 AI 味：高频 AI 腔句式命中 + 用户禁用词表 + 机械性重复（排比、形容词堆叠）
 */

export interface StyleMetrics {
  chars: number
  sentenceCount: number
  avgSentence: number
  /** 最长/最短句长 */
  maxSentence: number
  minSentence: number
  dialogueChars: number
  dialogueRatio: number
  paragraphCount: number
  avgParagraph: number
  /** 四字词组出现次数 */
  idiomHits: string[]
  topWords: Array<{ w: string; n: number }>
}

export interface StyleIssue {
  type: 'ai-cliche' | 'banned' | 'parallel' | 'adj-stack' | 'long-sentence' | 'summary-tone'
  text: string
  pos: number
  /** 所在段落原文片段 */
  context: string
  hint: string
}

const PUNCT = ['。', '！', '？', '…', '”', '’', '；']

/** AI 味高频句式（命中即标红成为清单项） */
const AI_CLICHE: Array<[RegExp, string]> = [
  [/总(而言|的来)说/, '总结腔：这一句删掉通常更利落'],
  [/值得(一提|注意)的是/, '典型的模型过渡句，中文写作里很少用'],
  [/在这(一?瞬间|个时刻)/, 'AI 高频时间状语，直接写动作更好'],
  [/仿佛整个(世界|天地)都(安静|静止)/, '烂俗的环境描写，换个具体的声音写'],
  [/不仅[仅]?[，、]?[^。]{0,12}更(是|要)/, '"不仅…更是"排比结构，AI 常见'],
  [/首先[，、][^。]{0,40}[，、]其次/, '"首先/其次"的列举腔'],
  [/他不?禁(陷入|想起|疑惑)/, '"不禁"是模型高频词，试试别的写法'],
  [/心中(五味杂陈|一紧|一沉|微微一动)/, '情绪总结词，删掉更有画面'],
  [/如(同|若)[^。]{0,10}(一般|一样|似的)/, '明喻密度过高会显腻'],
  [/let'?s|让我们一起/, '混入英文祈使句'],
  [/愿(我们|你)[^。]{0,10}/, '结尾抒情总结腔']
]

const SUMMARY_TONE = [/(不禁)?感慨(万千|不已)/, /这一刻[^。]{0,8}终于/, /也许[，、]这就是/]

const STOPWORDS = new Set([
  '的', '了', '和', '是', '就', '都', '而', '及', '与', '也', '很', '到', '说', '着', '不', '在', '有', '他', '她', '它',
  '一个', '我们', '你们', '他们', '这个', '那个', '什么', '没有', '自己', '已经', '但是', '因为', '所以', '然后', '还是',
  '一', '二', '三', '之', '上', '下', '里', '中', '来', '去', '把', '被', '给', '让', '对', '从', '以', '又', '再', '还'
])

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^---[\s\S]*?---/, '')
    .replace(/[#>*`_\-]/g, '')
}

function sentencesOf(text: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (PUNCT.includes(ch) && cur.trim().length > 1) {
      parts.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

export function analyzeStyle(rawText: string, bannedWords: string[] = []): { metrics: StyleMetrics; issues: StyleIssue[] } {
  const text = stripMarkdown(rawText)
  const clean = text.replace(/\s/g, '')
  const sentences = sentencesOf(text)
  const lengths = sentences.map((s) => s.replace(/[\s"“”「」『』（）()]/g, '').length).filter((n) => n > 0)
  const paragraphs = text.split(/\r?\n\s*\r?\n|\r?\n/).map((p) => p.trim()).filter(Boolean)

  let dialogueChars = 0
  for (const m of text.matchAll(/[“"「『][^”"」』]{1,200}[”"」』]/g)) dialogueChars += m[0].length

  // 重复出现的四字词组（叠用过多会让文风变腻）
  const idiomCount: Record<string, number> = {}
  for (const m of clean.matchAll(/[\u4e00-\u9fff]{4}/g)) idiomCount[m[0]] = (idiomCount[m[0]] || 0) + 1
  const topIdioms = Object.entries(idiomCount)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w)

  const freq: Record<string, number> = {}
  for (const m of clean.matchAll(/[\u4e00-\u9fff]{2,4}/g)) freq[m[0]] = (freq[m[0]] || 0) + 1
  const topWords = Object.entries(freq)
    .filter(([w]) => !STOPWORDS.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w, n]) => ({ w, n }))

  const metrics: StyleMetrics = {
    chars: clean.length,
    sentenceCount: lengths.length,
    avgSentence: lengths.length ? Math.round((lengths.reduce((s, n) => s + n, 0) / lengths.length) * 10) / 10 : 0,
    maxSentence: lengths.length ? Math.max(...lengths) : 0,
    minSentence: lengths.length ? Math.min(...lengths) : 0,
    dialogueChars,
    dialogueRatio: clean.length ? Math.round((dialogueChars / clean.length) * 1000) / 10 : 0,
    paragraphCount: paragraphs.length,
    avgParagraph: paragraphs.length ? Math.round((clean.length / paragraphs.length) * 10) / 10 : 0,
    idiomHits: topIdioms,
    topWords
  }

  const issues: StyleIssue[] = []
  const push = (type: StyleIssue['type'], m: RegExpExecArray, hint: string) => {
    issues.push({
      type,
      text: m[0].slice(0, 40),
      pos: m.index || 0,
      context: (text.slice(Math.max(0, (m.index || 0) - 24), (m.index || 0) + 40).replace(/\s+/g, ' ')),
      hint
    })
  }

  for (const [re, hint] of AI_CLICHE) {
    const rx = new RegExp(re.source, 'g')
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) {
      push('ai-cliche', m, hint)
      if (m[0] === '') rx.lastIndex++
    }
  }
  for (const re of SUMMARY_TONE) {
    const rx = new RegExp(re.source, 'g')
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) push('summary-tone', m, '结尾总结腔：让读者自己得出感受')
  }
  for (const w of bannedWords.filter(Boolean)) {
    const rx = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) push('banned', m, `禁用词「${w}」`)
  }

  // 排比：连续三句/三段以同一个词开场
  const heads = sentences.map((s) => s.slice(0, 2))
  for (let i = 2; i < heads.length; i++) {
    if (heads[i] && heads[i] === heads[i - 1] && heads[i] === heads[i - 2] && heads[i].length > 1) {
      issues.push({
        type: 'parallel',
        text: heads[i],
        pos: 0,
        context: sentences.slice(i - 2, i + 1).join(' / ').slice(0, 60),
        hint: '连续三句同一开场词，读起来像模型生成的排比'
      })
    }
  }
  // 形容词堆叠：一段里出现 3 个以上「XX的YY」
  for (const p of paragraphs) {
    const hits = p.match(/[\u4e00-\u9fff]{2,4}的[\u4e00-\u9fff]{2,4}/g) || []
    if (hits.length >= 4) {
      issues.push({
        type: 'adj-stack',
        text: hits.slice(0, 3).join('、'),
        pos: 0,
        context: p.slice(0, 60),
        hint: `这段有 ${hits.length} 处「…的…」堆叠，形容词密度过高`
      })
    }
  }
  // 超长句：中文里一口气读不完的长句（阈值 60 字，作者可自行忽略）
  for (const s of sentences) {
    const len = s.replace(/\s/g, '').length
    if (len > 60) {
      issues.push({ type: 'long-sentence', text: s.slice(0, 30) + '…', pos: 0, context: s.slice(0, 50), hint: `${len} 字长句，考虑断开` })
    }
  }

  const order: Record<StyleIssue['type'], number> = { banned: 0, 'ai-cliche': 1, 'summary-tone': 2, parallel: 3, 'adj-stack': 4, 'long-sentence': 5 }
  issues.sort((a, b) => order[a.type] - order[b.type] || a.pos - b.pos)
  return { metrics, issues }
}

/* ------------------------------------------------------------------ 文风基线存档

  基线存成「记忆/文风基线.md」里的普通 Markdown（作者可以直接改），
  软件只读去重会用；指纹 = 高频词集合，用于判断"这章像不像我自己写的"。
*/

export interface StyleBaseline {
  updated: string
  chars: number
  sentenceCount: number
  avgSentence: number
  dialogueRatio: number
  avgParagraph: number
  /** 指纹词 */
  topWords: string[]
}

export function toBaseline(m: StyleMetrics): StyleBaseline {
  return {
    updated: new Date().toISOString(),
    chars: m.chars,
    sentenceCount: m.sentenceCount,
    avgSentence: m.avgSentence,
    dialogueRatio: m.dialogueRatio,
    avgParagraph: m.avgParagraph,
    topWords: m.topWords.slice(0, 24).map((t) => t.w)
  }
}

export function serializeBaseline(b: StyleBaseline): string {
  const rows: Array<[string, string | number]> = [
    ['更新于', b.updated],
    ['样本字数', b.chars],
    ['句子数', b.sentenceCount],
    ['平均句长', b.avgSentence],
    ['对话占比%', b.dialogueRatio],
    ['平均段落字数', b.avgParagraph]
  ]
  const lines = [
    '# 文风基线',
    '',
    '> 本文件可手工改。软件在下一次「重算基线」时会整体覆盖。',
    '',
    '| 指标 | 值 |',
    '|---|---|'
  ]
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`)
  lines.push('', '## 指纹词', '', b.topWords.join('、') || '（样本不足）', '')
  return lines.join('\n')
}

export function parseBaseline(raw: string): StyleBaseline | null {
  if (!raw || !raw.includes('|')) return null
  const get: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith('|') || /^\|[\s:-]+\|/.test(line)) continue
    const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((s) => s.trim())
    if (cells.length >= 2) get[cells[0]] = cells[1]
  }
  if (!get['平均句长']) return null
  const wordSec = /##\s*指纹词[\s\S]*?\n([\s\S]*?)(?=\n##|\n*$)/.exec(raw)
  const topWords = (wordSec?.[1] || '')
    .split(/[、,，\s]/)
    .map((s) => s.replace(/[^\u4e00-\u9fffA-Za-z]/g, '').trim())
    .filter(Boolean)
  return {
    updated: get['更新于'] || '',
    chars: Number(get['样本字数']) || 0,
    sentenceCount: Number(get['句子数']) || 0,
    avgSentence: Number(get['平均句长']) || 0,
    dialogueRatio: Number(get['对话占比%']) || 0,
    avgParagraph: Number(get['平均段落字数']) || 0,
    topWords
  }
}

/** 当前章节与基线的偏离度（复用上面两个稳定指标） */
export function driftFromBaseline(b: StyleBaseline, m: StyleMetrics): ReturnType<typeof drift> {
  return drift(
    {
      chars: b.chars,
      sentenceCount: b.sentenceCount,
      avgSentence: b.avgSentence,
      maxSentence: 0,
      minSentence: 0,
      dialogueChars: 0,
      dialogueRatio: b.dialogueRatio,
      paragraphCount: 0,
      avgParagraph: b.avgParagraph,
      idiomHits: [],
      topWords: b.topWords.map((w, i) => ({ w, n: 24 - i }))
    },
    m
  )
}

export const ISSUE_LABEL: Record<StyleIssue['type'], string> = {
  banned: '禁用词',
  'ai-cliche': 'AI 腔',
  'summary-tone': '总结腔',
  parallel: '排比滥用',
  'adj-stack': '形容词堆叠',
  'long-sentence': '超长句'
}

/**
 * 与「参考文本」对比：给出偏离度（0–100，越大越不像）
 * 只比较句长均值与对话占比两个稳定指标，避免玄学打分。
 */
export function drift(base: StyleMetrics, target: StyleMetrics): { score: number; notes: string[] } {
  const notes: string[] = []
  if (!base.sentenceCount || !target.sentenceCount) return { score: 0, notes: ['样本不足'] }
  const sDiff = Math.abs(base.avgSentence - target.avgSentence) / Math.max(6, base.avgSentence)
  const dDiff = Math.abs(base.dialogueRatio - target.dialogueRatio) / Math.max(10, base.dialogueRatio)
  const score = Math.min(100, Math.round((sDiff * 60 + dDiff * 40) * 100) / 100 * 100)
  if (Math.abs(base.avgSentence - target.avgSentence) > 3) {
    notes.push(`平均句长偏离：基线 ${base.avgSentence} 字 → 当前 ${target.avgSentence} 字`)
  }
  if (Math.abs(base.dialogueRatio - target.dialogueRatio) > 8) {
    notes.push(`对话占比偏离：基线 ${base.dialogueRatio}% → 当前 ${target.dialogueRatio}%`)
  }
  return { score, notes }
}
