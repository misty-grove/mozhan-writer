/**
 * 设定库状态（Task #1 / #2 共用）
 *
 * 条目本体永远在作者的 Markdown 文件里，这里只做「按需加载 + 缓存」，
 * 换作品（state.ref 变化）或手动 markCodexDirty() 后自动重载。
 */
import { computed, reactive } from 'vue'
import { listEntries, createEntry, updateEntry, deleteEntry, KIND_ORDER } from '@/core/codex'
import type { SettingEntry, SettingKind } from '@/core/types'
import { state } from './workspace'

export const codexState = reactive({
  entries: [] as SettingEntry[],
  loaded: false,
  refId: '',
  selectedId: '',
  kindFilter: '' as SettingKind | '',
  query: ''
})

export const codexSelected = computed<SettingEntry | null>(
  () => codexState.entries.find((e) => e.id === codexState.selectedId) || null
)

/** 全部可被引用的名字（含别名） */
export const codexNames = computed<string[]>(() =>
  codexState.entries.flatMap((e) => [e.name, ...e.aliases]).filter(Boolean)
)

export const codexFiltered = computed<SettingEntry[]>(() => {
  const q = codexState.query.trim().toLowerCase()
  return codexState.entries
    .filter((e) => !codexState.kindFilter || e.kind === codexState.kindFilter)
    .filter((e) => !q || e.name.toLowerCase().includes(q) || e.aliases.join(' ').toLowerCase().includes(q) || e.body.toLowerCase().includes(q))
})

export const codexGroups = computed(() =>
  KIND_ORDER.map((k) => ({
    kind: k,
    items: codexState.entries.filter((e) => e.kind === k)
  })).filter((g) => g.items.length)
)

/** 懒加载：首次访问或换作品时读取 */
export async function ensureCodex(force = false) {
  if (!state.ref) return
  if (!force && codexState.loaded && codexState.refId === state.ref.id) return
  await refreshCodex()
}

export async function refreshCodex() {
  if (!state.ref) return
  codexState.entries = await listEntries(state.ref)
  codexState.refId = state.ref.id
  codexState.loaded = true
  if (codexState.selectedId && !codexState.entries.some((e) => e.id === codexState.selectedId)) {
    codexState.selectedId = ''
  }
}

export async function addEntry(kind: SettingKind, name: string, opts: { aliases?: string[]; fields?: Record<string, string>; body?: string } = {}) {
  if (!state.ref) return null
  const e = await createEntry(state.ref, kind, name, opts.fields || {}, opts.body || '')
  await refreshCodex()
  codexState.selectedId = e.id
  return e
}

export async function saveEntry(id: string, patch: { name?: string; aliases?: string[]; fields?: Record<string, string>; body?: string }) {
  if (!state.ref) return
  const nextId = await updateEntry(state.ref, id, patch)
  await refreshCodex()
  codexState.selectedId = nextId
}

export async function removeEntry(id: string) {
  if (!state.ref) return
  await deleteEntry(state.ref, id)
  if (codexState.selectedId === id) codexState.selectedId = ''
  await refreshCodex()
}
