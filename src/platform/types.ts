/**
 * 文件系统适配层 —— 抽象接口
 *
 * 设计要点（对应开发文档 5.1 / 十、风险与对策）：
 * - 上层业务代码只依赖本接口，不感知具体宿主；
 * - 浏览器宿主用 File System Access API 直接读写本机真实目录（离线、无服务端）；
 * - Tauri 宿主用 Rust fs 命令实现同一套接口，接入时替换 adapter 即可，业务零改动。
 *
 * 路径统一用「相对于作品根目录的片段数组」表示（如 ['正文','第001章.md']），
 * 避免 Windows 分隔符差异带来的问题。
 */

export type PathSeg = string[]

export interface DirRef {
  /** 不透明句柄 id（浏览器宿主为 IndexedDB 中的键；Tauri 宿主为绝对路径） */
  id: string
  name: string
}

export interface DirEntry {
  name: string
  kind: 'file' | 'dir'
}

export interface FsAdapter {
  /**
   * 宿主类型。
   * - `fsaccess`：浏览器直接读写本机真实目录
   * - `tauri`：桌面端 Rust fs
   * - `memory`：降级沙盒（Firefox / Safari），改动只在内存里，需手动导出
   */
  readonly kind: 'fsaccess' | 'tauri' | 'memory'
  /** 是否支持由用户直接选择目录 */
  readonly supportsPickDir: boolean

  /** 弹出目录选择器 */
  pickDir(title?: string): Promise<DirRef | null>

  /** 校验此前保存过的目录句柄是否仍可用（是否需要重新授权） */
  checkPermission(ref: DirRef): Promise<'granted' | 'prompt' | 'denied'>

  /** 向用户请求重新授权 */
  requestPermission(ref: DirRef): Promise<boolean>

  /** 由父 Ref 派生子目录 Ref（新建作品 / 打开子目录用） */
  joinRef(parent: DirRef, name: string): DirRef

  listDir(ref: DirRef, path: PathSeg): Promise<DirEntry[]>
  exists(ref: DirRef, path: PathSeg): Promise<boolean>
  readFile(ref: DirRef, path: PathSeg): Promise<string>
  writeFile(ref: DirRef, path: PathSeg, content: string): Promise<void>
  mkdir(ref: DirRef, path: PathSeg): Promise<void>
  remove(ref: DirRef, path: PathSeg): Promise<void>
  rename(ref: DirRef, path: PathSeg, newName: string): Promise<void>
  /** 复制整个目录树到目标父目录下（作品另存为 / 备份用） */
  copyDir(ref: DirRef, from: PathSeg, toParentRoot: DirRef, toParent: PathSeg, toName: string): Promise<void>
}

export function joinPath(p: PathSeg): string {
  return p.join('/')
}

/**
 * 宿主不往目录列举里暴露的名字 —— **三个宿主共用这一份名单**。
 *
 * 曾经这里写的是「凡是 `.` 开头就藏起来」，看着更利落，其实是错的：
 * 作品里有一个**正经内容目录**叫 `大纲/.mdAI文件/`（`core/context.ts` 要读它、
 * README 的数据模型里有它），点开头只是作者的排版习惯，不是"内部物"。
 * 一律按点前缀藏，后果是备份层 `collectFiles` 少收三个文件、
 * 资料面板里那个目录凭空消失 —— 而且是**静默**的。
 *
 * 所以改成显式名单 + 我们自己的临时文件后缀。改这张表之前先想清楚：
 * 藏掉的每一个名字，都是作者再也看不到、备份也带不走的内容。
 */
export const INTERNAL_NAMES: readonly string[] = ['.snapshots', '.git']

/** 写入中的临时文件后缀（Rust 的 `fsops::WRITE_TMP_SUFFIX` 必须与此一致） */
export const WRITE_TMP_SUFFIX = '.wrtmp'

export function isInternalName(name: string): boolean {
  return INTERNAL_NAMES.includes(name) || name.endsWith(WRITE_TMP_SUFFIX)
}
