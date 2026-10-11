/**
 * 技能系统（开发文档 B7 / P0-7）
 * 技能 = 提示词 + 流程，不直接执行任何东西，只产生「工具调用意图」。
 * 加载优先级：作品内技能 > 全局技能库 > 内置技能（同名覆盖）
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { parseDoc, serializeDoc } from './frontmatter'
import { settings } from './settings'
import { DIRS } from './workspace'
import { classifySkill, normalizeCat, type SkillCat } from './skillCats'
import type { Skill } from './types'

const BUILTIN = import.meta.glob('../skills/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

export function builtinSkills(): Skill[] {
  return Object.entries(BUILTIN).map(([p, raw]) => parseSkillFile(raw, 'builtin', p))
}

export function parseSkillFile(raw: string, source: Skill['source'], location?: string): Skill {
  const { meta, body } = parseDoc(raw)
  const name = String(meta.name || location?.split('/').slice(-2)[0] || '未命名技能')
  return {
    id: `${source}:${name}`,
    name,
    slug: meta.slug ? String(meta.slug).trim() : undefined,
    description: String(meta.description || ''),
    // frontmatter 里技能作者亲手写的分类。存**规范 key**（'文本生成' → 'gen'）而不是原串：
    // 面板的分类下拉与 settings 里的手动分类都按 key 走，存两种写法迟早对不上。
    category: normalizeCat(meta.category) || undefined,
    allowedTools: Array.isArray(meta['allowed-tools']) ? meta['allowed-tools'].map(String) : meta['allowed-tools'] ? [String(meta['allowed-tools'])] : [],
    source,
    enabled: !settings.disabledSkills.includes(name),
    location,
    content: body
  }
}

export function serializeSkill(s: Partial<Skill>): string {
  return serializeDoc(
    {
      name: s.name,
      slug: s.slug,
      description: s.description,
      category: s.category,
      'allowed-tools': s.allowedTools || []
    },
    s.content || '',
    ['name', 'slug', 'description', 'category', 'allowed-tools']
  )
}

export async function loadWorkSkills(ref: DirRef): Promise<Skill[]> {
  const out: Skill[] = []
  let entries
  try {
    entries = await fs().listDir(ref, [DIRS.skill])
  } catch {
    return out
  }
  for (const e of entries.filter((x) => x.kind === 'dir')) {
    try {
      const raw = await fs().readFile(ref, [DIRS.skill, e.name, 'SKILL.md'])
      out.push(parseSkillFile(raw, 'work', [DIRS.skill, e.name, 'SKILL.md'].join('/')))
    } catch {
      /* 无 SKILL.md 的目录忽略 */
    }
  }
  return out
}

export async function loadGlobalSkills(library: { id: string; name: string } | null): Promise<Skill[]> {
  if (!library) return []
  const ref: DirRef = { id: library.id, name: library.name }
  const out: Skill[] = []
  let entries
  try {
    entries = await fs().listDir(ref, [])
  } catch {
    return out
  }
  for (const e of entries.filter((x) => x.kind === 'dir')) {
    try {
      const raw = await fs().readFile(ref, [e.name, 'SKILL.md'])
      out.push(parseSkillFile(raw, 'global', `${library.name}/${e.name}/SKILL.md`))
    } catch {
      /* noop */
    }
  }
  return out
}

export async function mergeSkills(ref: DirRef | null): Promise<Skill[]> {
  const map = new Map<string, Skill>()
  for (const s of builtinSkills()) map.set(s.name, s)
  for (const s of await loadGlobalSkills(settings.skillLibrary)) map.set(s.name, s)
  if (ref) for (const s of await loadWorkSkills(ref)) map.set(s.name, s)
  const hidden = new Set(settings.hiddenSkills)
  return [...map.values()]
    .filter((s) => !hidden.has(s.name))
    .map((s) => ({ ...s, enabled: !settings.disabledSkills.includes(s.name) }))
}

/* ------------------------------------------------------------------ 分类 / 隐藏 */

/** 一条技能当前生效的分类：作者手挪 > frontmatter > 关键词启发式 */
export function catOf(s: Skill): SkillCat {
  const manual = normalizeCat(settings.skillCats?.[s.name])
  if (manual) return manual
  return classifySkill(s)
}

/** 作者把技能挪到另一个分类。挪回启发式分类时把 override 清掉，别留一层永远压着的旧值 */
export function moveCat(s: Skill, cat: SkillCat) {
  const map = { ...(settings.skillCats || {}) }
  if (classifySkill(s) === cat) delete map[s.name]
  else map[s.name] = cat
  settings.skillCats = map
}

