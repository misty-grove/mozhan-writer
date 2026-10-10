/**
 * 大纲与章纲（P1-19）
 *
 * 两档：
 *  - 本地骨架：不联网、0 token，按目标字数算出卷章数量，先把坑位铺好（作者自己填）
 *  - AI 补齐：有配置时由 AI 写具体内容，产出进候选区，作者点采纳才落盘
 *
 * 大纲本身是 大纲/大纲.md —— 人能读能改的 Markdown，软件只做解析和回填。
 */
import type { WorkInfo } from './types'

export interface SkeletonChapter {
  title: string
  /** 本章目标（章纲一句话） */
  target: string
  words: number
}

export interface SkeletonVolume {
  name: string
  /** 卷目标。**默认留白** —— 由作者自己填、从文件导入或让 AI 补，软件不代笔 */
  target: string
  /** 本卷章节范围（1 起、含两端）。旧格式 / 手写大纲可能没有 */
  start?: number
  end?: number
  chapters: SkeletonChapter[]
}

export interface Skeleton {
  title: string
  volumes: SkeletonVolume[]
  totalWords: number
  chapterWords: number
}

export interface SkeletonOptions {
  title: string
  /** 目标字数。**给了 chapters 就按 chapters × 每章字数 算**，这个字段只在没给章数时用来反推 */
  targetWords?: number
  /** 每章字数 */
  chapterWords?: number
  /** 卷数（不填则按章数估） */
  volumes?: number
  /** 总章数（2026-10-10 起：这是**作者说了算**的那个数，不再由目标字数隐式推导） */
  chapters?: number
}

const DEFAULT_CHAPTER_WORDS = 3000
/** 没指定卷数时的自动分卷上限（按 ~18 章/卷 估，最多 4 卷） */
const MAX_AUTO_VOLUMES = 4
const VOL_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

function volName(i: number): string {
  return `第${VOL_NUM[i] || i + 1}卷`
}

/** 一份骨架一共有多少章（卷章两处都在用，别各写一份 reduce） */
export function countChapters(s: Skeleton): number {
  return s.volumes.reduce((n, v) => n + v.chapters.length, 0)
}

export function buildSkeleton(opt: SkeletonOptions): Skeleton {
  const chapterWords = Math.max(500, opt.chapterWords || DEFAULT_CHAPTER_WORDS)
  /* 章数优先用作者给的；没给才按目标字数反推（保留旧调用方与导入路径的行为）。
     给了章数就不再让目标字数「另说一套」—— 两个数各说各的，界面上迟早对不上。 */
  const explicit = Math.max(0, Math.floor(opt.chapters || 0))
  const totalChapters = explicit > 0 ? explicit : Math.max(1, Math.round((opt.targetWords || 0) / chapterWords))
  const totalWords = explicit > 0 ? totalChapters * chapterWords : Math.max(0, Math.round(opt.targetWords || 0))
  const asked = opt.volumes && opt.volumes > 0 ? Math.floor(opt.volumes) : Math.max(1, Math.min(MAX_AUTO_VOLUMES, Math.ceil(totalChapters / 18)))
  // 卷数不可能比章数还多：多出来的卷一定是空卷，界面上会出现「第2章-第1章」这种倒挂
  const volumeCount = Math.max(1, Math.min(asked, totalChapters))
  const per = Math.ceil(totalChapters / volumeCount)

  const volumes: SkeletonVolume[] = []
  let n = 0
  for (let v = 0; v < volumeCount && n < totalChapters; v++) {
    const count = Math.min(per, totalChapters - n)
    const start = n + 1
    n += count
    const chapters: SkeletonChapter[] = []
    for (let i = start; i <= n; i++) {
      chapters.push({ title: `第${String(i).padStart(3, '0')}章`, target: '', words: chapterWords })
    }
    volumes.push({
      name: volName(v),
      // 卷目标留白：坑位是软件铺的，内容是作者的。预填一段「三幕套路」文案
      // 看着贴心，实际上每个人写出来的开头都一样了 —— 而且作者经常忘了改。
      target: '',
      start,
      end: n,
      chapters
    })
  }

  return { title: opt.title, volumes, totalWords: totalWords || totalChapters * chapterWords, chapterWords }
}

/** 把 total 按 weights 的比例分给 len 份（最大余数法，和恒为 total） */
function distribute(total: number, weights: number[]): number[] {
  const len = weights.length
  if (!len) return []
  const sum = weights.reduce((a, b) => a + b, 0)
  const w = sum > 0 ? weights : new Array(len).fill(1)
  const denom = sum > 0 ? sum : len
  const raw = w.map((x) => (total * x) / denom)
  const out = raw.map((x) => Math.floor(x))
  const order = raw.map((x, i) => [x - Math.floor(x), i] as [number, number]).sort((a, b) => b[0] - a[0])
  for (let r = total - out.reduce((a, b) => a + b, 0), k = 0; r > 0 && order.length; r--, k = (k + 1) % order.length) out[order[k][1]]++
  return out
}

