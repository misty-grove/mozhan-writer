/**
 * 文风学习：让 AI 从「作者给的材料」里学文风，而不是从空话里编文风
 *
 * 以前文风只有一条路：软件从作者已经写过的正文里抽样本（句长、对话占比那些统计）。
 * 那只能算「指标」，学不到味道 —— 作者真正想说的是「照我贴的这段去写」、
 * 「照这本参考书的腔调去写」。所以这里加一条：
 *
 *   导入 / 粘贴样本 → 存进 记忆/文风样本/ → 让 AI 归纳成可执行的文风要点
 *   → 要点进候选区（作者勾选确认）→ 采纳后落到 记忆/文风要点.md → 之后每次生成都带上
 *
 * 两个纪律：
 * 1. **样本是作者的文件**，存在作品目录里（目录即数据模型），不是数据库里的黑盒。
 * 2. AI 归纳出来的要点**先进候选区**，作者点了采纳才写进 记忆/文风要点.md ——
 *    跟所有 AI 功能同一条铁律。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { sanitizeName } from './worldbuild'
import { docxToMarkdown } from './docxRead'
import { pdfToText } from './pdfRead'
import { countWords } from './util'

/** 样本存放位置：记忆/文风样本/*.md */
export const STYLE_SAMPLE_DIR = ['记忆', '文风样本']
/** AI 学出来的要点落到哪（作者可手改） */
export const STYLE_NOTES_FILE = '文风要点.md'

export interface StyleSample {
  /** 文件名（含 .md） */
  file: string
  /** 去掉 .md 的显示名 */
  name: string
  chars: number
}

export function sampleName(file: string): string {
  return String(file || '').replace(/\.md$/i, '')
}

/** 洗成合法文件名：非法字符→·，避 Windows 保留名，末尾补 .md */
export function sanitizeSampleName(raw: string): string {
  const base = sanitizeName(String(raw || '').replace(/\.(md|txt|docx|pdf)$/i, '')) || '未命名样本'
  return base + '.md'
}

export async function listStyleSamples(ref: DirRef): Promise<StyleSample[]> {
  try {
    const entries = await fs().listDir(ref, STYLE_SAMPLE_DIR)
    const out: StyleSample[] = []
    for (const e of entries) {
      if (e.kind !== 'file' || !/\.md$/i.test(e.name)) continue
      let chars = 0
      try {
        chars = countWords(await fs().readFile(ref, [...STYLE_SAMPLE_DIR, e.name]))
      } catch {
        chars = 0
      }
      out.push({ file: e.name, name: sampleName(e.name), chars })
    }
    return out.sort((a, b) => a.file.localeCompare(b.file))
  } catch {
    // 目录还不存在（新作品第一次用）= 没有样本，不是错误
    return []
  }
}

/** 存一份样本。同名覆盖（作者重新导入同一份材料时，不该冒出一堆「样本2」） */
export async function saveStyleSample(ref: DirRef, rawName: string, text: string): Promise<StyleSample> {
  const file = sanitizeSampleName(rawName)
  await fs().mkdir(ref, STYLE_SAMPLE_DIR).catch(() => {})
  await fs().writeFile(ref, [...STYLE_SAMPLE_DIR, file], text.trim() + '\n')
  return { file, name: sampleName(file), chars: countWords(text) }
}

/** 删除样本（作者自己的文件，删之前 UI 必须先摊名单确认） */
export async function removeStyleSample(ref: DirRef, file: string): Promise<void> {
  await fs().remove(ref, [...STYLE_SAMPLE_DIR, file])
}

export async function readStyleSample(ref: DirRef, file: string): Promise<string> {
  try {
    return await fs().readFile(ref, [...STYLE_SAMPLE_DIR, file])
  } catch {
    return ''
  }
}

