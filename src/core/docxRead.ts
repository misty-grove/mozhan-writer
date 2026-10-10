/**
 * Word（.docx）→ Markdown
 *
 * 作者手里的稿子、大纲、卷纲，十有八九躺在 Word 里。.docx 其实就是一个 zip，
 * 真正的文字在 `word/document.xml` 里，所以**不需要任何新依赖** —— 工程里已经
 * 有 fflate（备份/导出在用），这里拿它解 zip，再用一小段扫描器把 OOXML 读成
 * Markdown。全程离线，不联网、不上传。
 *
 * 三条硬规矩：
 * 1. **不碰 DOMParser**：selfcheck 跑在 Node 里，没有浏览器的 XML 解析器。
 *    所以这里用正则扫描而不是「解析成 DOM 再取文本」—— 换来的好处是同一段代码
 *    在浏览器 / 桌面 / 自检里行为完全一致。
 * 2. **表格必须转对**：大纲常常就是一张 Word 表（章节 / 目标 / 字数），
 *    转成 GFM 表格后，`core/outline.ts` 的 `parseOutlineMarkdown` 才能原样读回来。
 *    表头行不加粗（否则 `**章节**` 会被当成一行数据）。
 * 3. **认不出就当正文**：Word 里"看起来像标题"的段落实在太多（加大字号、加粗、
 *    手动编号）。默认只认真正的标题样式（Heading N / outlineLvl），
 *    把「加粗短行当标题」做成**可选**开关交给作者决定，绝不替他猜。
 */

import { unzipSync } from 'fflate'

export interface DocxOptions {
  /** Word 里没用标题样式、只是加粗当标题时，把短粗行也认成标题（默认关） */
  boldAsHeading?: boolean
}

export interface DocxResult {
  text: string
  /** 认出来的段落数（给 UI 显示"读出来多少段"） */
  paragraphs: number
  tables: number
  /** 被丢掉的东西（图片、文本框等）—— 静默丢弃是 bug 的来源，要说出来 */
  warnings: string[]
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const n = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(n) && n >= 0 ? String.fromCodePoint(n) : m
    }
    return ENT[g] ?? m
  })
}

/* ------------------------------------------------------------------ 切块 */

type Block = { kind: 'p'; xml: string } | { kind: 'tbl'; xml: string }

/** 开放标签结束的位置（属性里出现 `>` 的情况在 OOXML 里不存在，直接找即可） */
function tagEnd(xml: string, from: number): number {
  const gt = xml.indexOf('>', from)
  return gt < 0 ? xml.length : gt + 1
}

/** 找到与 from 处那个 `<w:tag>` 配对的 `</w:tag>`（表格可嵌套，所以要计数） */
function closeOf(xml: string, from: number, tag: string): number {
  const openRe = new RegExp(`<w:${tag}(?=[\\s/>])`, 'g')
  const closeRe = new RegExp(`</w:${tag}>`, 'g')
  let depth = 1
  let p = from
  while (depth > 0) {
    openRe.lastIndex = p
    const o = openRe.exec(xml)
    closeRe.lastIndex = p
    const c = closeRe.exec(xml)
    if (!c) return xml.length
    if (o && o.index < c.index) {
      depth++
      p = o.index + o[0].length
    } else {
      depth--
      p = c.index + c[0].length
    }
  }
  return p
}

/**
 * 把 body 切成「段落 / 表格」序列。
 * 注意 `<w:pPr>`（段落属性）也以 `<w:p` 开头 —— 用 `(?=[\s/>])` 把它排除掉。
 */
export function splitBlocks(xml: string): Block[] {
  const out: Block[] = []
  const re = /<w:(p|tbl)(?=[\s/>])/g
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    if (m.index < i) continue
    const open = tagEnd(xml, m.index)
    if (xml.slice(m.index, open).endsWith('/>')) {
      i = open // 自闭合的空段
      continue
    }
    if (m[1] === 'p') {
      const end = xml.indexOf('</w:p>', open)
      const stop = end < 0 ? xml.length : end + '</w:p>'.length
      out.push({ kind: 'p', xml: xml.slice(m.index, stop) })
      i = stop
    } else {
      const stop = closeOf(xml, open, 'tbl')
      out.push({ kind: 'tbl', xml: xml.slice(m.index, stop) })
      i = stop
    }
  }
  return out
}

