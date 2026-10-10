/**
 * 内存宿主适配（P3-F 降级模式）
 *
 * 给没有 File System Access API 的浏览器（Firefox / Safari）用：
 * 作品先读进内存，全部业务代码照常跑（它只认 FsAdapter 这个接口），
 * 最后由作者手动「导出」成 zip 落回磁盘。
 *
 * 为什么不是「假装成 FSA」：那样只能骗过能力探测，真正的落盘依旧不存在。
 * 这里的做法是把代价摆到明面上 —— 宿主自称 kind: 'memory'、supportsPickDir: false，
 * UI 据此显示「沙盒」标记与「未导出 N 个文件」。
 *
 * 表示法是**扁平**的：一个 Map<路径, 文本> + 一个目录集合。
 * 比树省事的地方在于 diff / 落 IndexedDB / 导出全都可以直接遍历，
 * 而这套东西的规模上限就是一部小说（几百个文件），不需要索引结构。
 */
import { isInternalName, type DirEntry, type DirRef, type FsAdapter, type PathSeg } from './types'

export interface MemRootData {
  name: string
  /** 路径（'正文/第001章.md'）→ 文本 */
  files: Map<string, string>
  /** 显式建过、但可能还没有文件的目录 */
  dirs: Set<string>
}

const join = (segs: string[]) => segs.filter((s) => s !== '' && s != null).join('/')

/**
 * 这个 key 是不是宿主内部物 —— 规则与浏览器宿主、桌面 Rust 宿主**共用同一份名单**
 * （`platform/types.ts` 的 `INTERNAL_NAMES` / `isInternalName`）。
 *
 * 沙盒算「未导出」时要跳过它们，否则快照天天在变、永远显示"未导出 N"。
 * 注意这里判的是**路径里有没有内部片段**，不是"点开头"——
 * `大纲/.mdAI文件/剧情大纲.md` 是正经内容，藏了它就等于丢内容。
 */
export function isHiddenKey(k: string): boolean {
  return k.split('/').some((s) => isInternalName(s))
}

interface View {
  root: MemRootData
  prefix: string[]
}

export function newRootData(name: string): MemRootData {
  return { name, files: new Map(), dirs: new Set() }
}

class MemAdapter implements FsAdapter {
  readonly kind = 'memory' as const
  readonly supportsPickDir = false

  private roots = new Map<string, MemRootData>()
  private seq = 0
  /** 每次写操作后回调（沙盒用来重算差异、防抖落 IndexedDB） */
  onChange: (() => void) | null = null

  private touch() {
    this.onChange?.()
  }

  /* ---------------------------------------------------------- 根的建立 / 取出 */

  /** 新建一个根（id 形如 mem:作品名，重名自动加序号） */
  createRoot(name: string, files: Array<{ path: string[]; text: string }> = []): DirRef {
    const clean = String(name || '未命名作品').trim() || '未命名作品'
    let id = `${'mem:'}${clean}`
    let n = 2
    while (this.roots.has(id)) id = `${'mem:'}${clean}#${n++}`
    const data = newRootData(clean)
    this.roots.set(id, data)
    for (const f of files) {
      const k = join(f.path)
      if (!k) continue
      data.files.set(k, f.text)
    }
    this.touch()
    return { id, name: clean }
  }

  /** 从持久化数据恢复（覆盖同名根） */
  restoreRoot(id: string, name: string, files: Array<[string, string]>): DirRef {
    const data = newRootData(name)
    for (const [k, v] of files) data.files.set(k, v)
    this.roots.set(id, data)
    this.touch()
    return { id, name }
  }

  hasRoot(id: string): boolean {
    return this.roots.has((id || '').split('::')[0])
  }

  /** 序列化全部根，交给 IndexedDB 存 */
  serializer(): Array<{ id: string; name: string; files: Array<[string, string]> }> {
    return [...this.roots.entries()].map(([id, r]) => ({ id, name: r.name, files: [...r.files.entries()] }))
  }

  dropRoot(ref?: DirRef) {
    const id = ref ? ref.id.split('::')[0] : ''
    if (id) this.roots.delete(id)
    else this.roots.clear()
    this.touch()
  }

  private view(ref: DirRef): View {
    const parts = (ref?.id || '').split('::')
    const root = this.roots.get(parts[0])
    if (!root) throw new Error('沙盒作品已不存在（可能被丢弃了）')
    return { root, prefix: parts.slice(1) }
  }

  private key(v: View, path: PathSeg) {
    return join([...v.prefix, ...(path || [])])
  }

  /* ---------------------------------------------------------- FsAdapter */

  async pickDir(): Promise<DirRef | null> {
    // 内存宿主没有「选一个真目录」这回事。返回 null 而不是抛错：
    // 调用点（首页）看到的都是「用户取消了」，正好是我们想表达的。
    return null
  }

  async checkPermission(): Promise<'granted'> {
    return 'granted'
  }

  async requestPermission(): Promise<boolean> {
    return true
  }

  joinRef(parent: DirRef, name: string): DirRef {
    return { id: `${parent.id}::${name}`, name }
  }