/** 把勾选中的样本拼成一段（按字数截断，别把上下文窗口吃满） */
export async function collectStyleSamples(ref: DirRef, files: string[], maxChars = 6000): Promise<string> {
  const parts: string[] = []
  let used = 0
  for (const f of files) {
    if (used >= maxChars) break
    const t = (await readStyleSample(ref, f)).trim()
    if (!t) continue
    const room = maxChars - used
    const cut = t.length > room ? t.slice(0, room) : t
    parts.push(`（样本：${sampleName(f)}${cut.length < t.length ? `，截取前 ${room} 字` : ''}）\n${cut}`)
    used += cut.length
  }
  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ 导入 */

export interface ImportResult {
  text: string
  warnings: string[]
  /** 建议的文件名（取自原文件名） */
  name: string
}

/**
 * 文件 → 文本。
 * 编码是个真问题：中文 txt 有一半还是 GBK。utf-8 解出一堆替换字符（�）
 * 就换 gbk 再解一次 —— 解不出来就如实说，不要给作者一屏豆腐块。
 */
function decodeText(buf: Uint8Array): { text: string; warning: string } {
  const utf8 = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '')
  const bad = (utf8.match(/�/g) || []).length
  if (bad === 0 || bad < utf8.length * 0.001) return { text: utf8, warning: '' }
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    const bad2 = (gbk.match(/�/g) || []).length
    if (bad2 < bad) return { text: gbk, warning: '这个文件不是 UTF-8，已按 GBK 解码（中文 txt 常见）。' }
  } catch {
    /* 这个浏览器不支持 gbk 解码，就用 utf-8 的结果 */
  }
  return { text: utf8, warning: '文件里有一部分字符解不出来（编码不认识），可能有乱码。' }
}

export async function importStyleFile(fileName: string, buf: ArrayBuffer | Uint8Array): Promise<ImportResult> {
  const warnings: string[] = []
  const name = String(fileName || '').replace(/\.[^.]+$/, '')
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (/\.docx$/i.test(fileName)) {
    const r = docxToMarkdown(bytes)
    warnings.push(...(r.warnings || []))
    return { text: r.text || '', warnings, name }
  }
  if (/\.pdf$/i.test(fileName)) {
    const r = await pdfToText(bytes)
    warnings.push(...r.warnings)
    return { text: r.text || '', warnings, name }
  }
  // .txt / .md / 其它：当纯文本
  const d = decodeText(bytes)
  if (d.warning) warnings.push(d.warning)
  return { text: d.text, warnings, name }
}

/* ------------------------------------------------------------------ 让 AI 学 */

/**
 * 「让 AI 学文风」的提示词。
 *
 * 关键是**约束输出形态**：要的是「能照着做的规则」，不是「文笔优美、节奏明快」
 * 这种等于没说的评语。样本情节一概不许复述 —— 复述了就等于把参考书的剧情
 * 灌进上下文，续写时会原样照搬。
 */
export function styleLearnPrompt(samples: Array<{ name: string; text: string }>, instruction: string): string {
  const blocks = samples
    .map((s) => `【样本：${s.name}】\n${s.text.slice(0, 12000)}`)
    .join('\n\n')
  return `你是中文网络小说的文风分析师。下面是作者提供的写作样本。

任务：从这些样本里归纳出**别人照着做就能写出同样味道**的规则。

要求（必须遵守）：
1. 只输出规则，不复述情节、不引用原文长句（每条最多附一句 20 字以内的示例）。
2. 按这六块分节，每节一个小标题：
   ## 句式与节奏
   ## 用词习惯
   ## 对话写法
   ## 视角与叙述距离
   ## 常见修辞与句式偏好
   ## 禁忌（明确不要写什么）
3. 每条一行，写成「要怎么做」或「不要怎么做」。禁止评价性空话（"文笔优美""节奏明快"等于没说）。
4. 总共 12–30 条，宁少而准，不凑数。
5. 中文输出，不要 Markdown 表格，不要代码块。对话示例里的引号一律用中文双引号“”。

${instruction ? `作者的额外要求：${instruction}\n` : ''}
以下是样本（只作分析对象，不得复述其中情节）：

${blocks}`
}

/** 洗一遍 AI 吐回来的要点：剥代码围栏、压空行，剩下的原样交给作者看 */
export function parseStyleNotes(text: string): string {
  let s = String(text || '').trim()
  if (!s) return ''
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

/** 文风要点正文（记忆/文风要点.md），没有就返回空串 */
export async function readStyleNotes(ref: DirRef): Promise<string> {
  try {
    return (await fs().readFile(ref, ['记忆', STYLE_NOTES_FILE])).trim()
  } catch {
    return ''
  }
}

export async function writeStyleNotes(ref: DirRef, text: string): Promise<void> {
  await fs().writeFile(ref, ['记忆', STYLE_NOTES_FILE], text.trim() + '\n')
}