/**
 * 把一份骨架**改成指定的卷数与章数** —— 保持章节顺序，能留的都留着。
 *
 * 用途：作者导入大纲后想调规模（「这本我打算写成 5 卷 90 章」）。
 * 规则：
 *  - **形状没变就原样返回**（同一个对象）。导入的大纲分卷往往是不均匀的（40/27），
 *    一进来就「重排成均分」等于替作者改了大纲 —— 只有他真动了卷数/章数才重排。
 *  - 加章：按顺序补 `第N章`（目标留白），已有章节一个字不动。
 *  - 减章：从**末尾**截断（前中段的情节还在，砍掉的是还没写到的尾巴）。
 *  - 卷数没变 → 按原有各卷章数**比例**分（不抹平作者的不均匀分卷）；
 *    卷数变了、或任何一卷会被分到 0 章 → 退回均分。
 */
export function reshapeSkeleton(s: Skeleton, volumeCount: number, chapterCount: number): Skeleton {
  const chN = Math.max(1, Math.min(5000, Math.floor(chapterCount) || 1))
  // 同上：卷数封顶到章数，免得出现 0 章的卷
  const volN = Math.max(1, Math.min(60, Math.floor(volumeCount) || 1, chN))
  const flat = s.volumes.flatMap((v) => v.chapters)
  if (volN === s.volumes.length && chN === flat.length) return s

  const list: SkeletonChapter[] = []
  for (let i = 0; i < chN; i++) {
    list.push(flat[i] ? { ...flat[i] } : { title: `第${String(i + 1).padStart(3, '0')}章`, target: '', words: s.chapterWords })
  }

  const weights = s.volumes.map((v) => v.chapters.length)
  let counts = volN === s.volumes.length && weights.every((w) => w > 0) ? distribute(chN, weights) : distribute(chN, new Array(volN).fill(1))
  if (counts.length !== volN || counts.some((c) => c <= 0)) counts = distribute(chN, new Array(volN).fill(1))

  const volumes: SkeletonVolume[] = []
  let n = 0
  for (let v = 0; v < volN; v++) {
    const count = counts[v]
    const old = s.volumes[v]
    const start = n + 1
    n += count
    volumes.push({
      name: old?.name || volName(v),
      target: old?.target || '',
      start,
      end: n,
      chapters: list.slice(start - 1, n)
    })
  }
  return { ...s, volumes, totalWords: chN * s.chapterWords }
}

