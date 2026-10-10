/**
 * 本地索引（开发文档 4.2：索引只是缓存，删掉不影响任何数据）
 * 浏览器宿主下放在内存 + localStorage 摘要；打包为桌面端后换成 SQLite + FTS5，接口不变。
 */
export interface IndexEntry {
  id: string
  title: string
  text: string
  words: number
}

export interface Hit {
  id: string
  title: string
  snippet: string
  pos: number
  count: number
}

const memory = new Map<string, IndexEntry[]>()
const K = 'writer.index.v1'

function persistedCounts(): Record<string, Record<string, number>> {
  try {
    return JSON.parse(localStorage.getItem(K) || '{}')
  } catch {
    return {}
  }
}

export function setIndex(refId: string, entries: IndexEntry[]) {
  memory.set(refId, entries)
  const all = persistedCounts()
  const counts: Record<string, number> = {}
  for (const e of entries) counts[e.id] = e.words
  all[refId] = counts
  try {
    localStorage.setItem(K, JSON.stringify(all))
  } catch {
    /* 容量超限时静默降级 */
  }
}

export function getCounts(refId: string): Record<string, number> {
  return persistedCounts()[refId] || {}
}

export function hasIndex(refId: string): boolean {
  return memory.has(refId)
}

export function getIndex(refId: string): IndexEntry[] {
  return memory.get(refId) || []
}

/** 简易全文检索：支持普通子串与正则（用户输入以 /xxx/ 形式包裹即视为正则） */
export function search(refId: string, query: string, limit = 100): Hit[] {
  const entries = memory.get(refId) || []
  if (!query) return []
  const isReg = /^\/.*\/[gimsuy]*$/.test(query)
  let re: RegExp
  try {
    re = isReg
      ? new RegExp(query.slice(1, query.lastIndexOf('/')), query.slice(query.lastIndexOf('/') + 1) + 'g')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  } catch {
    return []
  }
  const out: Hit[] = []
  for (const e of entries) {
    let count = 0
    let pos = -1
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(e.text))) {
      count++
      if (pos < 0) pos = m.index
      if (m[0] === '') re.lastIndex++
      if (count > 200) break
    }
    if (!count) continue
    const start = Math.max(0, pos - 30)
    const snippet = (start > 0 ? '…' : '') + e.text.slice(start, pos + 90).replace(/\s+/g, ' ') + '…'
    out.push({ id: e.id, title: e.title, snippet, pos, count })
    if (out.length >= limit) break
  }
  return out.sort((a, b) => b.count - a.count)
}

export function clearCache() {
  memory.clear()
  try {
    localStorage.removeItem(K)
  } catch {
    /* 没有 localStorage（Node 自检）或被拒时，内存态已清空即算成功 */
  }
}
