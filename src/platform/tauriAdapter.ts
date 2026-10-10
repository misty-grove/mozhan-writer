/**
 * 桌面端宿主适配（Tauri 2）
 *
 * 业务层只依赖 `FsAdapter`，所以装进桌面外壳后只换这一处实现，上层一行都不用改。
 * 对面是 `src-tauri/src/commands/fs.rs`，方法一一对应。
 *
 * # 两条必须守住的契约
 *
 * 1. **参数名**：Rust 用 snake_case 声明，前端传 camelCase（Tauri v2 自动转换）。
 *    所以 Rust 的 `new_name` ↔ 这里的 `newName`。改一边必须改另一边。
 * 2. **`DirRef.id` 是不透明句柄**：桌面端它就是绝对路径，但前端只负责**原样传回去**，
 *    不解析、不拼接。路径拼接与越界校验统一由 Rust 侧 `src-tauri/src/path.rs` 负责 ——
 *    那才是安全边界所在。
 */
import type { DirEntry, DirRef, FsAdapter, PathSeg } from './types'

declare global {
  interface Window {
    /** Tauri 运行时注入的标记。有它就说明跑在桌面外壳里。 */
    __TAURI_INTERNALS__?: unknown
    /** 只有开了 `withGlobalTauri` 才有。默认关着，认它是为了兼容这种配置。 */
    __TAURI__?: { core?: { invoke: (cmd: string, args?: any) => Promise<any> } }
  }
}

export function hasTauri(): boolean {
  return typeof window !== 'undefined' && (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)
}

/**
 * 调用一个原生命令。
 *
 * 用动态 import 而不是顶部静态 import：这样在浏览器里跑（以及 jsdom 冒烟测试）时，
 * `@tauri-apps/api` 根本不会被加载 —— 桌面端的能力不该给网页版带来任何负担。
 */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const injected = window.__TAURI__?.core?.invoke
  if (typeof injected === 'function') return injected(cmd, args) as Promise<T>
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args)
}

/**
 * 校验「一个目录名」能不能拿去拼路径。
 *
 * 为什么前端也要查一遍：`joinRef` 的返回值会被 Rust 当成**作品根目录**，
 * 而根目录是不做越界校验的（它本身就是边界）。所以一个 `..` 会直接指到上一层去。
 * Rust 侧的路径规则管不到根目录，这个口子只能在这里堵。
 */
function assertUsableName(name: string) {
  const bad = (why: string) => {
    throw new Error(`目录名不可用：${why}（${JSON.stringify(name)}）`)
  }
  if (!name) bad('名字为空')
  if (name === '.' || name === '..') bad('不能是 . 或 ..')
  if (/[\\/]/.test(name)) bad('不能包含路径分隔符')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) bad('不能包含控制字符')
  if (/[. ]$/.test(name)) bad('不能以点或空格结尾')
}

class TauriAdapter implements FsAdapter {
  readonly kind = 'tauri' as const
  readonly supportsPickDir = true

  async pickDir(title?: string): Promise<DirRef | null> {
    // 移动端没有这条命令（Rust 侧也是 cfg 掉的那条）。真被调到了就说明界面分支漏了，
    // 宁可报错也不要返回一个 null 让上层静默什么都不做。
    const host = await hostInfo()
    if (host.isMobile) throw new Error('移动端没有目录选择器，请从首页的作品库里打开作品')
    // Rust 侧返回的是 `{ id, name }`（id 就是绝对路径），用户点取消时是 null。
    // 早先这里把它当字符串用（`p.split(...)`）—— 在真机上会直接抛 "p.split is not a function"。
    const args: Record<string, unknown> = {}
    if (title !== undefined) args.title = title
    return (await invoke<DirRef | null>('fs_pick_dir', args)) ?? null
  }

  async checkPermission(ref: DirRef): Promise<'granted' | 'prompt' | 'denied'> {
    // 桌面端没有"授权"这回事（能选到就说明有权限），只需要回答"目录还在不在"。
    // 作品被挪走或删掉时返回 denied，上层就会把用户引回首页重选，
    // 而不是之后每次自动保存都弹一次错。
    try {
      const perm = await invoke<string>('fs_perm', { root: ref.id })
      return perm === 'granted' ? 'granted' : 'denied'
    } catch {
      return 'denied'
    }
  }

  requestPermission(): Promise<boolean> {
    // 桌面端不需要重新授权
    return Promise.resolve(true)
  }

  joinRef(parent: DirRef, name: string): DirRef {
    assertUsableName(name)
    const base = parent.id.replace(/[\\/]+$/, '')
    // 分隔符不能写死成 `\`：安卓上路径是 `/data/user/0/...`，
    // 拼出 `...\作品名` 之后 Rust 侧会把它当成一个文件名，作品就找不到了。
    // 认父路径自己用的那个分隔符 —— Windows 带 `\`，其它平台一律 `/`。
    const sep = parent.id.includes('\\') ? '\\' : '/'
    return { id: `${base}${sep}${name}`, name }
  }

