/**
 * 沙盒状态（P3-F 降级模式的中枢）
 *
 * 三件事：
 *   1. 把内存宿主装上（setAdapter）并打开作品 —— 上层业务一行都不用改；
 *   2. 盯着「磁盘上已有什么」（基线指纹）与「内存里现在是什么」的差，
 *      得出「未导出 N 个文件」，顶栏据此显示沙盒标记；
 *   3. 导出 zip 落盘 + 顺手把内存镜像存进 IndexedDB。
 *
 * 基线用的是路径 → `长度:哈希`（见 core/degrade.ts），不是文件全文 ——
 * 存进 IndexedDB 时体积小，比较也快。
 */
import { computed, reactive } from 'vue'
import fs, { setAdapter, type DirRef } from '@/platform'
import { memAdapter, isHiddenKey } from '@/platform/memAdapter'
import { clearSandbox, loadSandbox, saveSandbox, type PersistedSandbox } from '@/platform/sandboxStore'
import {
  chipText as degradeChipText,
  diffAgainstBaseline,
  diffSummary,
  EMPTY_DIFF,
  fingerprint,
  fingerprints,
  importSummaryText,
  planImport,
  readImportEntries,
  sandboxFileName,
  sandboxManifest,
  SANDBOX_README,
  type FlatFile,
  type ImportPlan,
  type SandboxDiff
} from '@/core/degrade'
import { download } from '@/core/exportDoc'
import { fmtTime } from '@/core/util'
import { makeZipCompressed, textBytes, type ZipEntry } from '@/core/zip'
import { openWork, saveNow, state as wsState } from '@/stores/workspace'

export type SandboxOrigin = '' | 'import' | 'created' | 'restored'

export const sandbox = reactive({
  active: false,
  name: '',
  origin: '' as SandboxOrigin,
  /** 作品里的可见文件数（不含 .snapshots） */
  total: 0,
  diff: { ...EMPTY_DIFF } as SandboxDiff,
  skipped: [] as string[],
  importedAt: '',
  lastExportAt: '',
  /** 浏览器里那份镜像存下来了没有（存不下就得提醒作者自己留底） */
  mirrored: false,
  busy: false,
  message: ''
})

/** 进沙盒前的宿主，退出时要装回去 */
const defaultAdapter = fs()

export const isActive = computed(() => sandbox.active)
// 文案只有一份：core/degrade.ts。这里再抄一遍字面量，就会「测试过了、界面上还是旧词」。
export const chipText = computed(() => degradeChipText(sandbox.diff))
export const summaryText = computed(() => diffSummary(sandbox.diff))

/* ------------------------------------------------------------------ 基线 */

/** 基线 = 磁盘上已经有的东西。
 *  导入时是「导入进来的那批文件」，导出后是「刚导出的那批」。
 */
let baseline: Record<string, string> = {}

/** 当前沙盒的根。
 *  刻意不用 workspace 的 state.ref：进沙盒的过程中（ensureStructure 正在建目录）
 *  state.ref 还没切过来，而适配层每次写盘都会回调过来算差异 ——
 *  拿工作区的 ref 去内存宿主里找，会当场报「作品不存在」。 */
let sandboxRef: DirRef | null = null

/** 只统计用户看得见的文件：`.snapshots` 会天天变，混进「未导出」里只是噪音 */
function visibleFiles(): FlatFile[] {
  if (!sandboxRef) return []
  return memAdapter.dump(sandboxRef, { includeHidden: false }).map((f) => ({ path: f.path, text: f.text }))
}

export function refreshDiff() {
  if (!sandbox.active || !sandboxRef) {
    sandbox.diff = { ...EMPTY_DIFF }
    sandbox.total = 0
    return
  }
  try {
    const cur = visibleFiles()
    // 基线里「沙盒已经删掉」的条目要留着，否则「删除」这类改动下一轮就看不见了
    sandbox.diff = diffAgainstBaseline(baseline, cur)
    sandbox.total = cur.length
  } catch {
    // 算差异失败绝不能把写盘流程带走：宁可这一轮计数不动，也不能丢字
    sandbox.diff = { ...EMPTY_DIFF }
  }
}

/* ------------------------------------------------------------------ 落 IndexedDB */

let persistTimer: any = null
let persisting = false
let inflight: Promise<boolean> | null = null

function schedulePersist() {
  if (!sandbox.active) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => void persistNow(), 500)
}

async function writeOnce(): Promise<boolean> {
  const data: PersistedSandbox = {
    v: 1,
    savedAt: new Date().toISOString(),
    roots: memAdapter.serializer(),
    meta: {
      name: sandbox.name,
      origin: sandbox.origin,
      importedAt: sandbox.importedAt,
      lastExportAt: sandbox.lastExportAt,
      baseline,
      skipped: sandbox.skipped
    }
  }
  const ok = await saveSandbox(data)
  sandbox.mirrored = ok
  return ok
}

