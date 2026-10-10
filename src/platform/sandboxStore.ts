/**
 * 沙盒的落盘（IndexedDB）
 *
 * 降级模式下「真实磁盘」是够不着的，但**浏览器自己的存储**还在。
 * 把内存里的作品顺带存一份进 IndexedDB，是为了防住最讨厌的那种事故：
 * 写了三千字，手一抖按了 F5 / 浏览器崩了 —— 回来什么都没有。
 *
 * 注意分寸：这不是「保存」，只是防手滑。真正的落盘永远是作者点的那次「导出」，
 * 所以 UI 上仍然如实显示「未导出 N 个文件」。
 *
 * 环境里没有 indexedDB（Node 自检、隐私模式）时所有接口都安静地失败，
 * 不影响内存宿主继续工作。
 */
const DB_NAME = 'writer-sandbox'
const STORE = 'state'
const KEY = 'current'

export interface PersistedRoot {
  id: string
  name: string
  files: Array<[string, string]>
}

export interface PersistedSandbox {
  v: 1
  savedAt: string
  roots: PersistedRoot[]
  meta: {
    name: string
    origin: string
    importedAt: string
    lastExportAt: string
    /** 上次「已落盘」时的文件指纹（path → len:hash） */
    baseline: Record<string, string>
    skipped: string[]
  }
}

export function sandboxStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && !!indexedDB
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise<T>((res, rej) => {
    openDb()
      .then((db) => {
        const t = db.transaction(STORE, mode)
        const r = fn(t.objectStore(STORE))
        r.onsuccess = () => res(r.result as T)
        r.onerror = () => rej(r.error)
      })
      .catch(rej)
  })
}

/**
 * 抹掉 Vue 的响应式代理再入库。
 *
 * 真实浏览器验收抓到的：`sandbox.skipped` 是 reactive 数组，直接 `put` 进去会抛
 * `DataCloneError`（结构化克隆不认识 Proxy），而这个异常被 catch 吞掉，
 * 表现就是「刷新之后稿子没了」，还一声不响。数据的形状本来就是 JSON 那一套
 * （字符串 / 数组 / 普通对象），所以这里用 JSON 往返一次性去代理，最稳。
 */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export async function saveSandbox(data: PersistedSandbox): Promise<boolean> {
  if (!sandboxStorageAvailable()) return false
  try {
    await tx('readwrite', (s) => s.put(plain(data), KEY))
    return true
  } catch {
    return false
  }
}

export async function loadSandbox(): Promise<PersistedSandbox | null> {
  if (!sandboxStorageAvailable()) return null
  try {
    const v = await tx<PersistedSandbox | undefined>('readonly', (s) => s.get(KEY))
    if (!v || v.v !== 1 || !Array.isArray(v.roots) || !v.roots.length) return null
    return v
  } catch {
    return null
  }
}

export async function clearSandbox(): Promise<void> {
  if (!sandboxStorageAvailable()) return
  try {
    await tx('readwrite', (s) => s.delete(KEY))
  } catch {
    /* 删不掉就算了，别让退出流程卡住 */
  }
}
