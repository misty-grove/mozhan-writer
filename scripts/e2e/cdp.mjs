/**
 * 极简 CDP 驱动 —— 零依赖（用 Node 22 内置的 fetch / WebSocket）。
 *
 * 为什么不直接用 agent-browser：本机沙箱下 Chrome 必须带 --no-sandbox 才能启动，
 * 自己拉进程更好控制参数、时序与错误采集。
 *
 * 用法：
 *   const b = await launchChrome({ port: 9222 })
 *   const p = await b.newPage()
 *   await p.navigate(url)
 *   await p.evaluate('document.title')
 *   await b.close()
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as join2 } from 'node:path'

export const CHROME_CANDIDATES = [
  process.env.WRITER_CHROME,
  join2(process.env.USERPROFILE || '', '.agent-browser/browsers/chrome-155.0.8059.39/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c
  throw new Error('没找到 Chrome，可用环境变量 WRITER_CHROME 指定可执行文件路径')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待 HTTP 端点可用 */
async function waitHttp(url, timeoutMs, label) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
      last = `HTTP ${r.status}`
    } catch (e) {
      last = e.message
    }
    await sleep(200)
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）：${last}`)
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser
    this.sessionId = sessionId
    this.targetId = targetId
    this.consoleErrors = []
    this.consoleWarns = []
    this.pageErrors = []
    this.failedRequests = []
    this._handlers = new Map()
    /** 待应答的原生弹窗队列（prompt 的输入值；null 表示取消） */
    this.dialogQueue = []
    this.dialogs = []
    browser._pages.set(sessionId, this)
  }

  /** 排一个原生弹窗应答；下一次 prompt/confirm 会取走它 */
  answerDialog(value = '') {
    this.dialogQueue.push(value)
  }

  on(method, fn) {
    if (!this._handlers.has(method)) this._handlers.set(method, [])
    this._handlers.get(method).push(fn)
  }

  _dispatch(method, params) {
    for (const fn of this._handlers.get(method) || []) fn(params)
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId)
  }

  async enable() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Log.enable')
    await this.send('Network.enable')
    this.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ')
      if (p.type === 'error') this.consoleErrors.push(text)
      else if (p.type === 'warning') this.consoleWarns.push(text)
    })
    this.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {}
      this.pageErrors.push(d.exception?.description || d.text || '未知异常')
    })
    this.on('Log.entryAdded', (p) => {
      const e = p.entry || {}
      // 浏览器级的日志（比如 OPFS 操作失败）只有正文，没位置就没法查。
      // 把来源文件和前几帧调用栈带上，报告里才能直接指到出问题的代码。
      const short = (u) => String(u || '').split('/').pop()
      const where = e.url ? ` @ ${short(e.url)}:${(e.lineNumber || 0) + 1}` : ''
      const frames = (e.stackTrace?.callFrames || [])
        .slice(0, 3)
        .map((f) => `${f.functionName || '(anon)'}@${short(f.url)}:${f.lineNumber + 1}`)
      const text = String(e.text || '') + where + (frames.length ? ` [${frames.join(' <- ')}]` : '')
      if (e.level === 'error') this.consoleErrors.push(text)
      else if (e.level === 'warning') this.consoleWarns.push(text)
    })
    this.on('Network.loadingFailed', (p) => {
      // 只关心真实请求失败，忽略被主动取消的（如 HMR 断开）
      if (p.canceled) return
      this.failedRequests.push(`${p.type} ${p.errorText}`)
    })
    // 原生 prompt / confirm：默认自动接受，prompt 文本取队列里的值
    this.on('Page.javascriptDialogOpening', (p) => {
      this.dialogs.push(p.message)
      const has = this.dialogQueue.length > 0
      const value = has ? this.dialogQueue.shift() : ''
      this.send('Page.handleJavaScriptDialog', { accept: has || p.type !== 'prompt', promptText: value === null ? '' : String(value) }).catch(() => void 0)
    })
  }

  /** 注入到「每个新文档」执行前的脚本（刷新后依然生效） */
  async inject(source) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source })
  }

  async navigate(url, { waitMs = 1200 } = {}) {
    const done = new Promise((res) => {
      const off = (p) => {
        if (p.frame?.url && p.frame.url !== 'about:blank') res()
      }
      this.on('Page.loadEventFired', off)
    })
    await this.send('Page.navigate', { url })
    await Promise.race([done, sleep(8000)])
    await sleep(waitMs)
  }

  async reload(waitMs = 1500) {
    await this.send('Page.reload', { ignoreCache: false })
    await sleep(waitMs)
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  }

  async evaluate(expr, { awaitPromise = true, timeout = 20000 } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise,
      returnByValue: true,
      timeout
    })
    if (res.exceptionDetails) {
      throw new Error('页面内异常：' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text))
    }
    return res.result?.value
  }

  /** 等待页面内条件成立（表达式返回真值） */
  async waitFor(expr, { timeout = 8000, interval = 150, label = expr } = {}) {
    const t0 = Date.now()
    let last
    // 注意：DOM 节点无法按值序列化（会报 Object reference chain is too long），
    // 因此对象/元素统一折算成 true，只有原始值才原样返回。
    const probe = `const r = (${expr})
      return r === null || r === undefined || r === false ? r : typeof r === 'object' || typeof r === 'function' ? true : r`
    while (Date.now() - t0 < timeout) {
      try {
        last = await this.evaluate(probe)
        if (last) return last
      } catch (e) {
        last = e.message
      }
      await sleep(interval)
    }
    throw new Error(`等待条件超时：${label}（最后取值 ${JSON.stringify(last)}）`)
  }

  /** 真实键盘输入（走 Input 域，contenteditable 也收得到） */
  async typeText(text) {
    await this.send('Input.insertText', { text })
  }

  async pressKey(key, { ctrl = false, alt = false, shift = false } = {}) {
    const mods = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0)
    const codes = {
      Enter: { code: 'Enter', keyCode: 13, text: '\r' },
      Tab: { code: 'Tab', keyCode: 9 },
      Escape: { code: 'Escape', keyCode: 27 },
      Backspace: { code: 'Backspace', keyCode: 8 },
      Delete: { code: 'Delete', keyCode: 46 },
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 },
      ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      Home: { code: 'Home', keyCode: 36 },
      End: { code: 'End', keyCode: 35 },
      F2: { code: 'F2', keyCode: 113 },
      F11: { code: 'F11', keyCode: 122 },
      '?': { code: 'Slash', keyCode: 191, text: '?' },
      '.': { code: 'Period', keyCode: 190, text: '.' },
      '/': { code: 'Slash', keyCode: 191, text: ctrl || alt ? undefined : '/' },
      '=': { code: 'Equal', keyCode: 187, text: ctrl || alt ? undefined : '=' },
      '-': { code: 'Minus', keyCode: 189, text: ctrl || alt ? undefined : '-' }
    }
    const c = codes[key] || { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: ctrl || alt ? undefined : key }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mods, key, code: c.code, windowsVirtualKeyCode: c.keyCode, nativeVirtualKeyCode: c.keyCode, text: c.text })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key, code: c.code, windowsVirtualKeyCode: c.keyCode, nativeVirtualKeyCode: c.keyCode })
  }

  /** 在页面里查找并点击（用可见文本或选择器） */
  async click(selector, { index = 0 } = {}) {
    const ok = await this.evaluate(`
      const list = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
      const el = list[${index}]
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    `)
    if (!ok) throw new Error(`点不到元素：${selector}[${index}]`)
    await sleep(120)
  }

  async clickByText(selector, text) {
    const ok = await this.evaluate(`
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const el = els.find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)})
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    `)
    if (!ok) throw new Error(`点不到文本为「${text}」的 ${selector}`)
    await sleep(120)
  }

  /**
   * 按「文本包含」点击。
   * 用于按钮上带数量/后缀的场景（如「导出全部 11 个文件」）——
   * 这些数字是运行时算出来的，写不进断言里的精确文案。
   */
  async clickByTextLike(selector, text) {
    const ok = await this.evaluate(`
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const el = els.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}))
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    `)
    if (!ok) throw new Error(`点不到含「${text}」的 ${selector}`)
    await sleep(120)
  }

  /**
   * 往 <input type="file"> 里塞真实文件。
   * 文件选择框是原生弹窗、自动化点不了，但 CDP 的 DOM.setFileInputFiles
   * 走的就是浏览器自己的选文件通道 —— 页面上拿到的 File 对象与手选完全一致。
   */
  async setFileInput(selector, filePaths) {
    await this.send('DOM.enable')
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error(`找不到文件输入框：${selector}`)
    await this.send('DOM.setFileInputFiles', { nodeId, files: filePaths })
    await sleep(300)
  }

  /** 允许下载到指定目录（下载导出/备份产物时要先开这个） */
  async allowDownloads(dir) {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    await this.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true })
  }

  /** 等待某个文件出现在下载目录里（并稳定下来，避免读到半个文件） */
  async waitForDownload(dir, pattern, { timeout = 15000 } = {}) {
    const { readdirSync, statSync } = await import('node:fs')
    const t0 = Date.now()
    let lastSize = -1
    while (Date.now() - t0 < timeout) {
      const files = readdirSync(dir).filter((f) => pattern.test(f) && !f.endsWith('.crdownload'))
      if (files.length) {
        const p = join2(dir, files[files.length - 1])
        const size = statSync(p).size
        if (size > 0 && size === lastSize) return p
        lastSize = size
      }
      await sleep(250)
    }
    throw new Error(`等待下载超时：${dir} / ${pattern}`)
  }

  async screenshot(path) {    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(res.data, 'base64'))
    return path
  }

  text() {
    return this.evaluate('return document.body.innerText')
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId })
  }
}

class Browser {
  constructor(ws, proc, userDataDir) {
    this.ws = ws
    this.proc = proc
    this.userDataDir = userDataDir
    this._pages = new Map()
    this._id = 0
    this._pending = new Map()
  }

  send(method, params = {}, sessionId) {
    const id = ++this._id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 30000)
      this._pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })
  }

  _handle(msg) {
    if (msg.id && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`))
      else p.resolve(msg.result)
      return
    }
    if (msg.method) {
      const page = msg.sessionId ? this._pages.get(msg.sessionId) : null
      if (page) page._dispatch(msg.method, msg.params)
    }
  }

  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, sessionId, targetId)
    await page.enable()
    return page
  }

  async close() {
    try {
      this.ws.close()
    } catch {}
    try {
      this.proc?.kill()
    } catch {}
    await sleep(300)
    try {
      if (this.userDataDir) rmSync(this.userDataDir, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * 启动一个带调试端口的 Chrome。
 * 默认无头；本机沙箱下 Chrome 自带沙箱会拒绝访问自己的可执行文件，故必须 --no-sandbox。
 */
export async function launchChrome({ port = 9222, headless = true, extraArgs = [], keepProfile = false } = {}) {
  const exe = findChrome()
  const userDataDir = mkdtempSync(join2(tmpdir(), 'writer-e2e-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    // OverscrollHistoryNavigation：手机上验「边缘滑动开抽屉」时要关掉它。
    // 不关的话，从屏幕左边缘往右划会被浏览器**当成后退手势**，整页直接导航走
    // （表现为 location.href 变成 about:blank、页面里什么都测不到）。
    // 安卓 WebView 里返回手势归系统/Tauri 管，不存在这个浏览器级手势，所以关了更贴近真机。
    '--disable-features=Translate,MediaRouter,OverscrollHistoryNavigation,TouchpadOverscrollHistoryNavigation',
    '--no-sandbox'
  ]
  if (headless) args.push('--headless=new', '--disable-gpu')
  args.push(...extraArgs, 'about:blank')

  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
  const info = await waitHttp(`http://127.0.0.1:${port}/json/version`, 30000, 'Chrome 调试端口')

  const ws = new WebSocket(info.webSocketDebuggerUrl)
  const browser = new Browser(ws, proc, keepProfile ? null : userDataDir)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')))
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
    } catch {
      return
    }
    browser._handle(msg)
  })
  return browser
}

/**
 * 连到一个**已经在跑**的浏览器 —— 桌面版（Tauri / WebView2）走的就是这条路。
 *
 * 桌面窗口不是我们拉起来的，用不上 `launchChrome`；但只要它的调试端口开着，
 * 附着上去之后 Page 的能力完全一样（求值 / 截图 / 收控制台错误 / 真键鼠）。
 *
 * WebView2 默认不开调试端口，启动时要带：
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 *
 * `match` 用来在多个 target 里挑那个真正的页面（WebView2 会额外挂几个 worker /
 * devtools 目标，误attach到它们上会拿到一个空壳）。
 */
export async function attachBrowser({ port = 9222, match = null, timeoutMs = 30000 } = {}) {
  const version = await waitHttp(`http://127.0.0.1:${port}/json/version`, timeoutMs, '桌面端调试端口')

  // 调试端口比页面本身先就绪：端口一通就去 /json/list，拿到的往往是一个
  // `about:blank` 空壳（WebView2 会先建 target 再导航）。附着上去的话，
  // 后面 reload 出来的也是空白页 —— 表现为「Vue 挂在超时」这种极具误导性的错。
  // 所以必须轮询到**真正的页面**出现为止。
  const usable = (t) => t && t.type === 'page' && t.url && !t.url.startsWith('devtools://') && t.url !== 'about:blank'
  let page = null
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const list = await waitHttp(`http://127.0.0.1:${port}/json/list`, timeoutMs, '桌面端目标列表').catch(() => [])
    const targets = Array.isArray(list) ? list : []
    page = (match && targets.find((t) => usable(t) && match.test(t.url))) || targets.find(usable)
    if (page) break
    await sleep(200)
  }
  if (!page) {
    throw new Error(
      `等了 ${timeoutMs}ms 也没等到真正的页面目标（只见过 about:blank / devtools）。` +
        `应用可能启动失败了 —— 直接双击 exe 看看有没有弹错误框。`
    )
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl)
  const browser = new Browser(ws, null, null)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')))
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
    } catch {
      return
    }
    browser._handle(msg)
  })

  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.id, flatten: true })
  const p = new Page(browser, sessionId, page.id)
  await p.enable()
  // 附着到的是已经加载完的页面，Runtime.enable 之后不会重放之前的异常 —— 这一点
  // 和 launchChrome 不同，所以桌面验收里“启动期错误”要靠主动 reload 一次来兜。
  return { browser, page: p, target: page, version }
}

export { sleep }
