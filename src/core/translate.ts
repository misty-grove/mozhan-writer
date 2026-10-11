/**
 * 正文翻译（中 / 英 / 日）—— 纯函数层
 *
 * 两件必须做对的事，否则「翻译」这个功能等于没有：
 *
 * 1. **长文要分块**。一章动辄三五千字，整章一次发过去，模型要么被截断、
 *    要么输出一半就停 —— 作者拿到的是「前半章译文 + 一段沉默」。
 *    所以按段落切成若干块逐块翻，再按原样拼回（`splitForTranslate` 保证
 *    拼回来跟原文一字不差，只多了块与块之间的边界）。
 *
 * 2. **翻译不是创作**。它不该拿到「上下文」（大纲/设定/记忆）那些东西 ——
 *    翻译只需要原文。也不该套正文创作那套规则：目标是英文时还要求
 *    「对话用中文双引号」就是自己给自己找麻烦。所以中文标点规范
 *    **只在目标语言是中文时才追加**（`translateSystem` 里那一处判据）。
 */
import { CN_PUNCT_RULE } from './quotes'

export type LangCode = 'zh' | 'en' | 'ja'

export const TRANS_LANGS: Array<{ k: LangCode; label: string; hint: string }> = [
  { k: 'zh', label: '中文', hint: '简体中文，中文标点' },
  { k: 'en', label: 'English', hint: '英文，英文标点' },
  { k: 'ja', label: '日本語', hint: '日文，日文标点' }
]

export function langLabel(k: string): string {
  return TRANS_LANGS.find((l) => l.k === k)?.label || k || '—'
}

export function isLang(k: string): k is LangCode {
  return k === 'zh' || k === 'en' || k === 'ja'
}

/* ------------------------------------------------------------------ 语言识别 */

const KANA = /[぀-ゟ゠-ヿ]/
const CJK = /[㐀-䶿一-鿿]/
const LATIN = /[A-Za-z]/

/**
 * 粗略判断原文是什么语言（只用来给提示词一个「从哪翻到哪」的提示，
 * 不追求准确 —— 判断错了作者还能在界面上改）。
 *
 * 顺序有讲究：**先认假名再认汉字**。日文里大量使用汉字，
 * 要是先判「有汉字就是中文」，日文会被认成中文。
 */
export function detectLang(text: string): LangCode | '' {
  if (!text) return ''
  const sample = text.slice(0, 4000)
  let kana = 0
  let cjk = 0
  let latin = 0
  for (const ch of sample) {
    if (KANA.test(ch)) kana++
    else if (CJK.test(ch)) cjk++
    else if (LATIN.test(ch)) latin++
  }
  if (kana > 0) return 'ja'
  if (cjk > 0) return cjk >= latin ? 'zh' : 'en'
  if (latin > 20) return 'en'
  return ''
}

/* ------------------------------------------------------------------ 分块 */

/** 句子结束符（中文 / 英文 / 日文都用得上） */
const SENT_END = /([。．.！!？?…；;])\s*/

/**
 * 把长文切成若干块，**尽量不切断段落**。
 *
 * 拼接不变量：**每一段正文都完整地落在某一块里，一个字都不会少**。
 * 这一点有断言盯着 —— 分块把作者的字吃掉是最难发现的一类 bug
 * （译文看着挺顺，其实中间少了一整段）。
 *
 * `sep` 是「这块和上一块之间怎么接」，必须跟着块一起返回：
 *  - `\n\n` = 另起一段（绝大多数情况）；
 *  - `\n`   = 同一段里被切开的地方（只有单段超过 maxChars 时才会这样）。
 * 少了这个标记，拼接时只能一律用 `\n\n`，结果是**译文把作者的一段拆成了几段**，
 * 或者反过来把两段并成一段 —— 那是在悄悄改作者的分段。
 *
 * 空白行不单独成块（整段空行没有可翻的内容）；原文里连续几个空行，
 * 拼回时会归一成一个 —— 这是唯一一处有意的规范化。
 */
export interface TransChunk {
  text: string
  /** 与上一块之间的连接符；第一块为空串 */
  sep: string
}

