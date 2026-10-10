/**
 * 内存文件系统：给自检脚本与面板冒烟测试共用的宿主实现。
 * 完全离线，不碰真实磁盘。
 */
import { setAdapter, type DirEntry, type DirRef, type FsAdapter, type PathSeg } from '@/platform'

type Node = { kind: 'dir' | 'file'; name: string; content?: string; children?: Map<string, Node> }

export interface MemoryHost {
  adapter: FsAdapter
  roots: Map<string, Node>
  /** 重置一个空的作品根 */
  rootRef(): DirRef
}

function newNode(name: string, kind: 'dir' | 'file'): Node {
  return kind === 'dir' ? { kind, name, children: new Map() } : { kind, name, content: '' }
}

export function createMemoryHost(): MemoryHost {
  const roots = new Map<string, Node>()

  function resolve(ref: DirRef): Node {
    const parts = ref.id.split('::')
    const root = roots.get(parts[0])
    if (!root) throw new Error('root not found ' + parts[0])
    let cur = root
    for (const seg of parts.slice(1)) {
      const next = cur.children!.get(seg)
      if (!next) throw new Error('not found ' + ref.id)
      cur = next
    }
    return cur
  }

  function ensure(ref: DirRef, path: PathSeg, create: boolean): Node {
    let cur = resolve(ref)
    for (let i = 0; i < path.length; i++) {
      const isLast = i === path.length - 1
      let next = cur.children!.get(path[i])
      if (!next) {
        if (!create) throw new Error('missing ' + path[i])
        next = newNode(path[i], isLast ? 'file' : 'dir')
        cur.children!.set(path[i], next)
      } else if (!isLast && next.kind === 'file') {
        // 中间层被标成文件时升级为目录（先写深路径再列父目录的情况）
        next.kind = 'dir'
        next.children = next.children || new Map()
      }
      cur = next
    }
    return cur
  }

  const adapter: FsAdapter = {
    kind: 'tauri',
    supportsPickDir: true,
    async pickDir() {
      return { id: 'root', name: 'root' }
    },
    checkPermission: async () => 'granted',
    requestPermission: async () => true,
    joinRef(parent, name) {
      return { id: `${parent.id}::${name}`, name }
    },
    async listDir(ref, path) {
      const n = ensure(ref, path, true)
      return [...n.children!.values()].filter((c) => c.name !== '.snapshots').map<DirEntry>((c) => ({ name: c.name, kind: c.kind }))
    },
    async exists(ref, path) {
      try {
        ensure(ref, path, false)
        return true
      } catch {
        return false
      }
    },
    async readFile(ref, path) {
      return ensure(ref, path, false).content || ''
    },
    async writeFile(ref, path, content) {
      const n = ensure(ref, path, true)
      n.kind = 'file'
      n.content = content
    },
    async mkdir(ref, path) {
      ensure(ref, path, true)
    },
    async remove(ref, path) {
      const parent = ensure(ref, path.slice(0, -1), false)
      parent.children!.delete(path[path.length - 1])
    },
    async rename(ref, path, newName) {
      const parent = ensure(ref, path.slice(0, -1), false)
      const n = parent.children!.get(path[path.length - 1])!
      parent.children!.delete(path[path.length - 1])
      n.name = newName
      parent.children!.set(newName, n)
    },
    async copyDir(ref, from, dstRootRef, toParent, toName) {
      const src = ensure(ref, from, false)
      const parent = ensure(dstRootRef, toParent, true)
      const clone = (n: Node): Node => (n.kind === 'file' ? { ...n } : { ...n, children: new Map([...n.children!].map(([k, v]) => [k, clone(v)])) })
      const copy = clone(src)
      copy.name = toName
      parent.children!.set(toName, copy)
    }
  }

  function rootRef(): DirRef {
    if (!roots.has('root')) roots.set('root', newNode('root', 'dir'))
    return { id: 'root', name: 'root' }
  }

  return { adapter, roots, rootRef }
}

/** 建好 host 并把它设成当前宿主 */
export function installMemoryFs(): MemoryHost {
  const host = createMemoryHost()
  setAdapter(host.adapter)
  return host
}
