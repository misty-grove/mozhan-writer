import { computed, reactive, ref } from 'vue'
import fs, { hasTauri, mobileEnv, type DirRef } from '@/platform'
import * as ws from '@/core/workspace'
import { autoSnapshot, listSnapshots, createSnapshot, readSnapshot } from '@/core/snapshots'
import { countWords, fmtTime } from '@/core/util'
import { settings, touchRecent } from '@/core/settings'
import { addTodayWords, todayWords } from '@/core/workspace'
import { resetNav } from '@/stores/editor'
import { askConfirm } from '@/stores/dialog'
import type { AssetDoc, Chapter, ChapterStatus, Volume, VolumeMeta, WorkInfo } from '@/core/types'

export const state = reactive({
  ref: null as DirRef | null,
  info: { title: '', author: '', brief: '', targetWords: 0, created: '' } as WorkInfo,
  volumes: [] as Volume[],
  rootChapters: [] as Chapter[],
  assets: [] as AssetDoc[],
  bodies: {} as Record<string, string>,
  currentId: '' as string,
  content: '' as string,
  dirty: false,
  saving: false,
  lastSaved: '' as string,
  loading: false,
  loadingText: '',
  status: '' as string,
  todayWords: todayWords()
})

export const storageNotice = ref('')

export const currentChapter = computed<Chapter | null>(() => {
  if (!state.currentId) return null
  return allChapters.value.find((c) => c.id === state.currentId) || null
})

export const currentVolume = computed<Volume | null>(() => {
  const c = currentChapter.value
  if (!c?.volumeId) return null
  return state.volumes.find((v) => v.id === c.volumeId) || null
})

export const allChapters = computed<Chapter[]>(() => [
  ...state.rootChapters,
  ...state.volumes.flatMap((v) => v.chapters)
])

/** 卷 → 章的自然书写顺序（scanWork 已按文件名序号排好） */
export const orderedChapters = computed<Chapter[]>(() => [...state.rootChapters, ...state.volumes.flatMap((v) => v.chapters)])

export const totalWords = computed(() => state.volumes.reduce((s, v) => s + v.wordCount, 0) + state.rootChapters.reduce((s, c) => s + c.wordCount, 0))
export const chapterCount = computed(() => allChapters.value.length)
export const currentWords = computed(() => countWords(state.content))

/* ------------------------------------------------------------------ 打开 / 创建 */

export async function ensurePermission(ref: DirRef): Promise<boolean> {
  const p = await fs().checkPermission(ref)
  if (p === 'granted') return true
  if (p === 'prompt') return await fs().requestPermission(ref)
  return false
}

export async function openWork(ref: DirRef) {
  state.loading = true
  state.loadingText = '正在读取作品目录…'
  try {
    if (!(await ensurePermission(ref))) {
      storageNotice.value = '该目录的访问权限未授予，请重新选择。'
      return false
    }
    if (!(await ws.looksLikeWork(ref))) {
      storageNotice.value = '所选目录不是标准作品目录，已自动补齐标准结构。'
      await ws.ensureStructure(ref)
    } else {
      await ws.ensureStructure(ref)
    }
    state.ref = ref
    // 换作品就别带着上一部的编辑位置历史了（导航历史是「作品内」的概念）
    resetNav()
    await refresh(false)
    // 真实浏览器里暴露的问题：新作品一章都没有，而章节树默认是收起的，
    // 用户面对一片空白找不到建章的入口。没有章节时直接把树展开。
    // 手机上不这么做：目录是盖在稿纸上的抽屉，展开等于一进来就看不见正文；
    // 而「新建第一章」的入口本来就在编辑区里（.blank-start），不靠抽屉引路。
    if (!orderedChapters.value.length && !mobileEnv.value) settings.ui.sidebarOpen = true
    touchRecent({
      refId: ref.id,
      name: state.info.title || ref.name,
      pathLabel: ref.name,
      lastOpened: fmtTime(new Date()),
      lastWordCount: totalWords.value
    })
    const first = orderedChapters.value[0]
    if (first) await selectChapter(first.id)
    return true
  } finally {
    state.loading = false
    state.loadingText = ''
  }
}

export async function createWork(parent: DirRef, name: string, info: Partial<WorkInfo>) {
  const ref = await ws.createWork(parent, name, info)
  return ref
}

/**
 * 启动时恢复上次打开的作品。
 *
 * 只在权限已经授予（queryPermission === 'granted'）时自动进入，
 * 否则留在首页让用户自己点 —— requestPermission 需要用户手势，
 * 在启动阶段调用会被浏览器直接拒绝。
 */
