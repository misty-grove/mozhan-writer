/**
 * 快照：位于 <作品根>/.snapshots/<章节路径扁平化>/<时间戳>-<类型>.md
 * 策略：最近 N 个 + 每次会话首个自动快照 + 手动里程碑（对应开发文档 11.2 待确认项 5）
 *
 * 策略值由外界注入（见 setSnapshotPolicy）而不是直接读 settings ——
 * core/ 是纯业务层，离线自检要在没有 localStorage 的 Node 里跑，
 * 核心层一旦依赖 settings 就会把环境耦合进来。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { DIRS } from './workspace'
import { countWords, stamp } from './util'
import { parseDoc } from './frontmatter'

export interface Snapshot {
  id: string
  name: string
  kind: 'auto' | 'manual'
  time: string
  words: number
  chapterId: string
}

export interface SnapshotPolicy {
  /** 每章最多保留多少个自动快照（手动快照不受限） */
  maxAuto: number
  /** 同一章两次自动快照的最小间隔（毫秒） */
  intervalMs: number
}

let policy: SnapshotPolicy = { maxAuto: 20, intervalMs: 10 * 60 * 1000 }

export function setSnapshotPolicy(patch: Partial<SnapshotPolicy>) {
  policy = {
    maxAuto: Math.max(1, Math.round(patch.maxAuto ?? policy.maxAuto)),
    intervalMs: Math.max(0, patch.intervalMs ?? policy.intervalMs)
  }
}

export function snapshotPolicy(): SnapshotPolicy {
  return { ...policy }
}

function encode(chapterId: string) {
  return chapterId.replace(/[\\/]/g, '__')
}

export async function listSnapshots(ref: DirRef, chapterId: string): Promise<Snapshot[]> {
  const dir = [DIRS.snapshot, encode(chapterId)]
  let entries
  try {
    entries = await fs().listDir(ref, dir)
  } catch {
    return []
  }
  const out: Snapshot[] = []
  for (const e of entries.filter((x) => x.kind === 'file' && x.name.endsWith('.md'))) {
    const m = /^(\d{8}-\d{6})-(auto|manual)(?:-\d+)?\.md$/.exec(e.name)
    if (!m) continue
    let words = 0
    try {
      words = countWords(parseDoc(await fs().readFile(ref, [...dir, e.name])).body)
    } catch {
      /* noop */
    }
    const t = m[1]
    out.push({
      id: e.name,
      name: e.name,
      kind: m[2] as 'auto' | 'manual',
      time: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}`,
      words,
      chapterId
    })
  }
  return out.sort((a, b) => b.name.localeCompare(a.name))
}

export async function createSnapshot(ref: DirRef, chapterId: string, content: string, kind: 'auto' | 'manual' = 'auto') {
  const dir = [DIRS.snapshot, encode(chapterId)]
  try {
    await fs().mkdir(ref, dir)
  } catch {
    /* noop */
  }
  // 文件名只精确到秒，同一秒内连点两次「存快照」会互相覆盖 —— 加序号，宁可多留一份也不悄悄丢
  const ts = stamp()
  let name = `${ts}-${kind}.md`
  let n = 2
  while (await fs().exists(ref, [...dir, name])) {
    name = `${ts}-${kind}-${n}.md`
    n++
  }
  await fs().writeFile(ref, [...dir, name], content)
  await trim(ref, chapterId)
}

export async function readSnapshot(ref: DirRef, chapterId: string, name: string): Promise<string> {
  return await fs().readFile(ref, [DIRS.snapshot, encode(chapterId), name])
}

export async function deleteSnapshot(ref: DirRef, chapterId: string, name: string) {
  await fs().remove(ref, [DIRS.snapshot, encode(chapterId), name])
}

async function trim(ref: DirRef, chapterId: string) {
  const list = await listSnapshots(ref, chapterId)
  const autos = list.filter((s) => s.kind === 'auto')
  for (const s of autos.slice(policy.maxAuto)) {
    await deleteSnapshot(ref, chapterId, s.name)
  }
}

const lastAuto = new Map<string, number>()

/** 自动快照节流：同章节超过 policy.intervalMs 才写一次 */
export async function autoSnapshot(ref: DirRef, chapterId: string, content: string) {
  const now = Date.now()
  const prev = lastAuto.get(chapterId) || 0
  if (now - prev < policy.intervalMs) return
  lastAuto.set(chapterId, now)
  await createSnapshot(ref, chapterId, content, 'auto')
}