export function splitForTranslate(text: string, maxChars = 1600): TransChunk[] {
  const src = text || ''
  if (!src.trim()) return []
  // 先按「空行」切成段：段是翻译的最小完整单位，绝不在段中间下刀
  const paras = src.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean)
  const out: TransChunk[] = []
  let buf: string[] = []
  let size = 0

  const flush = () => {
    if (!buf.length) return
    out.push({ text: buf.join('\n\n'), sep: out.length ? '\n\n' : '' })
    buf = []
    size = 0
  }

  for (const p of paras) {
    if (p.length > maxChars) {
      // 单段太长：先把攒着的吐出来，再按句把这一段切开（sep 用 '\n'，仍是同一段）
      flush()
      let rest = p
      while (rest.length > maxChars) {
        let cut = -1
        const re = new RegExp(SENT_END.source, 'g')
        let m: RegExpExecArray | null
        while ((m = re.exec(rest))) {
          if (m.index + m[0].length > maxChars) break
          cut = m.index + m[0].length
        }
        if (cut <= 0) cut = maxChars
        out.push({ text: rest.slice(0, cut).trim(), sep: out.length ? '\n' : '' })
        rest = rest.slice(cut)
      }
      if (rest.trim()) out.push({ text: rest.trim(), sep: out.length ? '\n' : '' })
      continue
    }
    if (size + p.length > maxChars && size > 0) flush()
    buf.push(p)
    size += p.length + 2
  }
  flush()
  return out
}

/** 分块数（界面上先告诉作者这一章要翻几块，别让他对着转圈猜） */
export function chunkCount(text: string, maxChars = 1600): number {
  return splitForTranslate(text, maxChars).length
}

/** 把译文按块拼回：sep 跟着走，分段才不会被改 */
export function joinTranslated(parts: string[], chunks: TransChunk[]): string {
  return parts.map((t, i) => (i ? chunks[i]?.sep || '\n\n' : '') + (t || '').trim()).join('')
}

/* ------------------------------------------------------------------ 提示词 */

export interface TranslateOpts {
  from?: string
  /** 保留人名 / 地名的写法（不音译、不另起译名） */
  keepNames?: boolean
  /** 术语对照（作者自己填的，原样交给模型） */
  glossary?: string
  /** 作者的补充要求 */
  instruction?: string
}

/** 目标语言各自的排版规矩 */
function punctRule(to: LangCode): string {
  if (to === 'zh') return CN_PUNCT_RULE
  if (to === 'ja') return '出力規約：日本語の約物（「」『』、。）を使うこと。会話文は「」で囲む。英文の直引用符 " は使わない。'
  return 'Output rules: use English punctuation and English double quotes " " for dialogue; do not use CJK quotation marks.'
}

export function translateSystem(to: LangCode, opts: TranslateOpts = {}): string {
  const fromTxt = opts.from ? `原文语言：${langLabel(opts.from)}。` : ''
  const rules = [
    `你是专业文学翻译。把作者的小说正文翻译成${langLabel(to)}。`,
    fromTxt,
    '硬性要求：',
    '1. **只输出译文**。不要解释、不要注释、不要「以下是译文」这类开场白，不要输出标题。',
    '2. 保留原文的段落数与空行，保留 Markdown 标记（**加粗**、> 引用等）。',
    '3. 忠实原意，不增不减情节；文学性优先，但不要为了漂亮改写事实。',
    opts.keepNames === false ? '' : '4. 人名、地名、专有名词**保留原文写法**，不要音译、不要另起译名。',
    opts.glossary ? `5. 术语对照（必须遵守）：\n${opts.glossary.trim()}` : ''
  ].filter(Boolean)
  return [...rules, '', punctRule(to)].join('\n')
}

/**
 * 单块的指令。
 *
 * 分块翻译最容易出的毛病是「块与块之间文风不一致、人名前后不一」，
 * 所以每块都要强调「这是全文的一部分」并重复硬要求 ——
 * 模型看不到别的块，只能靠这一句把它按在同一条轨道上。
 */
export function chunkUser(chunk: string, index: number, total: number, to: LangCode, opts: TranslateOpts = {}): string {
  const head = total > 1 ? `这是全文的第 ${index + 1}/${total} 段（后面还有别的段，只翻译这一段）。\n` : ''
  const tail = opts.instruction ? `\n作者的补充要求：${opts.instruction.trim()}` : ''
  return `${head}请翻译成${langLabel(to)}：\n\n${chunk}${tail}`
}

/** 新章节的标题：带上目标语言，作者一眼知道这一章是哪一版 */
export function translatedTitle(title: string, to: LangCode): string {
  const base = (title || '').replace(/[（(].*?[）)]\s*$/, '').trim() || '未命名'
  return `${base}（${langLabel(to)}）`
}
