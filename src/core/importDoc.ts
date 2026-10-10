/**
 * 稿件导入 —— 把作者手里已有的 txt / md 正文收进作品目录。
 *
 * 定位：作者大多不是在空白文档里开始写的。手上往往已经有一份几十万字的
 * txt（或者从别的写作软件导出来的 md），要做的第一件事就是「把它搬进来」。
 * 这一步完全离线、不花 token，也不依赖 AI。
 *
 * 三个要点：
 * 1. **编码**：老稿子大量是 GBK/GB18030，先按 BOM 判断，再用「严格模式解 UTF-8」
 *    试；失败才退回 GBK。不要用宽松模式直接解，那样 GBK 中文会静默变成一堆
 *    替换符 U+FFFD，作者看到的是一屏乱码却不知道哪里错了。
 * 2. **分章**：默认按「第X章」这类标题行切；识别不出就整篇作一章，
 *    并把这个事实明确告诉作者，而不是硬凑出一堆莫名其妙的章。
 * 3. **不越权**：导入只往 正文/ 里加文件，不覆盖任何已有章节。
 */
import type { DirRef } from '@/platform'
import fs from '@/platform'
import { createChapter, createVolume, saveChapter } from './workspace'
import { cnNumber, countWords } from './util'

export { cnNumber }

export interface ImportChapter {
  /** 章标题（已去掉「第三章」这类前缀），用于生成文件名 */
  title: string
  /** 原始标题行，列表里给作者看 */
  heading: string
  /** 原标题里自带的中文/阿拉伯数字序号，没有则为 null */
  order: number | null
  body: string
  words: number
}

export type SplitMode = 'auto' | 'blank' | 'single'

export interface SplitOptions {
  mode?: SplitMode
  /** 自定义标题正则（字符串），命中即为新章起点；为空则用内置规则 */
  customPattern?: string
  /** single 模式下这一章叫什么 */
  singleTitle?: string
}

/* ------------------------------------------------------------------ 编码 */

const CJK_NUM = '零一二三四五六七八九十百千万两廿卅'

/** 章标题行：第X章 / 第X节 / 第X回 / 第X卷(篇) / Chapter N / Markdown 标题 / 括号序号 */
const HEADING_PATTERNS: RegExp[] = [
  new RegExp(`^\\s*第\\s*[0-9${CJK_NUM}]{1,10}\\s*[章回节篇]\\s*[、.．:：]?\\s*(.*)$`),
  new RegExp(`^\\s*第\\s*[0-9${CJK_NUM}]{1,10}\\s*[部卷]\\s*[、.．:：]?\\s*(.*)$`),
  /^\s*(?:Chapter|CHAPTER|chapter)\s*[0-9０-９]{1,6}\s*[、.．:：\-]?\s*(.*)$/,
  /^\s*#{1,3}\s+(.+?)\s*#*\s*$/,
  new RegExp(`^\\s*[（(]\\s*[0-9${CJK_NUM}]{1,10}\\s*[)）]\\s*(.*)$`)
]

function matchHeading(line: string): { rest: string; keepPrefix: boolean } | null {
  const t = line.trim()
  if (!t || t.length > 60) return null
  for (const re of HEADING_PATTERNS) {
    const m = re.exec(t)
    if (m) {
      // Markdown 标题保留整体作为标题；「第X章」只取前缀之后的部分
      const isMd = t.startsWith('#')
      return { rest: (m[1] ?? '').trim(), keepPrefix: isMd }
    }
  }
  return null
}

/** 从标题行里抽序号（第一章 / 第12章 / 第 三 章），抽不到返回 null */
export function headingOrder(line: string): number | null {
  const m = new RegExp(`第\\s*([0-9${CJK_NUM}]{1,10})\\s*[章回节篇部卷]`).exec(line.trim())
  if (m) return cnNumber(m[1])
  const m2 = /(?:Chapter|CHAPTER)\s*([0-9０-９]{1,6})/.exec(line.trim())
  if (m2) return Number(m2[1].replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d))))
  return null
}

/* ------------------------------------------------------------------ 分章 */

/**
 * 组装一章。title 是**最终标题**（已去前缀/已从 Markdown 标题剥掉 #），
 * heading 只作为「原始标题行」留在列表里给作者对照。
 */
function toChapter(heading: string, body: string, title?: string): ImportChapter {
  const t = (title ?? heading).trim()
  const order = heading ? headingOrder(heading) : null
  const words = countWords(body)
  return { title: t, heading, order, body, words }
}

/**
 * 把一整篇文本切成分章。
 * 切不出标题行时**不硬切**：整篇作为一章返回，让作者自己决定。
 */