export async function persistNow(): Promise<boolean> {
  if (!sandbox.active) return false
  // 上一轮还没写完又来了新请求，不能直接放弃 —— 那是真会丢东西的：
  // 典型场景是「刚点完导出」：exportSandbox 换掉了 baseline 然后调 persistNow，
  // 可防抖那一轮（500ms 前被某次写盘触发）正在写，写进去的还是**旧基线**。
  // 老代码在这里直接 `return false` 了事，于是镜像里留着旧基线，
  // 作者刷新页面后顶栏又变回「沙盒 · 未导出 6」——明明刚导过，还被提醒「丢了找不回」。
  // 所以这里是等那一轮写完、再补写一次（拿的是最新的 baseline），
  // 而不是把它丢掉。并发写 IndexedDB 仍然只有一轮，没有破坏原来那个守卫。
  if (persisting && inflight) {
    await inflight
    if (!sandbox.active) return false
    return persistNow()
  }
  persisting = true
  inflight = writeOnce()
  try {
    return await inflight
  } finally {
    persisting = false
    inflight = null
  }
}
// 宿主每次写盘都回调；这里防抖 + 每次刷新差异，让计数始终是实的
function onAdapterChange() {
  if (!sandbox.active) return
  refreshDiff()
  schedulePersist()
}
memAdapter.onChange = onAdapterChange

/* ------------------------------------------------------------------ 进入 / 退出 */

export interface PersistedHint {
  name: string
  savedAt: string
  files: number
  dirty: number
}

/** 启动时问一句：上次的沙盒还在吗？（首页据此给「继续」入口） */
export async function persistedHint(): Promise<PersistedHint | null> {
  const d = await loadSandbox()
  if (!d) return null
  const visible = d.roots.flatMap((r) => r.files.filter(([k]) => !isHiddenKey(k)).map(([k, text]) => ({ path: k, text })))
  const diff = diffAgainstBaseline(d.meta.baseline, visible)
  return { name: d.meta.name, savedAt: d.savedAt, files: visible.length, dirty: diff.count }
}

function adoptAdapter() {
  setAdapter(memAdapter)
  sandbox.active = true
}

async function begin(name: string, origin: SandboxOrigin, files: Array<{ path: string[]; text: string }>, skipped: string[]) {
  const ref = memAdapter.createRoot(name, files)
  sandboxRef = ref
  adoptAdapter()
  sandbox.name = ref.name
  sandbox.origin = origin
  sandbox.importedAt = fmtTime(new Date())
  sandbox.lastExportAt = ''
  sandbox.skipped = skipped
  sandbox.message = ''
  // 基线 = 刚导进来的状态。以「新建」起的沙盒基线为空 —— 一切都要导出，本来就该如此。
  baseline = origin === 'import' ? fingerprintsOf(files) : {}
  await openWork(ref)
  refreshDiff()
  await persistNow()
  return ref
}

function fingerprintsOf(files: Array<{ path: string[]; text: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) {
    const p = f.path.join('/')
    if (!p) continue
    out[p] = fingerprint(f.text)
  }
  return out
}

/** 导入一个真实文件夹（FileList）进沙盒 */
export async function importFolder(fileList: ArrayLike<any>): Promise<{ ok: boolean; text: string }> {
  sandbox.busy = true
  try {
    const { entries, unreadable } = await readImportEntries(Array.from(fileList) as any)
    const plan: ImportPlan = planImport(entries)
    plan.skipped = [...plan.skipped, ...unreadable]
    if (!plan.files.length) return { ok: false, text: '这个文件夹里没有可导入的文本文件（.md / .txt 等）。' }
    await begin(plan.top || '导入的作品', 'import', plan.files, plan.skipped)
    const text = importSummaryText(plan)
    sandbox.message = text
    return { ok: true, text }
  } catch (e: any) {
    return { ok: false, text: String(e?.message || e) }
  } finally {
    sandbox.busy = false
  }
}

/** 从零新建一个沙盒作品（磁盘上暂时什么都没有） */
export async function createSandbox(name: string): Promise<{ ok: boolean; text: string }> {
  sandbox.busy = true
  try {
    const clean = String(name || '').trim() || '未命名作品'
    await begin(clean, 'created', [], [])
    sandbox.message = '沙盒作品已建好，结构和其他作品一样。写完记得导出。'
    return { ok: true, text: sandbox.message }
  } catch (e: any) {
    return { ok: false, text: String(e?.message || e) }
  } finally {
    sandbox.busy = false
  }
}

/** 继续上次的沙盒（IndexedDB 里的那份） */
export async function resumePersisted(): Promise<boolean> {
  const d = await loadSandbox()
  if (!d) return false
  sandbox.busy = true
  try {
    memAdapter.resetAll()
    for (const r of d.roots) memAdapter.restoreRoot(r.id, r.name, r.files.map(([k, v]) => [k, v]))
    adoptAdapter()
    sandbox.name = d.meta.name
    sandbox.origin = (d.meta.origin as SandboxOrigin) || 'restored'
    sandbox.importedAt = d.meta.importedAt
    sandbox.lastExportAt = d.meta.lastExportAt
    sandbox.skipped = d.meta.skipped || []
    baseline = d.meta.baseline || {}
    const ref = d.roots[0] ? { id: d.roots[0].id, name: d.roots[0].name } : null
    if (!ref) return false
    sandboxRef = ref
    await openWork(ref)
    refreshDiff()
    sandbox.message = `已从浏览器存储里恢复（${fmtTime(new Date(d.savedAt))} 的快照）。它还没落到磁盘上，记得导出。`
    return true
  } finally {
    sandbox.busy = false
  }
}