/* ------------------------------------------------------------------ 段落 */

/** `<w:b/>` 才是加粗；`<w:b w:val="0"/>` 是显式取消 */
function isBold(run: string): boolean {
  return /<w:b(?=[\s/>])/.test(run) && !/<w:b\s+w:val="(0|false)"\s*\/>/.test(run)
}

/** 一个 run（或整段）里的文字：`<w:tab/>`→空格、`<w:br/>`→换行，其余标签去掉 */
function runsText(xml: string): string {
  const s = xml
    .replace(/<w:tab[^>]*\/>/g, ' ')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_m, t: string) => t)
    .replace(/<[^>]+>/g, '')
  return decodeEntities(s).replace(/[ \t]+/g, ' ')
}

export interface ParaInfo {
  level: number
  text: string
  /** 整段都是粗体（用于可选的「加粗短行当标题」） */
  bold: boolean
  /** 字号（半点，Word 里 21 = 10.5pt）；没有取到为 0 */
  size: number
  list: boolean
}

const PPR_RE = /<w:pPr[^>]*\/>|<w:pPr[^>]*>[\s\S]*?<\/w:pPr>/g

/** 段落 → 标题级别 / 文本 / 是否列表项 */
export function parseParagraph(pXml: string): ParaInfo {
  const pPr = pXml.match(PPR_RE)?.[0] || ''
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1] || ''
  const lvl = /<w:outlineLvl\s+w:val="(\d+)"/.exec(pPr)?.[1]
  const numPr = /<w:numPr(?=[\s/>])/.test(pPr)

  let level = 0
  // Heading1 / 标题 1 / "1"（Word 内置标题样式的几种叫法）
  const hs = /heading\s*([1-6])/i.exec(style) || /标题\s*([1-6])/.exec(style) || /^\s*([1-6])\s*$/.exec(style)
  if (hs) level = Number(hs[1])
  else if (lvl !== undefined) level = Number(lvl) + 1

  const body = pXml.replace(PPR_RE, '')
  const runs = body.match(/<w:r(?=[\s/>])[\s\S]*?<\/w:r>/g) || []

  let text = ''
  let allBold = runs.length > 0
  for (const r of runs) {
    const b = isBold(r)
    if (!b) allBold = false
    const t = runsText(r)
    if (!t) continue
    // 粗体只在「段落里混排」时才有意义；整段粗体另作标题候选处理，不逐 run 加 **
    text += b && !allBold ? `**${t.trim()}**` : t
  }
  // 段里一个 run 都没有（比如只有 bookmark）：退化为整段文本
  if (!runs.length) text = runsText(body)

  const sz = /<w:sz\s+w:val="(\d+)"/.exec(pPr)?.[1] || ''
  return {
    level,
    text: text.replace(/\s+$/, '').replace(/^\s+/, ''),
    bold: allBold && text.trim().length > 0,
    size: Number(sz) || 0,
    list: numPr
  }
}

/* ------------------------------------------------------------------ 表格 */

/** 表格 → 二维数组（单元格内的多段用空格拼起来，避免打断表格行） */
export function parseTable(tXml: string): string[][] {
  const rows: string[][] = []
  const trRe = /<w:tr(?=[\s/>])/g
  let m: RegExpExecArray | null
  let i = 0
  while ((m = trRe.exec(tXml)) !== null) {
    if (m.index < i) continue
    const open = tagEnd(tXml, m.index)
    if (tXml.slice(m.index, open).endsWith('/>')) {
      i = open
      continue
    }
    const stop = closeOf(tXml, open, 'tr')
    const tr = tXml.slice(m.index, stop)
    i = stop
    const cells: string[] = []
    const tcRe = /<w:tc(?=[\s/>])/g
    let c: RegExpExecArray | null
    let j = 0
    while ((c = tcRe.exec(tr)) !== null) {
      if (c.index < j) continue
      const cOpen = tagEnd(tr, c.index)
      if (tr.slice(c.index, cOpen).endsWith('/>')) {
        j = cOpen
        continue
      }
      const cStop = closeOf(tr, cOpen, 'tc')
      const tc = tr.slice(c.index, cStop)
      j = cStop
      const paras = splitBlocks(tc).filter((b): b is { kind: 'p'; xml: string } => b.kind === 'p')
      cells.push(paras.map((p) => parseParagraph(p.xml).text).join(' ').trim())
    }
    if (cells.length) rows.push(cells)
  }
  return rows
}