  async listDir(ref: DirRef, path: PathSeg): Promise<DirEntry[]> {
    const v = this.view(ref)
    const base = this.key(v, path || [])
    const dirNames = new Set<string>()
    const fileNames = new Set<string>()

    const add = (k: string) => {
      if (base && !k.startsWith(base + '/')) return
      const rest = base ? k.slice(base.length + 1) : k
      if (!rest) return
      const i = rest.indexOf('/')
      if (i < 0) fileNames.add(rest)
      else dirNames.add(rest.slice(0, i))
    }
    for (const k of v.root.files.keys()) add(k)
    for (const d of v.root.dirs) add(d + '/')

    const out: DirEntry[] = []
    for (const d of dirNames) if (!isInternalName(d)) out.push({ name: d, kind: 'dir' })
    for (const f of fileNames) if (!isInternalName(f)) out.push({ name: f, kind: 'file' })
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1))
  }

  private dirExists(root: MemRootData, k: string): boolean {
    if (!k) return true
    if (root.dirs.has(k)) return true
    const pre = k + '/'
    for (const f of root.files.keys()) if (f.startsWith(pre)) return true
    return false
  }

  async exists(ref: DirRef, path: PathSeg): Promise<boolean> {
    const v = this.view(ref)
    const k = this.key(v, path || [])
    if (v.root.files.has(k)) return true
    return this.dirExists(v.root, k)
  }

  async readFile(ref: DirRef, path: PathSeg): Promise<string> {
    const v = this.view(ref)
    const k = this.key(v, path || [])
    const t = v.root.files.get(k)
    if (t === undefined) throw new Error(`读不到文件：${k}`)
    return t
  }

  async writeFile(ref: DirRef, path: PathSeg, content: string): Promise<void> {
    const v = this.view(ref)
    const k = this.key(v, path || [])
    if (!k) return
    // 同名位置上原来是个目录：文件顶掉目录（否则会出现「既是文件又是目录」的怪物）
    v.root.dirs.delete(k)
    v.root.files.set(k, content)
    this.touch()
  }

  async mkdir(ref: DirRef, path: PathSeg): Promise<void> {
    const v = this.view(ref)
    const k = this.key(v, path || [])
    if (!k) return
    v.root.dirs.add(k)
    this.touch()
  }

  async remove(ref: DirRef, path: PathSeg): Promise<void> {
    const v = this.view(ref)
    const k = this.key(v, path || [])
    if (!k) return
    v.root.files.delete(k)
    v.root.dirs.delete(k)
    const pre = k + '/'
    for (const f of [...v.root.files.keys()]) if (f.startsWith(pre)) v.root.files.delete(f)
    for (const d of [...v.root.dirs]) if (d.startsWith(pre)) v.root.dirs.delete(d)
    this.touch()
  }

  async rename(ref: DirRef, path: PathSeg, newName: string): Promise<void> {
    const v = this.view(ref)
    const k = this.key(v, path || [])
    const parent = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : ''
    const next = parent ? `${parent}/${newName}` : newName
    if (next === k) return
    const content = v.root.files.get(k)
    if (content !== undefined) {
      v.root.files.delete(k)
      v.root.files.set(next, content)
    }
    if (v.root.dirs.has(k)) {
      v.root.dirs.delete(k)
      v.root.dirs.add(next)
    }
    const pre = k + '/'
    const npre = next + '/'
    for (const f of [...v.root.files.keys()]) {
      if (f.startsWith(pre)) {
        v.root.files.set(npre + f.slice(pre.length), v.root.files.get(f) as string)
        v.root.files.delete(f)
      }
    }
    for (const d of [...v.root.dirs]) {
      if (d.startsWith(pre)) {
        v.root.dirs.add(npre + d.slice(pre.length))
        v.root.dirs.delete(d)
      }
    }
    this.touch()
  }

  async copyDir(ref: DirRef, from: PathSeg, dstRootRef: DirRef, toParent: PathSeg, toName: string): Promise<void> {
    const src = this.view(ref)
    const srcKey = this.key(src, from || [])
    const dst = this.view(dstRootRef)
    const dstKey = join([...dst.prefix, ...(toParent || []), toName])
    const srcPre = srcKey ? srcKey + '/' : ''

    // 顺手把「复制的是一棵目录」这件事记进 dirs，空目录也能被列出来
    dst.root.dirs.add(dstKey)
    for (const [k, text] of src.root.files) {
      if (!k.startsWith(srcPre)) continue
      dst.root.files.set(dstKey + '/' + k.slice(srcPre.length), text)
    }
    for (const d of src.root.dirs) {
      if (!d.startsWith(srcPre)) continue
      dst.root.dirs.add(dstKey + '/' + d.slice(srcPre.length))
    }
    this.touch()
  }

  /* ---------------------------------------------------------- 沙盒专用 */

  /**
   * 导出全部文件（相对 ref 的路径）。
   * includeHidden=false 时跳过 `.snapshots`（和 FSA 宿主的 listDir 一致：
   * 快照不进备份包，作者要的是正文）。
   */
  dump(ref: DirRef, opts: { includeHidden?: boolean } = {}): Array<{ path: string; text: string }> {
    const v = this.view(ref)
    const pre = v.prefix.length ? join(v.prefix) + '/' : ''
    const out: Array<{ path: string; text: string }> = []
    for (const [k, text] of v.root.files) {
      if (pre && !k.startsWith(pre)) continue
      const rel = pre ? k.slice(pre.length) : k
      if (!rel) continue
      if (!opts.includeHidden && isHiddenKey(rel)) continue
      out.push({ path: rel, text })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
  }

  /** 只给测试和调试用：直接塞一个文件进去，不走 resize 之类的前置 */
  seed(ref: DirRef, path: string, text: string) {
    const v = this.view(ref)
    const k = join([...v.prefix, ...path.split('/')])
    v.root.files.set(k, text)
    this.touch()
  }

  /** 重置（测试之间隔离用） */
  resetAll() {
    this.roots.clear()
    this.touch()
  }
}

export const memAdapter = new MemAdapter()
