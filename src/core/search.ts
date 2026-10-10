/** 跨章节批量替换（保留 front matter 不动，只替换正文部分） */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { parseDoc, serializeDoc } from './frontmatter'

function toRegExp(q: string): RegExp | null {
  if (!q) return null
  try {
    if (/^\/.*\/[gimsuy]*$/.test(q)) {
      const flags = q.slice(q.lastIndexOf('/') + 1)
      return new RegExp(q.slice(1, q.lastIndexOf('/')), flags.includes('g') ? flags : flags + 'g')
    }
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  } catch {
    return null
  }
}

export async function replaceOccurrences(ref: DirRef, fileId: string, query: string, replacement: string): Promise<number> {
  const re = toRegExp(query)
  if (!re) return 0
  const raw = await fs().readFile(ref, fileId.split('/'))
  const { meta, body } = parseDoc(raw)
  const count = (body.match(re) || []).length
  if (!count) return 0
  const nextBody = body.replace(re, replacement)
  await fs().writeFile(ref, fileId.split('/'), serializeDoc(meta, nextBody))
  return count
}

export function countOccurrences(text: string, query: string): number {
  const re = toRegExp(query)
  return re ? (text.match(re) || []).length : 0
}
