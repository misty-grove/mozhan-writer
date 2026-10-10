/**
 * 参考资料（P2-24 分屏对照 / P2-27 钉住浮窗）
 *
 * 「参考」不是一个新概念，只是把作者已有的三类文字换个地方看：
 * 设定条目、资料文档、别的章节。只读，不落盘，随手可钉住。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { DIRS } from './workspace'
import { parseDoc } from './frontmatter'
import type { Chapter, SettingEntry } from './types'

export type RefKind = 'setting' | 'asset' | 'chapter'

export interface RefSource {
  id: string
  label: string
  /** 分组标题（人物设定 / 大纲 / 正文 …） */
  group: string
  kind: RefKind
}

export interface RefGroup {
  group: string
  sources: RefSource[]
}

/** 列出所有可作为参考的东西；chapters 由调用方传入（store 里已有） */
export async function listSources(
  ref: DirRef,
  entries: SettingEntry[],
  chapters: Chapter[]
): Promise<RefGroup[]> {
  const groups: RefGroup[] = []

  if (entries.length) {
    const byKind = new Map<string, RefSource[]>()
    for (const e of entries) {
      const arr = byKind.get(e.group) || []
      arr.push({ id: `setting:${e.id}`, label: e.name, group: e.group, kind: 'setting' })
      byKind.set(e.group, arr)
    }
    for (const [group, sources] of byKind) groups.push({ group: `设定 · ${group}`, sources })
  }

  // 资料：大纲 / 设定 / 记忆 下的 md
  for (const dir of [DIRS.outline, DIRS.setting, DIRS.memory]) {
    try {
      const list = await fs().listDir(ref, [dir])
      const files = list.filter((x) => x.kind === 'file' && x.name.endsWith('.md'))
      if (files.length) {
        groups.push({
          group: dir,
          sources: files.map((f) => ({ id: `asset:${dir}/${f.name}`, label: f.name.replace(/\.md$/, ''), group: dir, kind: 'asset' as RefKind }))
        })
      }
    } catch {
      /* 目录不存在就跳过 */
    }
  }

  if (chapters.length) {
    const volName = new Map<string, string>()
    groups.push({
      group: '正文',
      sources: chapters.map((c) => ({
        id: `chapter:${c.id}`,
        label: c.title,
        group: c.volumeId ? volName.get(c.volumeId) || '正文' : '正文',
        kind: 'chapter' as RefKind
      }))
    })
  }

  return groups
}

/** 读某个参考源的正文（去掉 front matter） */
export async function readSource(
  ref: DirRef,
  sourceId: string,
  entries: SettingEntry[],
  chapters: Chapter[]
): Promise<string> {
  const [kind, ...rest] = sourceId.split(':')
  const id = rest.join(':')
  if (kind === 'setting') {
    return entries.find((e) => e.id === id)?.body || ''
  }
  if (kind === 'asset') {
    try {
      return parseDoc(await fs().readFile(ref, id.split('/'))).body
    } catch {
      return ''
    }
  }
  if (kind === 'chapter') {
    try {
      return parseDoc(await fs().readFile(ref, id.split('/'))).body
    } catch {
      return ''
    }
  }
  return ''
}
