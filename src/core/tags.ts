/**
 * 题材标签库 + 「中文友好」的标签解析（2026-10-10）
 *
 * 为什么**不引分词库**（jieba / nodejieba / segment 之类）：
 *  - 它们要么带原生模块、要么带几 MB 词表。本机是 GNU 工具链、没有 VS，
 *    原生模块基本编不出来 —— 一旦挂在依赖上，`npm i` / 打包就整个卡住。
 *    作者要的是「能写字」，不是「装了分词器」。「不要因为分词问题影响工程」就是这条。
 *  - 这里真正要做的只有一件事：**把作者写下的一串词切开**。用标点/空白切就够了；
 *    再补一个「已知标签最长匹配」当兜底（`男频玄幻` 这种没打分隔符的也能认出来）。
 *  - 全部按 UTF-16 下标推进、长度按**码点**算，生僻字与 emoji 不会被劈成半个。
 *
 * 纯函数、零依赖 —— 所以 selfcheck（跑在无 localStorage 的 Node 里）能直接断言。
 */

export interface TagGroup {
  key: string
  label: string
  tags: string[]
  /** 组内单选（频道 / 篇幅：一个人不会同时是男频和女频） */
  single?: boolean
}

/** 频道：网文平台最先分的那一刀，AI 拿它定基调（爽点密度、感情线比重） */
export const CHANNEL_TAGS = ['男频', '女频']

/** 题材：热门大类，按平台榜单常见度排 —— 越靠前越常用 */
export const GENRE_TAGS = [
  '玄幻', '奇幻', '武侠', '仙侠', '都市', '现实', '历史', '军事',
  '科幻', '悬疑', '灵异', '游戏', '体育', '轻小说', '二次元',
  '无限流', '系统流', '末日', '穿越', '重生', '星际', '同人',
  '校园', '职场', '种田', '美食', '克苏鲁'
]

/** 风格 / 写法：决定节奏与情绪，不然同一题材能写出两种完全不同的书 */
export const STYLE_TAGS = [
  '轻松', '热血', '爽文', '甜宠', '虐恋', '群像', '单女主', '多女主',
  '无敌流', '成长流', '慢热', '日常', '快节奏', '反转', '正剧', '治愈', '暗黑', '沙雕'
]

/** 篇幅（单位：万字）。粗略档位，作者选了就顺带把「章数」定好 */
export const LENGTH_TAGS = ['0-50万字', '50-100万字', '100-150万字', '150-200万字', '200万字以上']

export const TAG_GROUPS: TagGroup[] = [
  { key: 'channel', label: '频道', tags: CHANNEL_TAGS, single: true },
  { key: 'genre', label: '题材', tags: GENRE_TAGS },
  { key: 'style', label: '风格 / 写法', tags: STYLE_TAGS },
  { key: 'length', label: '篇幅', tags: LENGTH_TAGS, single: true }
]

export const ALL_TAGS: string[] = TAG_GROUPS.flatMap((g) => g.tags)

/* ------------------------------------------------------------------ 切分

分隔符里**不能含 `-`** —— 篇幅标签 `100-150万字` 中间就是短横，把它当分隔符
会当场把标签切成 `100` 和 `150万字` 两个谁也不认识的碎片。
*/
const TAG_SEP = /[、,，;；:：/／|｜·・\u3000\s]+/