export async function restoreLastWork(): Promise<boolean> {
  if (state.ref) return false
  const last = settings.recent[0]
  if (!last) return false
  const ref: DirRef = { id: last.refId, name: last.pathLabel }
  try {
    if ((await fs().checkPermission(ref)) !== 'granted') return false
  } catch {
    return false
  }
  try {
    return await openWork(ref)
  } catch {
    return false
  }
}

export async function refresh(withChapter = true) {
  if (!state.ref) return
  const res = await ws.scanWork(state.ref, (d, t) => {
    state.loadingText = `正在索引 ${d}/${t} …`
  })
  state.volumes = res.volumes
  state.rootChapters = res.rootChapters
  state.info = await ws.readWorkInfo(state.ref)
  state.assets = await ws.listAssetDocs(state.ref)
  if (withChapter && !currentChapter.value) {
    const first = orderedChapters.value[0]
    if (first) await selectChapter(first.id)
  }
}

/* ------------------------------------------------------------------ 章节读写 */

export async function selectChapter(id: string, force = false) {
  if (state.currentId === id && !force) return
  if (state.dirty && !force) await saveNow()
  if (!state.ref) return
  // 先把正文读出来再改 currentId。
  // 反过来的话，编辑器里 watch(currentId) 会在正文还没加载时就被触发，
  // setContent 拿到的是上一章的旧内容 —— 表现为「切章后编辑区还是上一章」
  // 甚至「刚打开作品时编辑区一片空白」。
  let body = ''
  try {
    body = await ws.readChapterBody(state.ref, id)
  } catch {
    body = ''
  }
  state.content = body
  state.bodies[id] = body
  state.currentId = id
  state.dirty = false
}

export function markDirty(text: string) {
  const before = countWords(state.content)
  state.content = text
  state.dirty = true
  const after = countWords(text)
  const delta = after - before
  if (delta > 0) {
    addTodayWords(delta)
    state.todayWords = todayWords()
  }
  scheduleSave()
}

let saveTimer: any = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  state.status = '未保存'
  saveTimer = setTimeout(() => saveNow(), settings.general.autoSaveMs)
}

export async function saveNow(): Promise<boolean> {
  if (!state.ref || !state.currentId) return false
  if (!state.dirty && !saveTimer) return true
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  state.saving = true
  state.status = '保存中'
  try {
    if (settings.general.autoSnapshot) await autoSnapshot(state.ref, state.currentId, await rawCurrentFile())
    await ws.saveChapter(state.ref, state.currentId, state.content)
    const ch = currentChapter.value
    if (ch) {
      ch.wordCount = countWords(state.content)
      ch.updated = fmtTime(new Date())
    }
    state.bodies[state.currentId] = state.content
    state.dirty = false
    state.lastSaved = fmtTime(new Date())
    state.status = '已保存'
    syncRecent()
    return true
  } catch (e: any) {
    state.status = `保存失败：${e?.message || e}`
    return false
  } finally {
    state.saving = false
  }
}

async function rawCurrentFile(): Promise<string> {
  if (!state.ref) return ''
  try {
    return await ws.readChapterText(state.ref, state.currentId)
  } catch {
    return state.content
  }
}

/* ------------------------------------------------------------------ 关窗 / 切走时保住最后一笔 */

/**
 * 立刻把还没落盘的内容写下去。
 *
 * 自动保存是防抖的（默认 1500ms），所以「敲完最后一句就关窗口」会丢掉那一段。
 * 浏览器里还能靠 beforeunload 挡一下，桌面端没有任何兜底 ——
 * 关窗时 webview 直接被销毁，`setTimeout` 里那次保存再也不会发生。
 */
export async function flushSave(): Promise<boolean> {
  if (!state.ref || !state.currentId) return true
  if (!state.dirty && !saveTimer) return true
  return saveNow()
}

/** 有没有「敲了但还没写下去」的内容 */
export function hasPendingSave(): boolean {
  return !!state.ref && !!state.currentId && (state.dirty || !!saveTimer)
}

let guardsInstalled = false

/**
 * 装好「离开前先把稿子写下去」的守卫。重复调用无副作用。
 *
 * 两条路各管一边：
 * - 桌面端：拦下关窗请求 → 冲刷 → 再真正销毁窗口。
 * - 浏览器端：`pagehide` 与切到后台时尽力冲一次。这里不能 await（页面随时会被冻住），
 *   属于「能救多少救多少」，但总比什么都不做强。
 */