/** 表格 → GFM 表格行（首行按表头处理：不加粗，后面补分隔行） */
export function tableToMarkdown(rows: string[][]): string[] {
  if (!rows.length) return []
  const width = Math.max(...rows.map((r) => r.length))
  const norm = (cells: string[]) => {
    const c = cells.slice(0, width)
    while (c.length < width) c.push('')
    // 单元格里出现 `|` 会把表格撑坏
    return c.map((x) => x.replace(/\|/g, '\\|').trim())
  }
  const out = ['| ' + norm(rows[0]).join(' | ') + ' |']
  out.push('| ' + norm(rows[0]).map(() => '---').join(' | ') + ' |')
  for (let i = 1; i < rows.length; i++) out.push('| ' + norm(rows[i]).join(' | ') + ' |')
  return out
}

/* ------------------------------------------------------------------ 主入口 */

/** 加粗短行 → 标题级别：按字号从大到小依次给 1/2/3，字号相同则同级 */
function levelsBySize(sizes: number[]): number[] {
  const uniq = [...new Set(sizes.filter((s) => s > 0))].sort((a, b) => b - a)
  return sizes.map((s) => (s > 0 ? Math.min(3, uniq.indexOf(s) + 1) : 2))
}

export function docxToMarkdown(input: ArrayBuffer | Uint8Array, opts: DocxOptions = {}): DocxResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (e: any) {
    throw new Error(`这个文件打不开（不是有效的 .docx）：${e?.message || e}`)
  }
  const xmlBytes = files['word/document.xml']
  if (!xmlBytes) {
    // .doc（Word 97-2003）是二进制格式，不是一个 zip；也别硬解
    throw new Error('没找到 word/document.xml —— 老版 .doc 读不了，请用 Word 另存为 .docx 再来。')
  }
  const xml = new TextDecoder('utf-8').decode(xmlBytes)
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml

  const blocks = splitBlocks(body)
  const warnings: string[] = []
  let paragraphs = 0
  let tables = 0

  // 第一遍：收集段落信息（决定是否启用「加粗短行当标题」）
  const paras = blocks.map((b) => (b.kind === 'p' ? parseParagraph(b.xml) : null))
  const candidates: number[] = []
  if (opts.boldAsHeading) {
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i]
      // 短（≤ 40 字）、整段粗体、本来没有标题样式、不是列表项 —— 才当标题候选
      if (p && p.level === 0 && p.bold && !p.list && p.text.length <= 40 && !/[。！？，、；]/.test(p.text)) {
        candidates.push(i)
      }
    }
  }
  const levelMap = new Map<number, number>()
  if (candidates.length) {
    const levels = levelsBySize(candidates.map((i) => paras[i]!.size))
    candidates.forEach((idx, k) => levelMap.set(idx, levels[k]))
  }

  const out: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind === 'tbl') {
      tables++
      const rows = parseTable(b.xml)
      if (!rows.length) continue
      out.push('', ...tableToMarkdown(rows), '')
      continue
    }
    const p = paras[i]!
    if (!p.text.trim()) continue
    paragraphs++
    const level = p.level || levelMap.get(i) || 0
    if (level > 0) out.push('', `${'#'.repeat(level)} ${p.text}`, '')
    else if (p.list) out.push(`- ${p.text}`)
    else out.push(p.text)
  }

  if (/<w:pict(?=[\s/>])|<w:drawing(?=[\s/>])|<w:object(?=[\s/>])/.test(body)) {
    warnings.push('文档里有图片 / 嵌入对象，导入时已跳过（大纲用不上）')
  }
  if (/<w:txbxContent(?=[\s/>])/.test(body)) {
    warnings.push('文档里有文本框，其中的文字没有读进来（建议把内容挪到正文里再导入）')
  }
  if (/<w:del(?=[\s/>])/.test(body)) {
    warnings.push('文档里有修订痕迹（删除线），被删掉的文字也一起读进来了，导入后请自己删一遍')
  }

  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trim()
  return { text, paragraphs, tables, warnings }
}
