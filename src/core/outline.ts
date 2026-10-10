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
  targetWords: number
  /** 每章字数 */
  chapterWords?: number
  /** 卷数（不填则按字数估） */
  volumes?: number
}

const DEFAULT_CHAPTER_WORDS = 3000
/** 没指定卷数时的自动分卷上限（按 ~18 章/卷 估，最多 4 卷） */
const MAX_AUTO_VOLUMES = 4

export function buildSkeleton(opt: SkeletonOptions): Skeleton {
  const chapterWords = Math.max(500, opt.chapterWords || DEFAULT_CHAPTER_WORDS)
  const totalChapters = Math.max(1, Math.round(opt.targetWords / chapterWords))
  const volumeCount = opt.volumes && opt.volumes > 0 ? opt.volumes : Math.max(1, Math.min(MAX_AUTO_VOLUMES, Math.ceil(totalChapters / 18)))
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
      name: `第${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][v] || v + 1}卷`,
      // 卷目标留白：坑位是软件铺的，内容是作者的。预填一段「三幕套路」文案
      // 看着贴心，实际上每个人写出来的开头都一样了 —— 而且作者经常忘了改。
      target: '',
      start,
      end: n,
      chapters
    })
  }

  return { title: opt.title, volumes, totalWords: opt.targetWords, chapterWords }
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
 * 两种入口共用这一个提示词：
 *  - 作者带了世界观 / 人物设定材料（粘贴、从 设定/ 带入或导入文件）→ 材料是事实来源；
 *  - 什么材料都没有，只给了几个标签（同人 / 玄幻 / 多女主…）→ 标签定题材与套路。
 *
 * 输出格式与 toOutlineMarkdown 对齐（## 卷 + | 章节 | 目标 | 字数 |），
 * 这样 adoptOutline 才能把 AI 的稿子解析回骨架写进 大纲/大纲.md。
 */
export function recommendPrompt(opt: { info: WorkInfo; s: Skeleton; tags: string; material: string }): string {
  const chapters = opt.s.volumes.reduce((n, v) => n + v.chapters.length, 0)
  const material = opt.material.trim()
  return `你是长篇小说的结构编辑。请为下面这部作品从零推荐一条故事主线，并产出完整的分章大纲。

作品：${opt.info.title || opt.s.title}
简介：${opt.info.brief || '（无）'}
题材标签：${opt.tags.trim() || '（作者没给标签，请按下面的材料自行判断题材与调性）'}
目标字数：${opt.s.totalWords}　每章约 ${opt.s.chapterWords} 字　共约 ${chapters} 章（卷数自定，2–5 卷为宜）
${material ? `\n世界观 / 人物设定材料（这是事实来源，大纲不得与之矛盾；材料没写的不要编造成设定）：\n"""\n${material.slice(0, MATERIAL_LIMIT)}\n"""` : ''}

输出格式（严格遵守）：
1. 先输出「## 主线」，用 3–5 行写清起因 → 发展 → 转折 → 收束，不写套话。
2. 然后每个卷一段：一行「## 第X卷」，一行「**卷目标**：…」，接着是 Markdown 表格，表头为 | 章节 | 目标 | 字数 |。
3. 章节名要能一眼看出这一章发生什么（例如「灯下的第三封信」），不要写「第001章」这种空标题。
4. 相邻章节不重复同一件事，注意节奏起伏；每卷结尾留钩子。
5. 除上述内容外不要输出任何解释。`
}
