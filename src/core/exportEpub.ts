/**
 * EPUB 导出（P2-29）
 *
 * zip 用 core/zip.ts（自研 store 模式），EPUB 3 的文件就那么几个，手写比引库可控。
 * 生成的是标准 EPUB 3（带 toc.ncx 兼容老阅读器），可以直接送进 Calibre / Apple Books / 微信读书。
 */
import type { ExportItem } from './exportDoc'
import { makeZip, type ZipEntry } from './zip'

export type { ZipEntry } from './zip'

/* ------------------------------------------------------------ Markdown → XHTML */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** 够用就好的 Markdown → XHTML：段落、标题、引用、列表、分隔线 */
export function mdToXhtml(md: string): string {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let inList = false
  let inQuote = false

  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>')
      inQuote = false
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      closeList()
      closeQuote()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      closeQuote()
      const lv = Math.min(6, h[1].length)
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      closeList()
      if (!inQuote) {
        out.push('<blockquote>')
        inQuote = true
      }
      out.push(`<p>${inline(line.replace(/^>\s?/, ''))}</p>`)
      continue
    }
    closeQuote()
    if (/^([-*+]|\d+\.)\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(line.replace(/^([-*+]|\d+\.)\s+/, ''))}</li>`)
      continue
    }
    closeList()
    if (/^(-{3,}|\*{3,})$/.test(line)) {
      out.push('<hr/>')
      continue
    }
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  closeQuote()
  return out.join('\n')
}

/* ------------------------------------------------------------ EPUB 组装 */

export interface EpubMeta {
  title: string
  author: string
  language?: string
  /** 简介，写在 OPF 的 description 里 */
  brief?: string
}

function xmlEsc(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function page(title: string, bodyHtml: string, lang = 'zh-CN'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${xmlEsc(title)}</title></head>
<body>
<h1>${xmlEsc(title)}</h1>
${bodyHtml}
</body>
</html>`
}

/** 生成 EPUB 的 Blob；items 已按顺序排好 */
export function buildEpub(items: ExportItem[], meta: EpubMeta): Blob {
  const lang = meta.language || 'zh-CN'
  const id = 'book-' + Date.now().toString(36)
  const bytes = (s: string) => new TextEncoder().encode(s)

  const entries: ZipEntry[] = []

  // mimetype 必须第一个且未压缩
  entries.push({ name: 'mimetype', data: bytes('application/epub+zip'), raw: true })
  entries.push({
    name: 'META-INF/container.xml',
    data: bytes(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  })

  const pages: Array<{ file: string; title: string }> = []
  items.forEach((it, i) => {
    const file = `OEBPS/ch${String(i + 1).padStart(4, '0')}.xhtml`
    pages.push({ file, title: it.title })
    entries.push({ name: file, data: bytes(page(it.title, mdToXhtml(it.body || '').replace(/^<h1>.*?<\/h1>\s*/, ''), lang)) })
  })

  const manifest = [
    '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    ...pages.map((p, i) => `<item id="p${i + 1}" href="${p.file.replace('OEBPS/', '')}" media-type="application/xhtml+xml"/>`)
  ].join('\n    ')

  const spine = pages.map((_, i) => `<itemref idref="p${i + 1}"/>`).join('\n    ')

  entries.push({
    name: 'OEBPS/content.opf',
    data: bytes(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${id}</dc:identifier>
    <dc:title>${xmlEsc(meta.title)}</dc:title>
    <dc:creator>${xmlEsc(meta.author || '佚名')}</dc:creator>
    <dc:language>${lang}</dc:language>
    ${meta.brief ? `<dc:description>${xmlEsc(meta.brief)}</dc:description>` : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>`)
  })

  entries.push({
    name: 'OEBPS/nav.xhtml',
    data: bytes(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${pages.map((p) => `<li><a href="${p.file.replace('OEBPS/', '')}">${xmlEsc(p.title)}</a></li>`).join('\n')}
</ol></nav>
</body>
</html>`)
  })

  entries.push({
    name: 'OEBPS/toc.ncx',
    data: bytes(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${lang}">
  <head><meta name="dtb:uid" content="urn:uuid:${id}"/></head>
  <docTitle><text>${xmlEsc(meta.title)}</text></docTitle>
  <navMap>
${pages
  .map(
    (p, i) =>
      `    <navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlEsc(p.title)}</text></navLabel><content src="${p.file.replace(
        'OEBPS/',
        ''
      )}"/></navPoint>`
  )
  .join('\n')}
  </navMap>
</ncx>`)
  })

  return makeZip(entries, 'application/epub+zip')
}
