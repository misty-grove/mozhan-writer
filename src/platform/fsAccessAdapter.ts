/**
 * 浏览器宿主适配：File System Access API
 * 离线可用：读写的是用户选择的本机真实目录，不经过任何服务器。
 * 目录句柄持久化在 IndexedDB，下次打开可免选（若浏览器要求重新授权会提示）。
 */
import { isInternalName, type DirEntry, type DirRef, type FsAdapter, type PathSeg } from './types'

// 自行声明最小接口，避免与不同版本 lib.dom 产生重复定义冲突
interface FSH {
  name: string
  kind: string
  queryPermission(d?: any): Promise<PermissionState>
  requestPermission(d?: any): Promise<PermissionState>
}
interface FSDirH extends FSH {
  values(): AsyncIterableIterator<FSH>
  getDirectoryHandle(name: string, opt?: { create?: boolean }): Promise<FSDirH>
  getFileHandle(name: string, opt?: { create?: boolean }): Promise<FSFileH>
  removeEntry(name: string, opt?: { recursive?: boolean }): Promise<void>
}
interface FSFileH extends FSH {
  getFile(): Promise<File>
  createWritable(opt?: { keepExistingData?: boolean }): Promise<any>
}
interface FSWindow {
  showDirectoryPicker(opt?: any): Promise<FSDirH>
}

const DB_NAME = 'writer-fs'
const STORE = 'handles'

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