export function splitChapters(text: string, opts: SplitOptions = {}): ImportChapter[] {
  const mode: SplitMode = opts.mode || 'auto'
  const src = text.replace(/\r\n?/g, '\n')
  const lines = src.split('\n')

  if (mode === 'single') {
    return [toChapter('', src.trim(), opts.singleTitle || '全文导入')]
  }

  if (mode === 'blank') {
    const blocks = src.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
    if (!blocks.length) return []
    return blocks.map((b, i) => {
      const first = b.split('\n')[0].trim().slice(0, 30)
      return toChapter(`第${i + 1}段 ${first}`, b, `第${i + 1}段`)
    })
  }

  let custom: RegExp | null = null
  if (opts.customPattern) {
    try {
      custom = new RegExp(opts.customPattern)
    } catch {
      custom = null // 坏正则不作为错误抛给作者，退回内置规则
    }
  }

  const hits: { index: number; heading: string; title: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (custom) {
      if (custom.test(line.trim())) hits.push({ index: i, heading: line.trim(), title: line.trim() })
      continue
    }
    const h = matchHeading(line)
    if (!h) continue
    // Markdown 的 `#` 标题只在它前面有明显空档时才算分章点，避免把每一行小结都切开
    if (line.trim().startsWith('#')) {
      const prev = i > 0 ? lines[i - 1].trim() : ''
      if (i > 0 && prev && !/^#{1,3}\s/.test(prev)) continue
    }
    const heading = line.trim()
    const title = h.keepPrefix ? h.rest.replace(/^#+\s*/, '').trim() : h.rest
    hits.push({ index: i, heading, title: title || heading })
  }

  if (!hits.length) {
    const only = src.trim()
    return only ? [toChapter('', only, opts.singleTitle || '全文导入')] : []
  }

  const out: ImportChapter[] = []
  // 第一个标题之前的引子（书名、作者、序言等）：不丢，并进第一章
  const preface = lines.slice(0, hits[0].index).join('\n').trim()
  for (let k = 0; k < hits.length; k++) {
    const cur = hits[k]
    const next = hits[k + 1]
    const bodyLines = lines.slice(cur.index + 1, next ? next.index : lines.length)
    let body = bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
    if (k === 0 && preface) body = `${preface}\n\n${body}`
    out.push(toChapter(cur.heading, body, cur.title))
  }
  return out
}

/* ------------------------------------------------------------------ 解码 */

export interface DecodeResult {
  text: string
  encoding: string
  /** 宽松解码时出现的替换符数量（>0 说明编码大概率没猜对） */
  suspicious: number
}

/** 把二进制稿件解成文本：BOM → UTF-8 严格 → GB18030 → 兜底 */
export function decodeText(buf: ArrayBuffer): DecodeResult {
  const bytes = new Uint8Array(buf)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)', suspicious: 0 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE', suspicious: 0 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16BE', suspicious: 0 }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text, encoding: 'UTF-8', suspicious: 0 }
  } catch {
    /* 不是合法 UTF-8，继续试中文老编码 */
  }

  for (const enc of ['gb18030', 'gbk', 'big5']) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(bytes)
      return { text, encoding: enc.toUpperCase(), suspicious: 0 }
    } catch {
      /* 换下一个 */
    }
  }

  const text = new TextDecoder('utf-8').decode(bytes)
  const suspicious = (text.match(/\uFFFD/g) || []).length
  return { text, encoding: 'UTF-8 (宽松，可能有乱码)', suspicious }
}

/* ------------------------------------------------------------------ 落盘 */

export interface ImportOptions {
  /** 目标卷名；为空则直接放进 正文/ 根目录 */
  volumeName?: string | null
  /** 已经有正文的章按「草稿」入库，空章按「待写」 */
  emptyAsTodo?: boolean
  onProgress?: (done: number, total: number, title: string) => void
}

export interface ImportResult {
  created: { id: string; title: string; words: number }[]
  totalWords: number
}

/**
 * 把切好的章节写进作品。
 * 一律走 createChapter 拿新序号 —— 导入只追加，绝不覆盖已有章节。
 */
export async function importChapters(ref: DirRef, chapters: ImportChapter[], opts: ImportOptions = {}): Promise<ImportResult> {
  let volumeId: string | null = null
  if (opts.volumeName && opts.volumeName.trim()) {
    const v = await createVolume(ref, opts.volumeName.trim())
    volumeId = v.id
  }

  const created: ImportResult['created'] = []
  let total = 0
  let i = 0
  for (const c of chapters) {
    i++
    opts.onProgress?.(i, chapters.length, c.title)
    const title = c.title.trim() || `第${i}章`
    const ch = await createChapter(ref, volumeId, title)
    const hasBody = c.body.trim().length > 0
    if (hasBody) {
      await saveChapter(ref, ch.id, c.body, { title, status: '草稿' })
    } else if (!opts.emptyAsTodo) {
      await saveChapter(ref, ch.id, c.body, { title, status: '待写' })
    }
    created.push({ id: ch.id, title, words: c.words })
    total += c.words
  }
  return { created, totalWords: total }
}

/** 从 File / Blob 直接读完并切好，供 UI 一步调用 */
export async function planFromFile(file: File | Blob, opts: SplitOptions = {}): Promise<{
  encoding: string
  suspicious: number
  totalWords: number
  chapters: ImportChapter[]
}> {
  const buf = await file.arrayBuffer()
  const dec = decodeText(buf)
  const chapters = splitChapters(dec.text, opts)
  return {
    encoding: dec.encoding,
    suspicious: dec.suspicious,
    totalWords: chapters.reduce((s, c) => s + c.words, 0),
    chapters
  }
}

/**
 * 列出「作品根目录下作者自己丢进来的稿件文件」。
 *
 * 只看根目录：作者把 全稿.txt 直接拖进作品文件夹是最自然的做法；
 * 而 正文/ 里的 .md 是已经入库的章节，再把它们列成「可导入」只会让人重复导入。
 */
export async function listLooseTxt(ref: DirRef): Promise<string[]> {
  try {
    const entries = await fs().listDir(ref, [])
    return entries
      .filter((e) => e.kind === 'file' && /\.(txt|md|markdown)$/i.test(e.name) && !/^作品信息\.md$/i.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
