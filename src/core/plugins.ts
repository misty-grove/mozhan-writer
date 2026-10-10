/**
 * 插件机制（P2-30）—— 声明式，不执行任何脚本
 *
 * 这是刻意的取舍：允许作者扩展，但**不允许代码执行**。
 * 作者想要的东西（换个导出格式、多统计一项）用模板和规则就能说清楚，
 * 一旦开放脚本，一个「技能」就能把整部作品读走 —— 这个口子不开。
 *
 * 插件就是作品目录下的两个东西，记事本可改：
 *   插件/导出/<名字>.md   模板，占位符 {{书名}} {{正文}} …
 *   插件/统计.json        规则数组，声明「数什么」
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import type { ExportItem } from './exportDoc'

export const PLUGIN_DIR = '插件'
export const EXPORT_DIR = '插件/导出'
export const STAT_FILE = '插件/统计.json'

/* ------------------------------------------------------------------ 导出模板 */

export interface ExportTemplate {
  name: string
  path: string
  raw: string
}

export async function listExportTemplates(ref: DirRef): Promise<ExportTemplate[]> {
  try {
    const list = await fs().listDir(ref, [PLUGIN_DIR, '导出'])
    const out: ExportTemplate[] = []
    for (const f of list.filter((x) => x.kind === 'file' && /\.(md|txt)$/i.test(x.name))) {
      const raw = await fs().readFile(ref, [PLUGIN_DIR, '导出', f.name])
      out.push({ name: f.name.replace(/\.(md|txt)$/i, ''), path: `${EXPORT_DIR}/${f.name}`, raw })
    }
    return out
  } catch {
    return []
  }
}

export interface TemplateContext {
  title: string
  author: string
  brief: string
  totalWords: number
  items: ExportItem[]
}

/** 占位符替换：够用就好，不做 mustache 那种完整模板语言 */
export function renderTemplate(tpl: string, ctx: TemplateContext): string {
  const body = ctx.items.map((it) => `## ${it.title}\n\n${(it.body || '').trim()}`).join('\n\n')
  const toc = ctx.items.map((it, i) => `${i + 1}. ${it.title}`).join('\n')
  const map: Record<string, string> = {
    '{{书名}}': ctx.title,
    '{{作者}}': ctx.author,
    '{{简介}}': ctx.brief,
    '{{总字数}}': String(ctx.totalWords),
    '{{章节数}}': String(ctx.items.length),
    '{{目录}}': toc,
    '{{正文}}': body,
    '{{章节标题}}': ctx.items.map((it) => it.title).join('\n')
  }
  let out = tpl
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v)
  return out
}

/** 模板里没被替换的占位符（提示作者写错了） */
export function unknownPlaceholders(tpl: string): string[] {
  const known = ['书名', '作者', '简介', '总字数', '章节数', '目录', '正文', '章节标题']
  return [...new Set([...tpl.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()))].filter((p) => !known.includes(p))
}

/* ------------------------------------------------------------------ 统计规则 */

export interface StatRule {
  name: string
  /** keyword：数这些词各出现几次；regex：按正则计数 */
  type: 'keyword' | 'regex'
  words?: string[]
  pattern?: string
  /** 展示时是否按全书合计 */
  note?: string
}

export interface StatResult {
  rule: StatRule
  count: number
  /** keyword 模式下每个词的命中数 */
  detail: Array<{ word: string; count: number }>
  /** 命中最多的章节 */
  top: { title: string; count: number } | null
}

export function parseStatRules(raw: string): StatRule[] {
  try {
    const parsed = JSON.parse(raw)
    const arr = Array.isArray(parsed) ? parsed : parsed?.rules || []
    return arr
      .filter((r: any) => r && typeof r.name === 'string' && (r.type === 'keyword' || r.type === 'regex'))
      .map((r: any) => ({
        name: r.name,
        type: r.type,
        words: Array.isArray(r.words) ? r.words.map(String) : [],
        pattern: typeof r.pattern === 'string' ? r.pattern : '',
        note: typeof r.note === 'string' ? r.note : ''
      }))
  } catch {
    return []
  }
}

export async function loadStatRules(ref: DirRef): Promise<StatRule[]> {
  try {
    return parseStatRules(await fs().readFile(ref, [PLUGIN_DIR, '统计.json']))
  } catch {
    return []
  }
}

function countIn(hay: string, needle: string): number {
  if (!needle) return 0
  let c = 0
  let i = hay.indexOf(needle)
  while (i >= 0) {
    c++
    i = hay.indexOf(needle, i + needle.length)
  }
  return c
}

export function applyRule(
  chapters: Array<{ id: string; title: string }>,
  bodies: Record<string, string>,
  rule: StatRule
): StatResult {
  const detail: Array<{ word: string; count: number }> = []
  let total = 0
  let top: { title: string; count: number } | null = null

  for (const ch of chapters) {
    const text = bodies[ch.id] || ''
    if (!text) continue
    let n = 0
    if (rule.type === 'keyword') {
      for (const w of rule.words || []) {
        const c = countIn(text, w)
        n += c
        const prev = detail.find((d) => d.word === w)
        if (prev) prev.count += c
        else detail.push({ word: w, count: c })
      }
    } else if (rule.pattern) {
      try {
        n = (text.match(new RegExp(rule.pattern, 'g')) || []).length
      } catch {
        n = 0
      }
    }
    total += n
    if (!top || n > top.count) top = { title: ch.title, count: n }
  }

  return { rule, count: total, detail: detail.sort((a, b) => b.count - a.count), top }
}

export const STAT_RULE_EXAMPLE = JSON.stringify(
  [
    { name: '对话密度', type: 'regex', pattern: '“[^”]{2,}”', note: '数带引号的对话' },
    { name: '战斗场面', type: 'keyword', words: ['剑', '刀', '掌风'], note: '这几个词的出现次数' }
  ],
  null,
  2
)