/** 撤掉手动分类（分类已经写进 SKILL.md 的 frontmatter 时用，避免两层互相打架） */
export function clearCat(name: string) {
  if (!settings.skillCats?.[name]) return
  const map = { ...(settings.skillCats || {}) }
  delete map[name]
  settings.skillCats = map
}

/** 全局/内置技能的「删除」是隐藏：文件不动（那是 DSH 自己的目录），只是不再出现在列表与 AI 的技能目录里 */
export function hideSkill(name: string) {
  if (!settings.hiddenSkills.includes(name)) settings.hiddenSkills = [...settings.hiddenSkills, name]
}

export function restoreSkill(name: string) {
  settings.hiddenSkills = settings.hiddenSkills.filter((n) => n !== name)
}

export function hiddenSkillNames(): string[] {
  return [...settings.hiddenSkills]
}

export async function saveWorkSkill(ref: DirRef, skill: Skill) {
  const dir = [DIRS.skill, skill.name.replace(/[\\/:*?"<>|]/g, '_')]
  await fs().mkdir(ref, dir)
  await fs().writeFile(ref, [...dir, 'SKILL.md'], serializeSkill(skill))
}

export async function deleteWorkSkill(ref: DirRef, skill: Skill) {
  if (skill.source !== 'work' || !skill.location) return
  const parts = skill.location.split('/')
  await fs().remove(ref, parts.slice(0, -1))
}

export function setSkillEnabled(name: string, enabled: boolean) {
  const set = new Set(settings.disabledSkills)
  if (enabled) set.delete(name)
  else set.add(name)
  settings.disabledSkills = [...set]
}

/* ------------------------------------------------------------------ 导入 */

export async function importFromZip(file: File, target: DirRef): Promise<number> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const buf = new Uint8Array(await file.arrayBuffer())
  const files = unzipSync(buf)
  const entries = Object.entries(files).filter(([p]) => !p.startsWith('__MACOSX') && !p.endsWith('/'))
  const skillPaths = entries.map(([p]) => p).filter((p) => p.split('/').pop() === 'SKILL.md')
  let written = 0
  for (const sp of skillPaths) {
    const parts = sp.split('/')
    const skillRoot = parts.slice(0, -1) // 去掉 SKILL.md
    if (!skillRoot.length) continue
    const skillDir = skillRoot[skillRoot.length - 1].replace(/[\\/:*?"<>|]/g, '_')
    const base = skillRoot.join('/')
    for (const [p, data] of entries) {
      if (p !== base + '/SKILL.md' && !p.startsWith(base + '/')) continue
      const rel = p.slice(base.length + 1)
      if (!rel) continue
      const isText = /\.(md|txt|ya?ml|json)$/i.test(rel)
      await fs().writeFile(
        target,
        [DIRS.skill, skillDir, ...rel.split('/')],
        isText ? strFromU8(data as Uint8Array) : ''
      )
      written++
    }
  }
  return written
}

/** 从目录导入：读取该目录（可含多个技能子目录）并复制到作品技能目录 */
export async function importFromFolder(src: DirRef, target: DirRef): Promise<number> {
  const entries = await fs().listDir(src, [])
  if (await fs().exists(src, ['SKILL.md'])) {
    const raw = await fs().readFile(src, ['SKILL.md'])
    const s = parseSkillFile(raw, 'work')
    await saveWorkSkill(target, { ...s, content: s.content })
    return 1
  }
  let n = 0
  for (const e of entries.filter((x) => x.kind === 'dir')) {
    try {
      const raw = await fs().readFile(src, [e.name, 'SKILL.md'])
      const s = parseSkillFile(raw, 'work')
      await saveWorkSkill(target, { ...s, name: s.name || e.name, content: s.content })
      n++
    } catch {
      /* noop */
    }
  }
  return n
}

/** 技能自动加载列表：只注入 name + description，正文按需加载（SKILL.md 省 token 的原理） */
export function skillCatalog(skills: Skill[]): string {
  const list = skills.filter((s) => s.enabled)
  if (!list.length) return '（当前没有启用任何技能）'
  return list.map((s) => `- ${s.name}：${s.description || '（无说明）'}`).join('\n')
}

export function exportSkillZip(skill: Skill): Promise<Blob> {
  return import('fflate').then(({ zipSync, strToU8 }) => {
    const data = zipSync({
      [`${skill.name}/SKILL.md`]: strToU8(serializeSkill(skill))
    })
    return new Blob([data as any], { type: 'application/zip' })
  })
}