/** 退出沙盒：回首页，但**不删**浏览器里那份（下次还能继续） */
export async function leaveSandbox() {
  await saveNow()
  await persistNow()
  sandbox.active = false
  sandboxRef = null
  sandbox.message = ''
  setAdapter(defaultAdapter)
}

/** 丢弃沙盒：浏览器里那份也删掉。磁盘上的原件不受影响。 */
export async function discardSandbox() {
  sandbox.active = false
  sandboxRef = null
  baseline = {}
  memAdapter.resetAll()
  await clearSandbox()
  setAdapter(defaultAdapter)
  sandbox.name = ''
  sandbox.origin = ''
  sandbox.skipped = []
  sandbox.diff = { ...EMPTY_DIFF }
  sandbox.total = 0
  sandbox.lastExportAt = ''
  sandbox.message = ''
}

/* ------------------------------------------------------------------ 导出 */

export interface ExportResult {
  ok: boolean
  text: string
  fileName: string
}

/**
 * 导出成 zip。
 * - `scope: 'all'`  全量：解开就是一个完整作品目录，可以整包替换原文件夹
 * - `scope: 'changed'` 只带改动过的文件：省体积，但要**覆盖**到原文件夹上（不是替换）
 */
export async function exportSandbox(scope: 'all' | 'changed' = 'all'): Promise<ExportResult> {
  if (!sandbox.active || !sandboxRef) return { ok: false, text: '当前不在沙盒里。', fileName: '' }
  await saveNow()
  const files = visibleFiles()
  const d = sandbox.diff
  const picked = scope === 'changed' ? files.filter((f) => d.dirty.includes(f.path)) : files
  if (!picked.length) return { ok: false, text: '没有需要导出的改动。', fileName: '' }

  const manifest = sandboxManifest({
    name: sandbox.name,
    scope,
    files: picked,
    changed: scope === 'changed' ? picked.map((f) => f.path) : [],
    removed: d.removed
  })
  const readme = [
    `# ${sandbox.name} · 沙盒导出`,
    '',
    `导出时间：${manifest.exportedAt}`,
    `范围：${scope === 'all' ? '全部文件（可直接替换原文件夹）' : `仅改动的 ${picked.length} 个文件（请**覆盖**到原文件夹上，不要整包替换）`}`,
    '',
    '## 怎么用',
    '把这个压缩包解开，把里面的目录与文件覆盖回你原来的作品文件夹。',
    '目录结构与原作品完全一致，仍然是普通 Markdown，记事本照样能改。',
    '',
    ...(d.removed.length
      ? ['## 需要你自己删的', '下面这些文件在沙盒里被删掉了。压缩包表达不了「删除」，请到磁盘上手动删：', ...d.removed.map((p) => `- ${p}`), '']
      : []),
    '## 没被带上的',
    '非文本素材（插图、字体等）从不进沙盒，一直留在你的原文件夹里。',
    ''
  ].join('\n')

  const entries: ZipEntry[] = [
    { name: '沙盒导出信息.json', data: textBytes(JSON.stringify(manifest, null, 2)) },
    { name: SANDBOX_README, data: textBytes(readme) },
    ...picked.map((f) => ({ name: f.path, data: textBytes(f.text) }))
  ]
  const blob = await makeZipCompressed(entries)
  const fileName = sandboxFileName(wsState.info.title || sandbox.name, new Date(), scope)
  download(blob, fileName)

  // 导出完就把当前内容当成新的基线：从这一刻起，磁盘与沙盒一致
  baseline = fingerprints(files)
  sandbox.lastExportAt = fmtTime(new Date())
  refreshDiff()
  await persistNow()

  const tail = d.removed.length ? `；另有 ${d.removed.length} 个文件在沙盒里被删掉，导出包表达不了删除，请到磁盘上手动删` : ''
  return {
    ok: true,
    text: `已导出 ${picked.length} 个文件到 ${fileName}${tail}`,
    fileName
  }
}

/* ------------------------------------------------------------------ 杂项 */

export function resetSandboxForTest() {
  sandbox.active = false
  sandboxRef = null
  baseline = {}
  memAdapter.resetAll()
  memAdapter.onChange = onAdapterChange
  setAdapter(defaultAdapter)
}

/* 关页面前提醒：沙盒里还有没导出的改动。
   原生 `beforeunload` 是浏览器唯一不允许自定义的弹窗（文案也由浏览器决定），
   所以这里只负责「拦一下」，措辞交给浏览器。 */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (!sandbox.active || !sandbox.diff.count) return
    e.preventDefault()
    e.returnValue = ''
  })
}
