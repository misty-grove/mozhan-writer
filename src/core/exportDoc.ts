/** 导出：TXT / Markdown / 合并单文件 / DOCX（离线本地生成，不依赖 pandoc） */
import type { Chapter, Volume } from './types'

export interface ExportOptions {
  format: 'txt' | 'md' | 'docx' | 'epub'
  scope: 'all' | 'volume' | 'range'
  volumeId?: string
  from?: number
  to?: number
  includeTitle: boolean
  headingStyle: '第X章' | '数字' | 'none'
  /** 自定义导出模板（插件/导出/*.md），设了就按模板渲染 */
  templatePath?: string
}

export interface ExportItem {
  file: string
  title: string
  body: string
}

export function defaultExportOptions(): ExportOptions {
  return { format: 'txt', scope: 'all', includeTitle: true, headingStyle: '第X章' }
}

export function collectChapters(
  volumes: Volume[],
  rootChapters: Chapter[],
  bodies: Record<string, string>,
  opt: ExportOptions
): ExportItem[] {
  let pool: Chapter[] = []
  if (opt.scope === 'all') {
    pool = [...rootChapters, ...volumes.flatMap((v) => v.chapters)]
  } else if (opt.scope === 'volume') {
    const v = volumes.find((x) => x.id === opt.volumeId)
    pool = v ? v.chapters : []
  } else {
    const ordered = [...rootChapters, ...volumes.flatMap((v) => v.chapters)]
    pool = ordered.slice((opt.from ?? 1) - 1, opt.to ?? ordered.length)
  }
  return pool.map((c) => ({ file: c.file, title: c.title, body: bodies[c.id] || '' }))
}

function heading(item: ExportItem, i: number, style: ExportOptions['headingStyle']): string {
  if (style === 'none') return item.title
  const m = /第\s*(\d+)\s*章/.exec(item.file)
  const n = style === '数字' ? String(i + 1) : String(m ? Number(m[1]) : i + 1)
  return `第${n}章 ${item.title}`
}

export function toText(items: ExportItem[], opt: ExportOptions): string {
  const parts: string[] = []
  items.forEach((it, i) => {
    if (opt.includeTitle) parts.push(heading(it, i, opt.headingStyle))
    parts.push((it.body || '').trim())
  })
  return parts.join('\n\n') + '\n'
}

export function toMarkdown(items: ExportItem[], opt: ExportOptions, title: string): string {
  const parts = [`# ${title}`, '']
  items.forEach((it, i) => {
    if (opt.includeTitle) parts.push(`## ${heading(it, i, opt.headingStyle)}`, '')
    parts.push((it.body || '').trim(), '')
  })
  return parts.join('\n')
}

export async function toDocxBlob(
  title: string,
  author: string,
  items: ExportItem[],
  opt: ExportOptions
): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, PageBreak } = await import('docx')
  const children: any[] = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 44 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 }
    })
  ]
  if (author) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `作者：${author}`, size: 24 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 }
      })
    )
  }
  items.forEach((it, i) => {
    children.push(new Paragraph({ children: [new PageBreak()] }))
    if (opt.includeTitle) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: heading(it, i, opt.headingStyle), bold: true, size: 32 })],
          heading: HeadingLevel.HEADING_1,
          spacing: { after: 300 }
        })
      )
    }
    for (const line of (it.body || '').split(/\r?\n/)) {
      const t = line.trim()
      if (!t) {
        children.push(new Paragraph({ children: [] }))
        continue
      }
      children.push(
        new Paragraph({
          children: [new TextRun({ text: t, size: 24 })],
          spacing: { after: 120, line: 360 },
          indent: { firstLine: 480 }
        })
      )
    }
  })
  const doc = new Document({
    creator: author || '墨栈写作台',
    title,
    styles: { default: { document: { run: { font: '宋体', size: 24 } } } },
    sections: [{ children }]
  })
  return await Packer.toBlob(doc)
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}