/** 骨架 → 大纲 Markdown（作者拿记事本也能改）。卷头写成「## 第一卷（第1章-第40章）」 */
export function toOutlineMarkdown(s: Skeleton, brief = ''): string {
  const lines: string[] = [`# ${s.title}`, '']
  if (brief) lines.push(brief, '')
  lines.push(`> 目标 ${s.totalWords.toLocaleString()} 字 · 每章约 ${s.chapterWords} 字 · 共 ${s.volumes.reduce((n, v) => n + v.chapters.length, 0)} 章`, '')
  for (const v of s.volumes) {
    const range = v.start && v.end ? `（第${v.start}章-第${v.end}章）` : ''
    lines.push(`## ${v.name}${range}`, '')
    if (v.target) lines.push(`**卷目标**：${v.target}`, '')
    lines.push('| 章节 | 目标 | 字数 |', '| --- | --- | --- |')
    for (const c of v.chapters) lines.push(`| ${c.title} | ${c.target || '　'} | ${c.words} |`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 大纲 Markdown → 骨架（回填用：作者手改过的表格也能读回来） */
export function parseOutlineMarkdown(md: string): Skeleton {
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() || '未命名'
  const totalMatch = /目标\s*([\d,]+)\s*字/.exec(md)
  const chapterMatch = /每章约\s*([\d,]+)\s*字/.exec(md)
  const totalWords = Number((totalMatch?.[1] || '0').replace(/,/g, '')) || 0
  const chapterWords = Number((chapterMatch?.[1] || '0').replace(/,/g, '')) || DEFAULT_CHAPTER_WORDS

  const volumes: SkeletonVolume[] = []
  let cur: SkeletonVolume | null = null
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    // 卷头两种都认：`## 第一卷` 与 `## 第一卷（第1章-第40章）`
    const h = /^##\s+(.+?)\s*(?:（第(\d+)章-第(\d+)章）)?\s*$/.exec(line)
    if (h) {
      cur = {
        name: h[1].trim(),
        target: '',
        start: h[2] ? Number(h[2]) : undefined,
        end: h[3] ? Number(h[3]) : undefined,
        chapters: []
      }
      volumes.push(cur)
      continue
    }
    const vt = /^\*\*卷目标\*\*[：:]\s*(.+)$/.exec(line)
    if (vt && cur) {
      cur.target = vt[1].trim()
      continue
    }
    const row = /^\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/.exec(line)
    if (row && cur && row[1] !== '---' && !/^章节$/.test(row[1])) {
      cur.chapters.push({
        title: row[1],
        target: row[2] === '　' ? '' : row[2],
        words: Number(row[3].replace(/[^\d]/g, '')) || chapterWords
      })
    }
  }
  return { title, volumes, totalWords, chapterWords }
}

/** 给 AI 的提示词：把骨架交给它补齐章纲（产出进候选区，作者点采纳才生效） */
export function outlinePrompt(info: WorkInfo, s: Skeleton, styleHint = ''): string {
  const shape = s.volumes
    .map((v) => {
      const range = v.start && v.end ? `（第${v.start}章-第${v.end}章）` : ''
      return `## ${v.name}${range}${v.target ? `\n卷目标：${v.target}` : ''}\n${v.chapters.map((c) => `- ${c.title}：${c.target || '（待定）'}`).join('\n')}`
    })
    .join('\n\n')
  return `你是长篇小说的结构编辑。下面是作品的骨架，请为每一章补一句「本章目标」（一句话，30 字以内，写具体发生了什么、推进了什么，不要写评价）。

作品：${info.title || s.title}
简介：${info.brief || '（无）'}
目标字数：${s.totalWords}　每章约 ${s.chapterWords} 字
${styleHint ? `题材与调性：${styleHint}\n` : ''}
现有骨架：
${shape}

要求：
1. 只输出 Markdown 表格，表头为 | 章节 | 目标 |，不要任何解释。
2. 章节名保持不变，只填「目标」列。
3. 相邻章节不要重复同一件事，注意节奏起伏。`
}

/** 推荐大纲要喂给模型的材料上限（字符）。设定文件可到几十 KB，不截会把上下文窗口整个吃掉 */
const MATERIAL_LIMIT = 12000

/**
 * 大纲推荐：不从现有骨架补目标，而是**从零推荐一条故事线**。
 *
 * 三种输入可以任意组合：
 *  - 作者带了世界观 / 人物设定材料（粘贴、从 设定/ 带入或导入文件）→ 材料是事实来源；
 *  - 给了题材标签（男频/女频、玄幻、爽文、100-150万字…）→ 标签定题材、调性与篇幅；
 *  - 写了「想法」（作者自己的散句：主角是谁、金手指、想写什么、想避开什么）
 *    → 优先级**高于**标签，因为它是最具体的意图；标签只是它的补充。
 *
 * 输出格式与 toOutlineMarkdown 对齐（## 卷 + | 章节 | 目标 | 字数 |），
 * 这样 adoptOutline 才能把 AI 的稿子解析回骨架写进 大纲/大纲.md。
 */
export function recommendPrompt(opt: { info: WorkInfo; s: Skeleton; tags: string; idea?: string; material: string }): string {
  const chapters = countChapters(opt.s)
  const material = opt.material.trim()
  const idea = (opt.idea || '').trim()
  const tags = opt.tags.trim()
  return `你是中文网络长篇小说的结构编辑。请为下面这部作品从零推荐一条故事主线，并产出完整的分章大纲。

作品：${opt.info.title || opt.s.title}
简介：${opt.info.brief || '（无）'}
题材标签：${tags || '（作者没给标签，请按下面的「想法」与材料自行判断题材与调性）'}
${idea ? `作者的想法（作者亲手写的，**比标签更具体，优先级更高**；可以补全细节，但不要改掉其中的设定，也不要写他明确说过不要的东西）：\n"""\n${idea}\n"""\n` : ''}目标规模：共约 ${chapters} 章、每章约 ${opt.s.chapterWords} 字（合计约 ${(opt.s.totalWords / 10000).toFixed(1)} 万字）；卷数按标签里的「篇幅」与故事需要自定，2–5 卷为宜
${material ? `\n世界观 / 人物设定材料（这是事实来源，大纲不得与之矛盾；材料没写的不要编造成设定）：\n"""\n${material.slice(0, MATERIAL_LIMIT)}\n"""` : ''}

输出格式（严格遵守）：
1. 先输出「## 主线」，用 3–5 行写清起因 → 发展 → 转折 → 收束，不写套话。
2. 然后每个卷一段：一行「## 第X卷」，一行「**卷目标**：…」，接着是 Markdown 表格，表头为 | 章节 | 目标 | 字数 |。
3. 章节名要能一眼看出这一章发生什么（例如「灯下的第三封信」），不要写「第001章」这种空标题。
4. 相邻章节不重复同一件事，注意节奏起伏；每卷结尾留钩子。
5. 除上述内容外不要输出任何解释。`
}
