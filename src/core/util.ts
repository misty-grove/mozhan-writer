export function uid(prefix = ''): string {
  const r = (crypto as any).randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()
  return prefix ? `${prefix}_${r}` : r
}

export function debounce<T extends (...args: any[]) => void>(fn: T, wait: number) {
  let t: any = null
  const wrapped = (...args: Parameters<T>) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), wait)
  }
  wrapped.cancel = () => t && clearTimeout(t)
  wrapped.flush = (...args: Parameters<T>) => {
    if (t) clearTimeout(t)
    fn(...args)
  }
  return wrapped as T & { cancel: () => void; flush: (...a: Parameters<T>) => void }
}

/** 中文字数统计：CJK 逐字计，西文按词计，标点计入总数（贴近网文平台口径） */
export function countWords(text: string): number {
  if (!text) return 0
  const clean = text.replace(/```[\s\S]*?```/g, '')
  const cjk = clean.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)
  const rest = clean.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
  const words = rest.match(/[A-Za-z0-9_'’\-]+/g)
  return (cjk?.length || 0) + (words?.length || 0)
}

export function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

/** 行级 diff，够用于快照对比 */
export function diffLines(a: string, b: string): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  const al = a.split('\n')
  const bl = b.split('\n')
  const n = al.length
  const m = bl.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push({ type: 'same', text: al[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: al[i++] })
    } else {
      out.push({ type: 'add', text: bl[j++] })
    }
  }
  while (i < n) out.push({ type: 'del', text: al[i++] })
  while (j < m) out.push({ type: 'add', text: bl[j++] })
  return out
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

/** 估算 token：中文约 1.4 字/token，英文约 4 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const rest = text.length - cjk
  return Math.ceil(cjk / 1.4 + rest / 4)
}

/**
 * 中文数字 → 阿拉伯数字（支持到万；认不出返回 null）
 *
 * 放在 util 而不是 importDoc：卷/章的中文序号「第三卷」在 workspace 里也要认，
 * 而 importDoc 反过来依赖 workspace —— 放那儿会绕成环。
 */
export function cnNumber(s: string): number | null {
  if (/^[0-9]+$/.test(s)) return Number(s)
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
  let total = 0
  let section = 0
  let cur = 0
  let ok = false
  for (const ch of s) {
    if (ch in digits) {
      cur = digits[ch]
      ok = true
    } else if (ch in units) {
      const u = units[ch]
      section += (cur || 1) * u
      cur = 0
      ok = true
    } else if (ch === '万') {
      section = (section + cur) * 10000
      total += section
      section = 0
      cur = 0
      ok = true
    } else {
      return null
    }
  }
  if (!ok) return null
  return total + section + cur
}