export function installSaveGuards() {
  if (guardsInstalled || typeof window === 'undefined') return
  guardsInstalled = true

  if (hasTauri()) {
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        await win.onCloseRequested(async (event) => {
          if (!hasPendingSave()) return // 没有待写内容，正常关
          event.preventDefault()

          // `flushSave()` 不会抛 —— 它内部的 saveNow 已经把异常收成了 `false`。
          // 所以**必须看返回值**：不看的话，「盘满 / 文件被占用」时窗口会照关，
          // 那一段就静默没了，守卫等于白装。
          let flushed = false
          try {
            flushed = await flushSave()
          } catch {
            flushed = false
          }

          if (!flushed) {
            // 写不进去。两条路都不走：不静默丢弃，也不能把窗口卡死（关不掉的应用
            // 比丢一段稿更糟）。问一句，让作者自己决定。
            const discard = await askConfirm({
              title: '有内容没能写进磁盘',
              message: `刚才的改动保存失败了（${state.status || '原因不明'}）。现在关闭会丢掉这一段。`,
              detail: [
                `当前章节：${currentChapter.value?.title || '（未命名）'}`,
                `未保存字数：约 ${countWords(state.content)} 字`,
                '选择「留在这里」可以先处理一下（比如腾出磁盘空间）再关。'
              ],
              okText: '丢弃并关闭',
              cancelText: '留在这里',
              danger: true
            }).catch(() => false)
            if (!discard) return // 什么都不做 —— 窗口留着
          }

          // 用 destroy 而不是 close()：close 会再走一遍关窗请求，容易绕成环
          await win.destroy().catch((err) => {
            console.error('[writer] 关窗失败，窗口可能关不掉了：', err)
          })
        })
      } catch {
        // 守卫装不上不该让应用打不开 —— 退化成"只有自动保存"，并把话说清楚
        console.warn('[writer] 关窗守卫未能安装，关窗时可能丢掉最后一段未写入的内容')
      }
    })()
    return
  }

  const bestEffort = () => {
    if (hasPendingSave()) void flushSave()
  }
  window.addEventListener('pagehide', bestEffort)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') bestEffort()
  })
}

/**
 * 让「最近的作品」里的字数跟着正文走。
 * 原先只在打开作品那一刻记一次，新作品永远显示 0 字，看起来像丢了稿子。
 */
let recentWordsCache = -1
function syncRecent() {
  if (!state.ref) return
  const total = totalWords.value
  if (total === recentWordsCache) return
  recentWordsCache = total
  touchRecent({
    refId: state.ref.id,
    name: state.info.title || state.ref.name,
    pathLabel: state.ref.name,
    lastOpened: fmtTime(new Date()),
    lastWordCount: total
  })
}

/* ------------------------------------------------------------------ 结构操作 */

export async function newChapter(volumeId: string | null, title: string) {
  if (!state.ref) return
  const ch = await ws.createChapter(state.ref, volumeId, title)
  await refresh(false)
  await selectChapter(ch.id)
}

export async function newVolume(name: string) {
  if (!state.ref) return
  await ws.createVolume(state.ref, name)
  await refresh(false)
}

export async function renameChapter(id: string, title: string) {
  if (!state.ref) return
  const old = allChapters.value.find((c) => c.id === id)
  if (!old) return
  // 先把在途改动落盘，再做「写新文件 + 删旧文件」这套动作。两个原因：
  //  1. 下面读的是磁盘上的正文，不落盘的话「改个章名」会把刚写的几段悄悄丢掉（自动保存是防抖的）；
  //  2. 旧文件上还挂着没关干净的写入流时，OPFS 的 removeEntry 会抛 NoModificationAllowedError。
  await saveNow()
  const parts = id.split('/')
  const parent = parts.slice(0, -1)
  const order = Number(/第\s*(\d+)\s*章/.exec(old.file)?.[1] || 1)
  const newFile = ws.chapterFileName(order, title)
  if (newFile === old.file) {
    old.title = title
    await ws.saveChapter(state.ref, id, old.id === state.currentId ? state.content : await ws.readChapterBody(state.ref, id), { title })
    return
  }
  const raw = await ws.readChapterText(state.ref, id)
  await fs().writeFile(state.ref, [...parent, newFile], raw.replace(/^title:.*$/m, `title: ${title}`))
  await fs().remove(state.ref, id.split('/'))
  await refresh(false)
  await selectChapter([...parent, newFile].join('/'))
}

export async function removeChapter(id: string) {
  if (!state.ref) return
  await saveNow()
  await ws.deleteChapter(state.ref, id)
  if (state.currentId === id) state.currentId = ''
  await refresh(false)
  const next = orderedChapters.value[0]
  if (next) await selectChapter(next.id)
}

export async function duplicate(id: string) {
  if (!state.ref) return
  const ch = await ws.duplicateChapter(state.ref, id)
  await refresh(false)
  await selectChapter(ch.id)
}

