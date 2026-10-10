/**
 * 手机上才存在的几件事：软键盘高度、抽屉手势、系统返回键、系统栏图标配色。
 *
 * 放在 platform 层而不是组件里，是因为它们全都是「跟宿主打交道」的代码 ——
 * 桌面端一个都用不上，也不该被加载进核心层（core/ 要能在没有 window 的 Node 里跑）。
 *
 * `?mobile=1` 是给真机调试和端到端断言留的开关：在桌面 Chrome 上也能把界面切到手机版，
 * 否则「手机上长什么样」只能靠想象。跟 `?sandbox=1` 一个路子。
 */
import { ref } from 'vue'
import { hostInfo, mobileForced, type HostInfo } from './tauriAdapter'

/** 当前是不是手机环境。同步可读，给模板和样式判断用。 */
export const mobileEnv = ref(false)

/** 问清宿主，把 mobileEnv 填好，并返回它。App 启动时调一次。 */
export async function detectMobile(): Promise<boolean> {
  let host: HostInfo
  try {
    host = await hostInfo()
  } catch {
    host = { platform: 'desktop', isMobile: false, worksRoot: null, worksRootName: null, exportDir: null, exportHint: null }
  }
  mobileEnv.value = !!host.isMobile || mobileForced()
  return mobileEnv.value
}

/* ------------------------------------------------------------------ 软键盘 */

/**
 * 软键盘当前占掉的高度（px，0 = 没弹起）。
 *
 * 为什么不能只信 `visualViewport`：Tauri 在安卓上这个 API 有时不随键盘更新
 * （tauri#10631），而窗口本身在 `adjustResize` 下是一定会变矮的 —— 所以两个信号都看，
 * 取大的那个。manifest 里的 `android:windowSoftInputMode="adjustResize"` 是这套的前提。
 */
export const keyboardHeight = ref(0)
/** 低于这个高度的变化不算键盘：横竖屏切换、地址栏收放也会改窗口高度 */
const KB_MIN = 80

export function startKeyboardWatch(): () => void {
  if (typeof window === 'undefined') return () => {}
  let base = window.innerHeight
  const measure = () => {
    const vv = window.visualViewport
    const byViewport = vv ? window.innerHeight - vv.height - (vv.offsetTop || 0) : 0
    const byWindow = base - window.innerHeight
    const kb = Math.max(byViewport, byWindow)
    keyboardHeight.value = kb >= KB_MIN ? Math.round(kb) : 0
    // 没有键盘的时候才更新基线：否则键盘收起后基线被压低，下次就永远算不出键盘高度了
    if (keyboardHeight.value === 0) base = window.innerHeight
  }
  const vv = window.visualViewport
  vv?.addEventListener('resize', measure)
  vv?.addEventListener('scroll', measure)
  window.addEventListener('resize', measure)
  window.addEventListener('orientationchange', measure)
  return () => {
    vv?.removeEventListener('resize', measure)
    vv?.removeEventListener('scroll', measure)
    window.removeEventListener('resize', measure)
    window.removeEventListener('orientationchange', measure)
    keyboardHeight.value = 0
  }
}

/* ------------------------------------------------------------------ 抽屉手势 */

export interface DrawerSwipeOptions {
  /** 左抽屉（章节目录）当前是否开着 */
  leftOpen: () => boolean
  /** 右抽屉（资料面板）当前是否开着 */
  rightOpen: () => boolean
  openLeft: () => void
  openRight: () => void
  close: () => void
}

/** 只有从屏幕边缘起手的滑动才算抽屉手势，否则会和正文里的选字打架 */
const EDGE = 28
/** 判定为一次滑动的最小位移 */
const MIN_DX = 44

/**
 * 边缘滑动开合抽屉：左边缘右滑开目录，右边缘左滑开资料；抽屉开着时反向滑关掉。
 *
 * 竖滑不参与（|dx| 必须明显大于 |dy|），否则上下滚稿纸会误触发。
 */