  listDir(ref: DirRef, path: PathSeg): Promise<DirEntry[]> {
    return invoke<DirEntry[]>('fs_list_dir', { root: ref.id, path })
  }

  exists(ref: DirRef, path: PathSeg): Promise<boolean> {
    return invoke<boolean>('fs_exists', { root: ref.id, path })
  }

  readFile(ref: DirRef, path: PathSeg): Promise<string> {
    return invoke<string>('fs_read_file', { root: ref.id, path })
  }

  writeFile(ref: DirRef, path: PathSeg, content: string): Promise<void> {
    return invoke<void>('fs_write_file', { root: ref.id, path, content })
  }

  mkdir(ref: DirRef, path: PathSeg): Promise<void> {
    return invoke<void>('fs_mkdir', { root: ref.id, path })
  }

  remove(ref: DirRef, path: PathSeg): Promise<void> {
    return invoke<void>('fs_remove', { root: ref.id, path })
  }

  rename(ref: DirRef, path: PathSeg, newName: string): Promise<void> {
    return invoke<void>('fs_rename', { root: ref.id, path, newName })
  }

  copyDir(ref: DirRef, from: PathSeg, dstRootRef: DirRef, toParent: PathSeg, toName: string): Promise<void> {
    return invoke<void>('fs_copy_dir', {
      root: ref.id,
      from,
      dstRoot: dstRootRef.id,
      toParent,
      toName
    })
  }
}

export const tauriAdapter = new TauriAdapter()

/* ------------------------------------------------------------------ 宿主信息 */

/**
 * 前端对「我现在跑在什么上面」的唯一认知来源。
 *
 * 桌面端（Windows/macOS/Linux）作者自己挑文件夹，所以 `worksRoot` 是 null；
 * 安卓没有目录选择器（WebView 不给 `showDirectoryPicker`，Tauri 的 dialog 插件
 * 在移动端也不提供选文件夹），只能由应用给出自己的专属目录当**作品库**。
 */
export interface HostInfo {
  platform: 'android' | 'ios' | 'desktop'
  isMobile: boolean
  /** 作品库根目录（移动端才有） */
  worksRoot: string | null
  worksRootName: string | null
  /** 备份 zip 的落点（移动端才有）。桌面端作者自己挑文件夹，所以是 null */
  exportDir: string | null
  /** 导出后给作者看的一句说明 */
  exportHint: string | null
}

const DESKTOP_HOST: HostInfo = {
  platform: 'desktop',
  isMobile: false,
  worksRoot: null,
  worksRootName: null,
  exportDir: null,
  exportHint: null
}

/** 浏览器里假装自己是手机（?mobile=1）：调手机版界面、跑端到端断言用。
 *  作品库根目录是空的 —— 那种模式下本来也打不开真实目录，界面只负责长得对。 */
const MOCK_MOBILE_HOST: HostInfo = {
  platform: 'android',
  isMobile: true,
  worksRoot: null,
  worksRootName: null,
  exportDir: null,
  exportHint: null
}

/**
 * `?mobile=1`：在桌面浏览器上把界面切到手机版。
 * 用来调手机布局和跑端到端断言 —— 否则手机上长什么样只能靠想象。
 * 跟 platform/index.ts 里的 `?sandbox=1` 是一个路子。
 */
export function mobileForced(): boolean {
  if (typeof location === 'undefined') return false
  try {
    return new URLSearchParams(location.search).get('mobile') === '1'
  } catch {
    return false
  }
}

let hostCache: HostInfo | null = null

/** 问外壳要宿主信息。结果缓存下来，之后同步可读。 */
export async function hostInfo(): Promise<HostInfo> {
  if (hostCache) return hostCache
  if (!hasTauri()) {
    hostCache = mobileForced() ? MOCK_MOBILE_HOST : DESKTOP_HOST
    return hostCache
  }
  try {
    const r = await invoke<{
      platform: string
      isMobile: boolean
      worksRoot: string | null
      worksRootName: string | null
      exportDir: string | null
      exportHint: string | null
    }>('app_host_info')
    hostCache = {
      platform: r.isMobile ? (r.platform === 'ios' ? 'ios' : 'android') : 'desktop',
      isMobile: !!r.isMobile,
      worksRoot: r.worksRoot || null,
      worksRootName: r.worksRootName || null,
      exportDir: r.exportDir || null,
      exportHint: r.exportHint || null
    }
  } catch {
    // 老外壳还没这条命令：按桌面端处理，行为跟加这条命令之前完全一致
    hostCache = DESKTOP_HOST
  }
  return hostCache
}

/** 同步读缓存。还没问过外壳时返回 null（界面此时按桌面端渲染）。 */
export function peekHost(): HostInfo | null {
  return hostCache
}
