/**
 * 整库备份与恢复（P3-C）
 *
 * 为什么需要它：作品就是一堆普通文件，作者完全可以直接拷文件夹 —— 但
 * 「整体打包成一个文件」在换机器、发给别人、丢进网盘/微信时更省事，
 * 而且能连 `.snapshots` 一起搬走。这一层只做搬运，不引入任何私有格式：
 * 备份出来的是一个标准 zip，解开就是原来那套目录，用记事本照样能改。
 *
 * 两条硬约束：
 * 1. **恢复不越界**：zip 条目名一律做路径校验，`../`、绝对路径、盘符一律拒绝，
 *    不许一个来路不明的压缩包往作品目录外面写文件。
 * 2. **默认不删东西**：覆盖同名文件，但绝不删除 zip 里没有的文件。
 *    要「清空重建」是另一件事，不该藏在「恢复」按钮里。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import { readZip, textBytes, bytesText, makeZipCompressed, type ZipEntry } from './zip'
import { DIRS } from './workspace'
import { listSnapshots, readSnapshot } from './snapshots'
import { countWords } from './util'
import { parseDoc } from './frontmatter'

export const MANIFEST_NAME = '备份信息.json'
export const BACKUP_VERSION = 1

export interface BackupManifest {
  app: 'writer-app-backup'
  version: number
  createdAt: string
  title: string
  author: string
  fileCount: number
  totalWords: number
  includeSnapshots: boolean
}

export interface BackupOptions {
  /** 是否把 .snapshots 一并打包（快照体积可能很大，默认不带） */
  includeSnapshots?: boolean
  /** 进度回调 */
  onProgress?: (done: number, label: string) => void
}

export interface BackupFile {
  path: string
  text: string
}

/* ------------------------------------------------------------------ 收集 */

/** 顶层目录名（用于占用统计与备份清单），保持稳定顺序 */
const TOP_DIRS = [DIRS.outline, DIRS.setting, DIRS.body, DIRS.memory, DIRS.skill, '插件']

/** 只有 正文/ 下的文件算「作品字数」；大纲/记忆/设定 的字数没有意义，别混进来 */
const isBodyFile = (path: string) => /^正文\/.*\.md$/.test(path)

/** 递归收集作品目录下的全部文本文件；跳过适配层已隐藏的 .snapshots / .git */
export async function collectFiles(ref: DirRef, path: string[] = [], out: BackupFile[] = []): Promise<BackupFile[]> {
  let entries
  try {
    entries = await fs().listDir(ref, path)
  } catch {
    return out
  }
  for (const e of entries) {
    const child = [...path, e.name]
    if (e.kind === 'dir') {
      await collectFiles(ref, child, out)
    } else {
      try {
        out.push({ path: child.join('/'), text: await fs().readFile(ref, child) })
      } catch {
        /* 单个文件读不了就先跳过，不让整次备份失败 */
      }
    }
  }
  return out
}

/** 收集快照（适配层不暴露 .snapshots，所以借 snapshots 模块按章节去读） */
export async function collectSnapshots(ref: DirRef, chapters: string[], onProgress?: (label: string) => void): Promise<BackupFile[]> {
  const out: BackupFile[] = []
  for (const id of chapters) {
    let list: { name: string }[] = []
    try {
      list = await listSnapshots(ref, id)
    } catch {
      continue
    }
    for (const s of list) {
      onProgress?.(`快照 ${id.split('/').pop()} / ${s.name}`)
      try {
        out.push({ path: `${DIRS.snapshot}/${id.replace(/[\\/]/g, '__')}/${s.name}`, text: await readSnapshot(ref, id, s.name) })
      } catch {
        /* 跳过读不出的快照 */
      }
    }
  }
  return out
}

/** 统计作品正文总字数（从章节文件算，而不是看内存状态） */
function wordsOf(files: BackupFile[]): number {
  let n = 0
  for (const f of files) {
    if (!isBodyFile(f.path)) continue
    try {
      n += countWords(parseDoc(f.text).body)
    } catch {
      /* 解析不了的按 0 计 */
    }
  }
  return n
}

/* ------------------------------------------------------------------ 备份 */

export interface BackupResult {
  blob: Blob
  manifest: BackupManifest
  /** 备份包里除清单外的路径清单，UI 里可以直接列给作者看 */
  paths: string[]
}

/**
 * 打包整个作品。
 * 条目名一律用相对作品根的路径（如 `正文/第001章 归归.md`），解开就是一个完整作品目录。
 */
export async function buildBackup(
  ref: DirRef,
  info: { title?: string; author?: string },
  opts: BackupOptions = {}
): Promise<BackupResult> {
  const files = await collectFiles(ref)
  opts.onProgress?.(0, `已收集 ${files.length} 个文件`)

  let all = files
  if (opts.includeSnapshots) {
    const chapterIds = files.filter((f) => isBodyFile(f.path)).map((f) => f.path)
    const snaps = await collectSnapshots(ref, chapterIds, (label) => opts.onProgress?.(0, label))
    all = files.concat(snaps)
  }

  const manifest: BackupManifest = {
    app: 'writer-app-backup',
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    title: info.title || ref.name,
    author: info.author || '',
    fileCount: all.length,
    totalWords: wordsOf(files),
    includeSnapshots: !!opts.includeSnapshots
  }

  const entries: ZipEntry[] = [{ name: MANIFEST_NAME, data: textBytes(JSON.stringify(manifest, null, 2)) }]
  for (const f of all) entries.push({ name: f.path, data: textBytes(f.text) })

  return { blob: await makeZipCompressed(entries), manifest, paths: all.map((f) => f.path) }
}