export async function setStatus(id: string, status: ChapterStatus) {
  if (!state.ref) return
  await ws.saveChapter(state.ref, id, id === state.currentId ? state.content : await ws.readChapterBody(state.ref, id), { status })
  const ch = allChapters.value.find((c) => c.id === id)
  if (ch) ch.status = status
}

export async function saveChapterCard(id: string, meta: any) {
  if (!state.ref) return
  await ws.saveChapter(state.ref, id, id === state.currentId ? state.content : await ws.readChapterBody(state.ref, id), meta)
  const ch = allChapters.value.find((c) => c.id === id)
  if (ch) {
    ch.title = meta.title ?? ch.title
    if (meta.status) ch.status = meta.status
    if (meta.tags) ch.tags = meta.tags
    Object.assign(ch.meta, {
      target: meta.target ?? ch.meta.target,
      characters: meta.characters ?? ch.meta.characters,
      settings: meta.settings ?? ch.meta.settings,
      emotion: meta.emotion ?? ch.meta.emotion,
      notes: meta.notes ?? ch.meta.notes
    })
  }
}

export async function moveChapter(id: string, targetVolumeId: string | null, newOrder: string[]) {
  if (!state.ref) return
  const parent = targetVolumeId ? targetVolumeId.split('/') : [ws.DIRS.body]
  const raw = await ws.readChapterText(state.ref, id)
  const parts = id.split('/')
  const file = parts[parts.length - 1]
  const targetPath = [...parent, file]
  if (targetPath.join('/') !== id) {
    await fs().writeFile(state.ref, targetPath, raw)
    await fs().remove(state.ref, id.split('/'))
  }
  await ws.reorderChapters(state.ref, targetVolumeId, newOrder.map((x) => (x === id ? targetPath.join('/') : x)))
  await refresh(false)
}

export async function reorder(volumeId: string | null, ids: string[]) {
  if (!state.ref) return
  await ws.reorderChapters(state.ref, volumeId, ids)
  await refresh(false)
}

export async function saveVolumeMeta(volumeId: string, meta: VolumeMeta, body: string) {
  if (!state.ref) return
  await ws.saveVolumeOutline(state.ref, volumeId, meta, body)
  const v = state.volumes.find((x) => x.id === volumeId)
  if (v) v.meta = meta
}

export async function renameVolume(volumeId: string, name: string) {
  if (!state.ref) return
  const newId = await ws.renameVolume(state.ref, volumeId, name)
  await refresh(false)
  return newId
}

export async function removeVolume(volumeId: string) {
  if (!state.ref) return
  await fs().remove(state.ref, volumeId.split('/'))
  await refresh(false)
}

export async function updateInfo(patch: Partial<WorkInfo>) {
  if (!state.ref) return
  Object.assign(state.info, patch)
  await ws.writeWorkInfo(state.ref, state.info)
  touchRecent({
    refId: state.ref.id,
    name: state.info.title || state.ref.name,
    pathLabel: state.ref.name,
    lastOpened: fmtTime(new Date()),
    lastWordCount: totalWords.value
  })
}

/* ------------------------------------------------------------------ 全文索引 */

/**
 * 把全部章节正文读进内存（双链、出场统计、一致性检查都要用）。
 * 只在缺的章节上补读；当前章节永远用编辑器里的实时内容。
 */
export async function ensureBodies(force = false): Promise<Record<string, string>> {
  if (!state.ref) return state.bodies
  const chapters = orderedChapters.value
  if (force) state.bodies = {}
  const missing = chapters.filter((c) => state.bodies[c.id] === undefined && c.id !== state.currentId)
  if (missing.length) {
    await Promise.all(
      missing.map(async (c) => {
        try {
          state.bodies[c.id] = await ws.readChapterBody(state.ref!, c.id)
        } catch {
          state.bodies[c.id] = ''
        }
      })
    )
  }
  if (state.currentId) state.bodies[state.currentId] = state.content
  return state.bodies
}

/* ------------------------------------------------------------------ 快照 */

export async function snapshots(id: string) {
  if (!state.ref) return []
  return await listSnapshots(state.ref, id)
}

export async function makeSnapshot(id: string, kind: 'auto' | 'manual' = 'manual') {
  if (!state.ref) return
  await createSnapshot(state.ref, id, await ws.readChapterText(state.ref, id), kind)
}

export async function readSnap(id: string, name: string) {
  if (!state.ref) return ''
  return await readSnapshot(state.ref, id, name)
}

export function closeWork() {
  state.ref = null
  state.volumes = []
  state.rootChapters = []
  state.assets = []
  state.content = ''
  state.currentId = ''
  state.dirty = false
}

/** 今日已写字数（响应式） */
export const todayWordsNow = computed(() => state.todayWords)
