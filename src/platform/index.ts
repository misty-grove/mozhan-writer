import type { FsAdapter } from './types'
import { fsAccessAdapter } from './fsAccessAdapter'
import { tauriAdapter, hasTauri, hostInfo, peekHost, mobileForced } from './tauriAdapter'
import { memAdapter } from './memAdapter'
import {
  attachDrawerSwipe,
  beginBackGuard,
  detectMobile,
  endBackGuard,
  keyboardHeight,
  mobileEnv,
  startKeyboardWatch,
  syncSystemBar,
  type DrawerSwipeOptions
} from './mobile'

let adapter: FsAdapter = hasTauri() ? tauriAdapter : fsAccessAdapter

export function fs(): FsAdapter {
  return adapter
}

export function setAdapter(a: FsAdapter) {
  adapter = a
}

/** 这台浏览器能不能直接读写本机目录（FSA / 桌面端） */
export function fsaAvailable(): boolean {
  return hasTauri() || fsAccessAdapter.supportsPickDir
}

/**
 * 强制降级（`?sandbox=1`）。
 * 用途：在 Chrome 上调降级模式的界面与流程 —— 否则「Firefox 上什么样」只能靠想象。
 * 真实浏览器验收也走这个开关。
 */
export function sandboxForced(): boolean {
  if (typeof location === 'undefined') return false
  try {
    return new URLSearchParams(location.search).get('sandbox') === '1'
  } catch {
    return false
  }
}

/** 是否应当走降级沙盒：要么浏览器不支持，要么被显式要求 */
export function degradedMode(): boolean {
  return sandboxForced() || !fsaAvailable()
}

export function browserSupported(): boolean {
  return !degradedMode()
}

export { memAdapter, hasTauri, hostInfo, peekHost, mobileForced }
/* 手机端专用：软键盘、抽屉手势、返回键、系统栏配色 */
export {
  attachDrawerSwipe,
  beginBackGuard,
  detectMobile,
  endBackGuard,
  keyboardHeight,
  mobileEnv,
  startKeyboardWatch,
  syncSystemBar
}
export type { DrawerSwipeOptions } from './mobile'
export type { HostInfo } from './tauriAdapter'

export default fs

export type { DirEntry, DirRef, FsAdapter, PathSeg } from './types'