export function attachDrawerSwipe(el: HTMLElement, opt: DrawerSwipeOptions): () => void {
  let x0 = 0
  let y0 = 0
  let armed = false

  const onStart = (e: TouchEvent) => {
    const t = e.touches[0]
    if (!t) return
    // 起点不在边缘 → 不参与（正文里选字、拖光标都要留给编辑器）
    armed = t.clientX <= EDGE || t.clientX >= window.innerWidth - EDGE
    x0 = t.clientX
    y0 = t.clientY
  }
  const onEnd = (e: TouchEvent) => {
    if (!armed) return
    armed = false
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - x0
    const dy = t.clientY - y0
    if (Math.abs(dx) < MIN_DX || Math.abs(dx) < Math.abs(dy) * 1.5) return
    if (dx > 0) {
      // 向右滑：左边缘开目录；右抽屉开着就关掉它
      if (opt.rightOpen()) opt.close()
      else if (x0 <= EDGE) opt.openLeft()
    } else {
      if (opt.leftOpen()) opt.close()
      else if (x0 >= window.innerWidth - EDGE) opt.openRight()
    }
  }
  // capture：祖先的捕获监听先于目标上的一切处理跑，谁也拦不住它。
  // touchcancel：起手点落在正文（contenteditable）里时，浏览器可能把这次触摸
  // 转成文字选择手势、只发 cancel 不发 end —— 边缘手势是明确的横向意图，
  // 照常结算；漏听它就是「从稿纸右缘划不出面板」。（稿纸没铺满全宽时这一带
  // 恰好是空 .main，所以这个坑是排版修好之后才暴露的。）
  const OPT = { passive: true, capture: true } as const
  el.addEventListener('touchstart', onStart, OPT)
  el.addEventListener('touchend', onEnd, OPT)
  el.addEventListener('touchcancel', onEnd, OPT)
  return () => {
    el.removeEventListener('touchstart', onStart, OPT)
    el.removeEventListener('touchend', onEnd, OPT)
    el.removeEventListener('touchcancel', onEnd, OPT)
  }
}

/* ------------------------------------------------------------------ 系统返回键 */

/**
 * 安卓的返回键（含手势返回）在 WebView 里就是 history back —— 只要栈里有记录，
 * Tauri 就会 `webView.goBack()` 而不是直接退出应用（见 WryActivity 的 OnBackPressedCallback）。
 *
 * 所以抽屉打开时往栈里压一条占位：返回键于是变成「关抽屉」，而不是「退出写作」。
 * 这也是各类 App 在安卓上的通行做法。
 */
let backClose: (() => void) | null = null

function onPop() {
  const cb = backClose
  if (!cb) return
  cb()
}

export function beginBackGuard(close: () => void) {
  if (backClose) return
  backClose = close
  history.pushState({ writerGuard: 1 }, '')
  window.addEventListener('popstate', onPop)
}

export function endBackGuard() {
  if (!backClose) return
  backClose = null
  window.removeEventListener('popstate', onPop)
  // 占位记录还在栈上 —— 说明是作者自己关的抽屉，得把它退掉，
  // 否则他下次按返回键会「什么都没发生」（那一下用在了消化这条记录上）。
  const st = history.state as { writerGuard?: number } | null
  if (st?.writerGuard) history.back()
}

/* ------------------------------------------------------------------ 系统栏配色 */

/**
 * 让状态栏/导航栏的图标颜色跟着应用主题走。
 *
 * 开了 edge-to-edge 之后系统栏是透明的，图标直接画在我们的顶栏上面。
 * 应用在白天也能切夜间主题（`values-night` 那份 XML 只跟着系统深浅色走），
 * 所以这件事只能由前端在换主题时说一句。桥是 MainActivity 里那个 `WriterBar`。
 */
export function syncSystemBar(darkBg: boolean) {
  if (typeof window === 'undefined') return
  const bridge = (window as unknown as { WriterBar?: { setDarkIcons?: (d: boolean) => void } }).WriterBar
  try {
    bridge?.setDarkIcons?.(!darkBg) // 深色背景 → 图标用浅色
  } catch {
    // 桌面端没有这座桥，静默跳过就行
  }
}
