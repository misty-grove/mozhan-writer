/**
 * PDF → 纯文本
 *
 * 这一层存在的唯一理由：作者手里的稿子、参考资料，除了 Word 就是 PDF。
 * 但它有几个**必须说清**的边界，不说就是骗人：
 *
 * 1. pdfjs 有 1MB+，只在作者真的选了 .pdf 时才动态 import —— 不打进主包。
 * 2. PDF 没有「段落」这个概念，只有「文字摆在这个坐标上」。这里按 `hasEOL`
 *    断行、连续空行压成一个，能还原大部分排版，但**双栏、竖排、带文本框的**
 *    会串。读出来的东西一律先给作者看，作者确认后才当文风样本用。
 * 3. 扫描件 / 图片型 PDF **一个字都没有**（没有文字层）。这不能 silently 成功 ——
 *    必须明确告诉作者「这是扫描件，要 OCR，本应用不联网所以做不了」。
 */

export interface PdfResult {
  text: string
  pages: number
  /** 读出来了，但有保留意见（空文字层、文字极少、栏序可能乱） */
  warnings: string[]
}

const CJK = /[一-龥]/

export async function pdfToText(input: ArrayBuffer | Uint8Array): Promise<PdfResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const pdfjs: any = await import('pdfjs-dist')
  const worker: any = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default || worker

  // getDocument 会接管（transfer）传进去的 buffer，给一份副本，免得调用方手里那份被掏空
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise
  const warnings: string[] = []
  try {
    const lines: string[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      let line = ''
      for (const it of (tc.items || []) as any[]) {
        const s = typeof it?.str === 'string' ? it.str : ''
        if (!s) continue
        line += s
        if (it.hasEOL) {
          lines.push(line.replace(/\s+$/, ''))
          line = ''
        }
      }
      if (line.trim()) lines.push(line.replace(/\s+$/, ''))
      lines.push('') // 换页：空一行，别把两页的段连成一段
    }
    const text = lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

    if (!text) {
      warnings.push(
        '这个 PDF 里没有文字层 —— 多半是扫描件或图片转成的 PDF。' +
          '这种要先做 OCR（本应用不联网，做不了），请先转成 txt / docx 再导入。'
      )
    } else if (text.length < 60) {
      warnings.push(`只读出 ${text.length} 个字，可能不是正文（目录页 / 扫描件 / 特殊字体）。`)
    } else if (!CJK.test(text)) {
      warnings.push('读出来的正文里没有中文字符 —— 可能是图片型 PDF 或用了特殊编码，建议换 txt / docx。')
    }
    if (doc.numPages > 1 && text.includes('\n') && text.split('\n').length < doc.numPages) {
      warnings.push('多页内容的行序可能是乱的（双栏 / 文本框排版的 PDF 常见），导入后请先自己看一眼。')
    }
    return { text, pages: doc.numPages || 0, warnings }
  } finally {
    try {
      await doc.destroy()
    } catch {
      /* 关不掉就算了，不影响结果 */
    }
  }
}