async function idbSet(key: string, val: unknown) {
  const db = await idb()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(val, key)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

async function idbGet(key: string): Promise<any> {
  const db = await idb()
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(key)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

async function idbDel(key: string) {
  const db = await idb()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

const opts = { mode: 'readwrite' as const }

/* 隐藏规则与内存沙盒、桌面 Rust 共用一份（`platform/types.ts`）。
   别在这里另写一条 —— 三个宿主不一致的后果是"换台机器就多出几个奇怪的文件"，
   或者更糟：某个内容目录被某一侧悄悄藏起来（`大纲/.mdAI文件/` 就踩过这个坑）。*/

class FsAccessAdapter implements FsAdapter {
  readonly kind = 'fsaccess' as const
  get supportsPickDir(): boolean {
    return typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function'
  }
  private handles = new Map<string, FSDirH>()

  private remember(id: string, h: FSDirH) {
    this.handles.set(id, h)
    idbSet(id, h).catch(() => void 0)
  }

  joinRef(parent: DirRef, name: string): DirRef {
    return { id: `${parent.id}::${name}`, name }
  }

  private async resolve(ref: DirRef): Promise<FSDirH> {
    const cached = this.handles.get(ref.id)
    if (cached) return cached
    const parts = ref.id.split('::')
    const h = (await idbGet(parts[0])) as FSDirH | undefined
    if (!h) throw new Error('目录句柄已失效，请重新选择该作品目录')
    let cur = h
    for (const seg of parts.slice(1)) cur = await cur.getDirectoryHandle(seg)
    this.handles.set(ref.id, cur)
    return cur
  }

  async pickDir(title?: string): Promise<DirRef | null> {
    const w = window as unknown as FSWindow
    if (!this.supportsPickDir) return null
    const h = await w.showDirectoryPicker({ id: 'writer', mode: 'readwrite', startIn: 'documents' })
    const id = (crypto as any).randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()
    this.remember(id, h)
    return { id, name: h.name }
  }

  async checkPermission(ref: DirRef): Promise<'granted' | 'prompt' | 'denied'> {
    try {
      const h = await this.resolve(ref)
      const p = await h.queryPermission(opts)
      return p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt'
    } catch {
      return 'denied'
    }
  }

  async requestPermission(ref: DirRef): Promise<boolean> {
    try {
      const h = await this.resolve(ref)
      const p = await h.requestPermission(opts)
      return p === 'granted'
    } catch {
      return false
    }
  }

  async forget(ref: DirRef) {
    this.handles.delete(ref.id)
    await idbDel(ref.id)
  }

  private async dirAt(root: FSDirH, path: PathSeg, create = false): Promise<FSDirH> {
    let cur = root
    for (const seg of path) {
      cur = await cur.getDirectoryHandle(seg, { create })
    }
    return cur
  }

  async listDir(ref: DirRef, path: PathSeg): Promise<DirEntry[]> {
    const dir = await this.dirAt(await this.resolve(ref), path)
    const out: DirEntry[] = []
    for await (const h of (dir as any).values() as AsyncIterableIterator<FSH>) {
      // 点开头的都是内部文件：.snapshots（快照）、.git、桌面端写入中的 .wrtmp 临时文件。
      // 三个宿主（浏览器 / 桌面 / 内存沙盒）必须用同一条规则 ——
      // 两个宿主列出的东西不一样，是这类应用最难查的一类 bug。
      if (isInternalName(h.name)) continue
      out.push({ name: h.name, kind: h.kind === 'directory' ? 'dir' : 'file' })
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1))
  }

  async exists(ref: DirRef, path: PathSeg): Promise<boolean> {
    try {
      const root = await this.resolve(ref)
      if (path.length === 0) return true
      const parent = await this.dirAt(root, path.slice(0, -1))
      await parent.getFileHandle(path[path.length - 1])
      return true
    } catch {
      try {
        const root = await this.resolve(ref)
        const parent = await this.dirAt(root, path.slice(0, -1))
        await parent.getDirectoryHandle(path[path.length - 1])
        return true
      } catch {
        return false
      }
    }
  }

  async readFile(ref: DirRef, path: PathSeg): Promise<string> {
    const root = await this.resolve(ref)
    const parent = await this.dirAt(root, path.slice(0, -1))
    const fh = await parent.getFileHandle(path[path.length - 1])
    return await (await fh.getFile()).text()
  }

  async writeFile(ref: DirRef, path: PathSeg, content: string): Promise<void> {
    const root = await this.resolve(ref)
    let parent = root
    for (let i = 0; i < path.length - 1; i++) parent = await parent.getDirectoryHandle(path[i], { create: true })
    const fh = await parent.getFileHandle(path[path.length - 1], { create: true })
    const w = await fh.createWritable()
    await w.write(content)
    await w.close()
  }

  async mkdir(ref: DirRef, path: PathSeg): Promise<void> {
    const root = await this.resolve(ref)
    await this.dirAt(root, path, true)
  }

  async remove(ref: DirRef, path: PathSeg): Promise<void> {
    const root = await this.resolve(ref)
    const parent = await this.dirAt(root, path.slice(0, -1))
    const name = path[path.length - 1]
    // remove 的语义是「让它不存在」，所以「本来就没有」不算失败 —— 幂等。
    const gone = (e: any) => e?.name === 'NotFoundError'
    const tryRemove = () => parent.removeEntry(name, { recursive: true })
    try {
      await tryRemove()
    } catch (e: any) {
      if (gone(e)) return
      // OPFS 的脾气：目标上还挂着没关干净的写入流时会抛 NoModificationAllowedError
      //（真实浏览器验收抓到的：改章名的「写新 + 删旧」撞上自动保存的尾巴）。
      // 让出一轮事件循环再试一次，比把错误甩给用户强。
      if (e?.name !== 'NoModificationAllowedError') throw e
      await new Promise((r) => setTimeout(r, 60))
      try {
        await tryRemove()
      } catch (e2: any) {
        if (!gone(e2)) throw e2
      }
    }
  }

  async rename(ref: DirRef, path: PathSeg, newName: string): Promise<void> {
    // FSA 无原生 rename：新建写入后删除（文件场景足够；卷改名走 copyDir 更安全）
    const content = await this.readFile(ref, path)
    await this.writeFile(ref, [...path.slice(0, -1), newName], content)
    await this.remove(ref, path)
  }

  async copyDir(ref: DirRef, from: PathSeg, dstRootRef: DirRef, toParent: PathSeg, toName: string): Promise<void> {
    const src = await this.dirAt(await this.resolve(ref), from)
    const dstRoot = await this.resolve(dstRootRef)
    let parent = dstRoot
    for (const seg of toParent) parent = await parent.getDirectoryHandle(seg, { create: true })
    const dst = await parent.getDirectoryHandle(toName, { create: true })
    await this.copyInto(src, dst)
  }

  private async copyInto(src: FSDirH, dst: FSDirH) {
    for await (const h of (src as any).values() as AsyncIterableIterator<FSH>) {
      if (h.kind === 'directory') {
        const sub = await dst.getDirectoryHandle(h.name, { create: true })
        await this.copyInto(h as FSDirH, sub)
      } else {
        const data = await (await (h as FSFileH).getFile()).arrayBuffer()
        const nf = await dst.getFileHandle(h.name, { create: true })
        const w = await nf.createWritable()
        await w.write(data)
        await w.close()
      }
    }
  }
}

export const fsAccessAdapter = new FsAccessAdapter()
