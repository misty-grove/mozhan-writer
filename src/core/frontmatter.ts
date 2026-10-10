/** 极简 YAML front matter 解析 / 序列化（够用即止，不引第三方 YAML 库） */

export interface ParsedDoc {
  meta: Record<string, any>
  body: string
}

function parseScalar(raw: string): any {
  const s = raw.trim()
  if (!s) return ''
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitTopLevel(inner, ',').map((x) => parseScalar(x))
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('|') || s.startsWith('>')) return ''
  return s
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const ch of s) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
    if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

export function parseDoc(text: string): ParsedDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text.replace(/^\r?\n/, '') }
  const meta: Record<string, any> = {}
  const lines = m[1].split(/\r?\n/)
  let key: string | null = null
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]
      meta[key] = parseScalar(kv[2])
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && key) {
      const cur = meta[key]
      const arr = Array.isArray(cur) ? cur : []
      arr.push(parseScalar(item[1]))
      meta[key] = arr
    }
  }
  return { meta, body: text.slice(m[0].length) }
}

function serValue(v: any): string {
  if (Array.isArray(v)) return `[${v.map(serValue).join(', ')}]`
  if (v === null || v === undefined) return '""'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  if (s === '' || /[:#\[\]{}\-&*!|>"']/g.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '\\"')}"`
  return s
}

export function serializeDoc(meta: Record<string, any>, body: string, order?: string[]): string {
  const keys = order ? [...order, ...Object.keys(meta).filter((k) => !order.includes(k))] : Object.keys(meta)
  const lines: string[] = []
  for (const k of keys) {
    const v = meta[k]
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    if (Array.isArray(v)) {
      lines.push(`${k}:`)
      for (const it of v) lines.push(`  - ${serValue(it)}`)
    } else {
      lines.push(`${k}: ${serValue(v)}`)
    }
  }
  if (!lines.length) return body
  // 跳过在本体里可能出现的分隔符冲突：body 若以 --- 开头，先加空行
  const safeBody = body.startsWith('---') ? '\n' + body : body
  return `---\n${lines.join('\n')}\n---\n${safeBody}`
}

export function updateMeta(text: string, patch: Record<string, any>, order?: string[]): string {
  const { meta, body } = parseDoc(text)
  const next = { ...meta }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  return serializeDoc(next, body, order)
}

export function getMeta<T = any>(text: string, key: string, def?: T): T {
  const { meta } = parseDoc(text)
  const v = meta[key]
  return (v === undefined ? def : v) as T
}

/** 提取纯文本（去 front matter 与 Markdown 记号），用于喂给 AI 与统计 */
export function stripMarkdown(text: string): string {
  const { meta, body } = parseDoc(text)
  return (meta.title ? `# ${meta.title}\n` : '') + body
}

export function getTitleFromText(text: string, fallback: string): string {
  return getMeta<string>(text, 'title', '') || fallback
}
