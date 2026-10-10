/**
 * 本地语义检索（P1-20）
 *
 * 不内置 embedding 模型（那要几十 MB，和「离线即装即用」的约束冲突），
 * 用经典的 TF-IDF + 余弦做召回：
 *  - 中文按相邻两字（bigram）切分，不需要分词器，也能容忍错别字和口语说法
 *  - 段落级索引，命中就给整段，方便直接看上下文
 * 十万字规模下这点计算是毫秒级的，纯本地、零 token。
 */
import type { Chapter } from './types'

export interface Passage {
  /** 唯一 id：章节 id + 段内偏移 */
  id: string
  chapterId: string
  chapterTitle: string
  text: string
  pos: number
}

export interface Hit {
  passage: Passage
  score: number
  /** 命中片段（用于展示） */
  snippet: string
}

interface Posting {
  tf: number
}

export interface RetrievalIndex {
  passages: Passage[]
  /** token → 出现在哪些段落、词频多少 */
  df: Map<string, number>
  vectors: Map<string, Map<string, number>>
  builtAt: number
}

const STOP = new Set(['的', '了', '是', '在', '和', '也', '就', '都', '而', '及', '与', '着', '或', '一个', '我们', '他们'])

/** 中文 bigram + 英文单词；空格与标点不产生 token */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const clean = text.toLowerCase().replace(/\s+/g, ' ')
  // 西文按词
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) out.push(m[0])
  // 中文按相邻两字
  const cjk = clean.replace(/[^一-龥]/g, ' ')
  for (const seg of cjk.split(' ')) {
    if (!seg) continue
    if (seg.length === 1) out.push(seg)
    for (let i = 0; i + 1 < seg.length; i++) {
      const g = seg.slice(i, i + 2)
      if (!STOP.has(g)) out.push(g)
    }
  }
  return out
}

/** 把正文切成段落（按空行/句子累积到目标长度） */
export function splitPassages(
  chapters: Chapter[],
  bodies: Record<string, string>,
  targetSize = 160
): Passage[] {
  const out: Passage[] = []
  for (const ch of chapters) {
    const raw = bodies[ch.id] || ''
    if (!raw.trim()) continue
    const blocks = raw.split(/\n{1,}/)
    let buf = ''
    let start = 0
    let cursor = 0
    const flush = () => {
      const t = buf.trim()
      if (t) {
        out.push({ id: `${ch.id}@${start}`, chapterId: ch.id, chapterTitle: ch.title, text: t, pos: start })
      }
      buf = ''
    }
    for (const b of blocks) {
      if (!buf) start = cursor
      buf += (buf ? '\n' : '') + b
      cursor += b.length + 1
      if (buf.length >= targetSize) {
        flush()
        start = cursor
      }
    }
    flush()
  }
  return out
}

export function buildIndex(passages: Passage[]): RetrievalIndex {
  const df = new Map<string, number>()
  const vectors = new Map<string, Map<string, number>>()

  for (const p of passages) {
    const tf = new Map<string, number>()
    for (const t of tokenize(p.text)) tf.set(t, (tf.get(t) || 0) + 1)
    // 长度归一化，长段落不会因为词多就占便宜
    const norm = Math.sqrt([...tf.values()].reduce((s, n) => s + n * n, 0)) || 1
    const vec = new Map<string, number>()
    for (const [t, n] of tf) vec.set(t, n / norm)
    vectors.set(p.id, vec)
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
  }

  return { passages, df, vectors, builtAt: Date.now() }
}

function queryVector(q: string, df: Map<string, number>, total: number): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokenize(q)) tf.set(t, (tf.get(t) || 0) + 1)
  const vec = new Map<string, number>()
  for (const [t, n] of tf) {
    const idf = Math.log((total + 1) / ((df.get(t) || 0) + 1)) + 1
    vec.set(t, n * idf)
  }
  const norm = Math.sqrt([...vec.values()].reduce((s, n) => s + n * n, 0)) || 1
  for (const [t, n] of vec) vec.set(t, n / norm)
  return vec
}

/** 召回：返回按相关度降序的段落 */
export function search(index: RetrievalIndex, query: string, top = 8): Hit[] {
  const q = query.trim()
  if (!q) return []
  const qv = queryVector(q, index.df, index.passages.length)
  const out: Hit[] = []
  for (const p of index.passages) {
    const pv = index.vectors.get(p.id)
    if (!pv) continue
    let dot = 0
    // 用短的一侧做循环
    const [small, big] = qv.size <= pv.size ? [qv, pv] : [pv, qv]
    for (const [t, w] of small) {
      const o = big.get(t)
      if (o) dot += w * o
    }
    if (dot > 0.001) out.push({ passage: p, score: dot, snippet: snippetOf(p.text, 60) })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, top)
}

function snippetOf(text: string, len: number): string {
  const t = text.replace(/\s+/g, ' ')
  return t.length <= len ? t : t.slice(0, len) + '…'
}

/* ------------------------------------------------------------------ 缓存 */

let cached: { key: string; index: RetrievalIndex } | null = null

/** 按作品 + 段落数做 key；内容变了（字数变了）就重建 */
export function cachedIndex(key: string, passages: Passage[]): RetrievalIndex {
  if (cached && cached.key === key) return cached.index
  const index = buildIndex(passages)
  cached = { key, index }
  return index
}

export function clearIndexCache() {
  cached = null
}