/** 备份文件名：作品名-备份-时间.zip */
export function backupFileName(title: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  const safe = (title || '作品').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  return `${safe}-备份-${stamp}.zip`
}

/** 粗略估算人类可读体积 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/* ------------------------------------------------------------------ 恢复 */

/** 拒绝会把文件写到作品目录之外、或写到系统位置的条目名 */
export function isSafeEntryName(name: string): boolean {
  const n = name.replace(/\\/g, '/')
  if (!n || n.startsWith('/') || n.startsWith('~')) return false
  if (/^[a-zA-Z]:/.test(n)) return false // 盘符
  if (n.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false
  if (n.includes('\0')) return false
  return true
}

export interface RestoreOptions {
  /** 同名文件：overwrite 覆盖（默认）；skip 保留现有 */
  onConflict?: 'overwrite' | 'skip'
  onProgress?: (done: number, total: number, label: string) => void
}

export interface RestorePreview {
  manifest: BackupManifest | null
  files: { path: string; words: number }[]
  totalWords: number
  skipped: string[]
}

/** 先看一眼包里有什么，再决定要不要恢复 */
export async function previewBackup(bytes: Uint8Array): Promise<RestorePreview> {
  const { entries, skipped } = await readZip(bytes)
  let manifest: BackupManifest | null = null
  const files: RestorePreview['files'] = []

  for (const e of entries) {
    if (e.name === MANIFEST_NAME) {
      try {
        manifest = JSON.parse(bytesText(e.data)) as BackupManifest
      } catch {
        manifest = null // 清单坏了不影响恢复正文
      }
      continue
    }
    if (!isSafeEntryName(e.name)) {
      skipped.push(e.name)
      continue
    }
    const text = bytesText(e.data)
    files.push({ path: e.name, words: isBodyFile(e.name) ? countWords(parseDoc(text).body) : 0 })
  }

  return { manifest, files, totalWords: files.reduce((s, f) => s + f.words, 0), skipped }
}

export interface RestoreResult {
  written: string[]
  skipped: string[]
  refused: string[]
}

/** 把备份写回作品目录：只覆盖同名文件，绝不删除包里没有的东西 */
export async function restoreBackup(ref: DirRef, bytes: Uint8Array, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const { entries } = await readZip(bytes)
  const onConflict = opts.onConflict || 'overwrite'
  const written: string[] = []
  const skipped: string[] = []
  const refused: string[] = []

  const targets = entries.filter((e) => e.name !== MANIFEST_NAME)
  let i = 0
  for (const e of targets) {
    i++
    if (!isSafeEntryName(e.name)) {
      refused.push(e.name)
      continue
    }
    opts.onProgress?.(i, targets.length, e.name)
    const path = e.name.split('/')
    if (onConflict === 'skip' && (await fs().exists(ref, path))) {
      skipped.push(e.name)
      continue
    }
    await fs().writeFile(ref, path, bytesText(e.data))
    written.push(e.name)
  }

  return { written, skipped, refused }
}

/* ------------------------------------------------------------------ 占用统计 */

export interface UsageRow {
  label: string
  files: number
  bytes: number
}

export interface UsageReport {
  rows: UsageRow[]
  totalFiles: number
  totalBytes: number
  snapshotFiles: number
  snapshotBytes: number
}

/**
 * 磁盘占用。注意统计的是**文本的 UTF-8 字节数**，不含文件系统的块对齐开销，
 * 所以是个偏小的估计值 —— 用来判断「哪个目录在膨胀」足够，别拿它对账。
 */
export async function storageUsage(ref: DirRef): Promise<UsageReport> {
  const files = await collectFiles(ref)
  const byDir = new Map<string, UsageRow>()
  let totalBytes = 0

  for (const f of files) {
    const top = f.path.includes('/') ? f.path.split('/')[0] : '（根目录）'
    const label = TOP_DIRS.includes(top) ? top : top
    const row = byDir.get(label) || { label, files: 0, bytes: 0 }
    const b = textBytes(f.text).length
    row.files++
    row.bytes += b
    totalBytes += b
    byDir.set(label, row)
  }

  const rows = [...byDir.values()].sort((a, b) => b.bytes - a.bytes)

  const snaps = await collectSnapshots(ref, files.filter((f) => isBodyFile(f.path)).map((f) => f.path))
  const snapshotBytes = snaps.reduce((s, f) => s + textBytes(f.text).length, 0)

  return {
    rows,
    totalFiles: files.length,
    totalBytes,
    snapshotFiles: snaps.length,
    snapshotBytes
  }
}