/** 首尾的成对符号/引号：作者从别处粘过来常常带着 */
const EDGE = /^[\s"'“”‘’《》〈〉【】〔〕()（）[\]{}<>「」]+|[\s"'“”‘’《》〈〉【】〔〕()（）[\]{}<>「」]+$/g

/** 单个标签最长码点数 —— 超过这个长度的多半是一句话，不是标签 */
const MAX_TAG_LEN = 24

/** 全角字母数字 → 半角（`ＡＩ` 与 `AI` 得算同一个标签，否则去重会漏） */
function foldWidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

/** 归一化：全角折半角、压缩空白、去首尾成对符号 */
export function normalizeTag(s: string): string {
  return foldWidth(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .replace(EDGE, '')
    .trim()
}

export interface TagPiece {
  text: string
  /** 是不是已知标签（否则是切剩下的自定义词） */
  known: boolean
}

/**
 * 在**没有分隔符**的一串字里做一次「最长匹配」切分（轻量分词）。
 *
 *   extractKnownTags('男频玄幻')     → 男频 / 玄幻
 *   extractKnownTags('都市异能爽文') → 都市 / 异能(自定义) / 爽文
 *   extractKnownTags('随便写写')     → hits 为空（调用方会整串原样保留）
 *
 * 只认已知标签，且**按出现的先后返回**（不能把切的顺序打乱 —— 标签读起来要顺）；
 * 切不出来就整串还给你 —— **宁可不切，也不瞎猜**。
 */
export function extractKnownTags(text: string, vocab: readonly string[] = ALL_TAGS): { hits: string[]; parts: TagPiece[] } {
  const src = normalizeTag(text)
  if (!src) return { hits: [], parts: [] }
  // 长的优先：'多女主' 必须比 '女主' 先匹配上（这里没有 '女主'，但规则要立住）
  const sorted = [...vocab].filter(Boolean).sort((a, b) => b.length - a.length)
  const hits: string[] = []
  const parts: TagPiece[] = []
  let buf = ''
  const flush = () => {
    const v = normalizeTag(buf)
    if (v) parts.push({ text: v, known: false })
    buf = ''
  }
  for (let i = 0; i < src.length; ) {
    const hit = sorted.find((t) => src.startsWith(t, i))
    if (hit) {
      flush()
      hits.push(hit)
      parts.push({ text: hit, known: true })
      i += hit.length
      continue
    }
    buf += src[i]
    i += 1
  }
  flush()
  return { hits, parts }
}

/**
 * 作者写下的一串标签 → 干净的标签数组（去重、去空、按原顺序）。
 *
 * 优先按标点/空白切；切出来的每一段如果本身不是已知标签，再试一次最长匹配
 * （这样 `男频玄幻`、`都市异能爽文` 这类「手打没加分隔符」的也能用）。
 *
 * ⚠️ 只对**标签输入框**用它。作者写「想法」的那段散文不要走这里 ——
 * 散文里出现「都市」「系统」都是正常叙述，不该被抽成标签。
 */
export function parseTags(input: string, vocab: readonly string[] = ALL_TAGS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (t: string) => {
    const v = normalizeTag(t)
    if (!v) return
    if (Array.from(v).length > MAX_TAG_LEN) return
    if (seen.has(v)) return
    seen.add(v)
    out.push(v)
  }
  for (const raw of String(input ?? '').split(TAG_SEP)) {
    const token = normalizeTag(raw)
    if (!token) continue
    if (vocab.includes(token)) {
      push(token)
      continue
    }
    const { hits, parts } = extractKnownTags(token, vocab)
    if (hits.length) {
      for (const p of parts) {
        // 切剩下的碎块也留着 —— 它是作者真写了的东西，丢掉等于替他做减法。
        // 但一个字的碎块（标点、语气词）不留。
        if (p.known || Array.from(p.text).length >= 2) push(p.text)
      }
    } else {
      push(token)
    }
  }
  return out
}

/**
 * 拼成一串给 AI 看的标签（去重、`、` 相连）。
 *
 * **不要在这里再走一遍 parseTags** —— 传入的已经是解析好的标签，
 * 再切一次会把作者自定义的长标签打散（`都市之最强系统` 会被拆成 `都市` + 一截碎块）。
 * 解析只在「原始输入」那一次做。
 */
export function joinTags(list: readonly string[]): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of list) {
    const v = normalizeTag(t)
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.join('、')
}

/* ------------------------------------------------------------------ 篇幅 ↔ 字数 */

/** 从标签文字里读区间（单位：万字） */
const LENGTH_RANGES: { tag: string; min: number; max: number }[] = [
  { tag: '0-50万字', min: 0, max: 50 },
  { tag: '50-100万字', min: 50, max: 100 },
  { tag: '100-150万字', min: 100, max: 150 },
  { tag: '150-200万字', min: 150, max: 200 },
  { tag: '200万字以上', min: 200, max: Number.POSITIVE_INFINITY }
]

/** 总字数 → 它落在哪个篇幅档（界面上的 chip 选中态就用它算，不必再存一份状态） */
export function lengthTagOf(words: number): string {
  const wan = Math.max(0, Number(words) || 0) / 10000
  for (const r of LENGTH_RANGES) if (wan >= r.min && wan < r.max) return r.tag
  return LENGTH_TAGS[LENGTH_TAGS.length - 1]
}

/** 篇幅档 → 一个代表性总字数（取档位中点；「200 万字以上」按 225 万算） */
export function wordsOfTag(tag: string): number {
  const r = LENGTH_RANGES.find((x) => x.tag === normalizeTag(tag))
  if (!r) return 0
  const max = Number.isFinite(r.max) ? r.max : r.min + 50
  return Math.round(((r.min + max) / 2) * 10000)
}
