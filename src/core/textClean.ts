/**
 * 导入文本的「去噪」
 *
 * 作者手里的大纲经常是 AI 生成后直接粘过来的，带着一串机器味道：
 *  - 零宽字符（从网页复制时最常见，肉眼看不见但会让文件名/检索出错）；
 *  - 起强调作用的弯引号 —— "主角" 拿到一支 "神奇的笔"。这不是对话，
 *    是模型学来的强调习惯，读起来一股 AI 味；
 *  - emoji 与小装饰符号（✨🎯✅）—— 大纲不是 PPT；
 *  - 连续空行、行尾空格、Markdown 转义残留（\* \_）。
 *
 * 三条底线：
 *  1. **对话引号一律不动**。引号对里含标点、数字、字母，或较长（>12 字），
 *     视为正常对话/引用，原样保留 —— 宁可漏过几个强调引号，也不能把小说对话拆了。
 *  2. **全文只出现一两次的引号不动**。少量使用更像作者有意为之（专有名词、梗），
 *     成把出现才是模型的强调习惯。
 *  3. 表格里的全角空格占位（`| 　 |`）不受影响 —— 连续两个以上才动。
 */

export interface CleanOptions {
  /** 去掉起强调作用的弯引号（默认 true） */
  dropEmphasisQuotes?: boolean
  /** 去掉 emoji 与装饰符号（默认 true） */
  dropDecorations?: boolean
}

/** 零宽 / 不可见字符：肉眼看不见，但会进文件名、进检索、进统计 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g
/** emoji 与常见装饰符号（不含 ←→↑↓ 这类可能有意义的方向符） */
const DECORATION = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2044}]/gu
/** Markdown 转义残留：`\*` `\_` `\#` 在正文里没有意义 */
const ESCAPED = /\\([*_#`])/g
/** 弯引号对：内容 1–12 字、不含标点数字字母，才可能是「强调」 */
const EMPHASIS_PAIR = /([\u201C\u2018])([^\u201C\u201D\u2018\u2019\n]{1,12})([\u201D\u2019])/g
/** 直引号对（AI 也爱用 "xxx"）：内容必须是**纯中文**才动，英文/代码/对话一概不碰 */
const EMPHASIS_PAIR_ASCII = /"([^"\n]{1,12})"/g
const PURE_CJK = /^[\u4e00-\u9fff\u3400-\u4dbf]+$/
/** 强调用法判定：内容里出现这些字符就不动它（对话、引用、专有名词） */
const MEANINGFUL = /[，。！？；：、（）…—\dA-Za-z"'"「」『』]/

export function cleanOutlineNoise(md: string, opts: CleanOptions = {}): string {
  const dropQuotes = opts.dropEmphasisQuotes !== false
  const dropDeco = opts.dropDecorations !== false
  let s = md || ''
  if (!s.trim()) return ''

  s = s.replace(/\r\n?/g, '\n').replace(INVISIBLE, '')
  if (dropDeco) s = s.replace(DECORATION, '')

  // 行尾空白 + 连续空行压成一段（作者从 Word 粘过来经常带一堆空行）
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\u3000]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

  if (dropQuotes) {
    const curly = (s.match(/[\u201C\u201D\u2018\u2019]/g) || []).length
    // 全文 4 次以上才认为是「强调习惯」；一两次留着，可能作者真有引用
    if (curly >= 4) {
      s = s.replace(EMPHASIS_PAIR, (whole, open, inner) => {
        const t = inner.trim()
        if (!t || t.length > 12 || MEANINGFUL.test(t)) return whole
        return t
      })
    }
    const straight = (s.match(/"/g) || []).length
    if (straight >= 4) {
      s = s.replace(EMPHASIS_PAIR_ASCII, (whole, inner) => {
        const t = inner.trim()
        // 纯中文短词才当强调；带字母数字标点的一律是对话/代码/引用
        if (!PURE_CJK.test(t) || t.length > 12) return whole
        return t
      })
    }
  }

  s = s.replace(ESCAPED, '$1')
  // 连续两个以上全角空格压成一个（表格占位 `| 　 |` 只有一个，不动）
  s = s.replace(/\u3000{2,}/g, '\u3000')
  return s.replace(/\s+$/, '') + '\n'
}

/** 标题专用：比全文清洗更狠 —— 标题里任何引号、装饰、范围注释都不该出现 */
export function cleanHeadingTitle(t: string): string {
  let s = (t || '').replace(INVISIBLE, '').replace(DECORATION, '')
  s = s.replace(/\*\*/g, '').replace(/^#+\s*/, '').replace(/\s*#+$/, '')
  // 「第一卷 启程（第1章-第40章）」→「第一卷 启程」：范围注释是排版残留，不是卷名
  // 三种形态都认：第1章-第40章 / 1-40章 / 第1-40章
  s = s.replace(/[（(【\[]\s*第?\s*[\d零一二三四五六七八九十百千万两]+\s*[章回节]?\s*[-~—至到]\s*第?\s*[\d零一二三四五六七八九十百千万两]+\s*[章回节]?\s*[)）\]】]/g, '')
  s = s.replace(ESCAPED, '$1')
  s = s.replace(/[\u201C\u201D\u2018\u2019"']/g, '')
  s = s.replace(/[：:、，,。.；;]\s*$/, '')
  return s.replace(/\s{2,}/g, ' ').trim()
}
