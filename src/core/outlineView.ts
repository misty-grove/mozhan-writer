/**
 * 大纲翻阅视图用的「轻量 Markdown → HTML」。
 *
 * 为什么不引 markdown-it：大纲翻阅是低频只读操作，为它把一个 40KB 的库
 * 打进首屏不划算；而且大纲用到的语法就那几样（标题 / 表格 / 列表 / 粗体 / 引用）。
 *
 * 安全：输入先整体 HTML 转义，再按行组装 —— 作者自己文件里的内容也当不可信，
 * 万一手滑粘了段 <script> 进去，不能让它跑起来。
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内样式：粗体、行内代码 */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function mdToSimpleHtml(md: string): string {
  const lines = (md || '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let listOpen = false
  let tableBuf: string[][] = []

  const closeList = () => {
    if (listOpen) {
      out.push('</ul>')
      listOpen = false
    }
  }
  const flushTable = () => {
    if (!tableBuf.length) return
    const rows = tableBuf.filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)))
    if (rows.length) {
      out.push('<table>')
      rows.forEach((cells, i) => {
        const tag = i === 0 ? 'th' : 'td'
        out.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`)
      })
      out.push('</table>')
    }
    tableBuf = []
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const t = line.trim()
    if (!t) {
      closeList()
      flushTable()
      continue
    }
    const cells = /^\|(.+)\|$/.exec(t)
    if (cells) {
      closeList()
      tableBuf.push(
        cells[1]
          .split('|')
          .map((c) => c.trim())
          .filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c))
      )
      continue
    }
    flushTable()
    const h = /^(#{1,6})\s+(.+)$/.exec(t)
    if (h) {
      closeList()
      const lv = Math.min(4, h[1].length)
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
      continue
    }
    if (/^---+$/.test(t)) {
      closeList()
      out.push('<hr />')
      continue
    }
    const li = /^[-*]\s+(.+)$/.exec(t)
    if (li) {
      if (!listOpen) {
        out.push('<ul>')
        listOpen = true
      }
      out.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    closeList()
    const q = /^>\s?(.*)$/.exec(t)
    if (q) {
      out.push(`<blockquote>${inline(q[1])}</blockquote>`)
      continue
    }
    out.push(`<p>${inline(t)}</p>`)
  }
  closeList()
  flushTable()
  return out.join('\n')
}
