/**
 * 桌面版（Tauri / WebView2）真机验收。
 *
 * 前面四层验收（typecheck / selfcheck / smoke / e2e）覆盖的是**浏览器宿主**。
 * 桌面版换了一个宿主：文件操作从 File System Access API 换成了 IPC → Rust。
 * 这条链路上有四件事只有真窗口里才能证伪：
 *
 *   1. 应用在 WebView2 里到底起不起得来（CSP、协议、分包加载都和 Chrome 不一样）；
 *   2. IPC 的参数名/序列化对不对（snake_case ↔ camelCase 对不上是静默失败）；
 *   3. Rust 侧的路径校验在真实磁盘上同样生效（不能只靠单元测试）；
 *   4. 关窗守卫会不会**把关窗本身弄坏** —— 守卫写错就是"关不掉的应用"，
 *      这比丢稿还严重。
 *
 * 原生目录选择器自动化点不了，所以不去点它：`fs_*` 命令的 `root` 本来就是绝对路径，
 * 直接拿一个临时目录当作品根，把命令面整条打一遍。
 * 唯一没被覆盖的是 `fs_pick_dir` 自己（它只是 `blocking_pick_folder` 的包装）。
 *
 * 用法：
 *   node scripts/e2e/desktop.mjs                       # 自动找 release 产物
 *   node scripts/e2e/desktop.mjs <exe路径>             # 指定 exe
 *   DESKTOP_KEEP=1 node scripts/e2e/desktop.mjs        # 跑完不杀进程，留着看
 *
 * 两个环境变量（都是本机排障用的，正常构建不需要）：
 *   WEBVIEW2_USER_DATA_FOLDER  指定 WebView2 的用户数据目录（默认在工作临时目录下）
 *   DESKTOP_LAUNCH_TRIES       窗口起来几次没附着上就放弃，默认 3
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { attachBrowser, sleep } from './cdp.mjs'

const PROJECT = resolve(import.meta.dirname, '../..')
// 同 browser.mjs：落在工程内的 .e2e-shots，不用绝对路径（开源后 clone 即用）
const SHOTS = process.env.E2E_SHOTS || join(PROJECT, '.e2e-shots')
const PORT = Number(process.env.DESKTOP_PORT || 9444)
const TMP_BASE = process.env.TMP || process.env.TEMP || PROJECT
/* 故意用中文目录名：桌面端的路径处理最容易在非 ASCII 上翻车 */
const WORK_NAME = '桌面验收作品·中文目录'
const WORK = join(TMP_BASE, 'writer-desktop-e2e', WORK_NAME)
const CLOSE_WAIT_MS = 15000

/* ------------------------------------------------------------------ 断言小工具 */
let pass = 0
const failures = []
const warnings = []
const log = []

function ok(label, extra = '') {
  pass++
  log.push(`  ✓ ${label}${extra ? '  —— ' + extra : ''}`)
}
function bad(label, extra = '') {
  failures.push(`${label}${extra ? '  —— ' + extra : ''}`)
  log.push(`  ✗ ${label}${extra ? '  —— ' + extra : ''}`)
}
function check(cond, label, extra = '') {
  if (cond) ok(label, extra)
  else bad(label, extra)
  return !!cond
}
function section(title) {
  log.push(`\n[${title}]`)
  console.log(`\n[${title}]`)
}

/** Windows 绝对路径统一成反斜杠 —— Rust 两种都收，这里用反斜杠是为了走真实的 Windows 形态 */
const winPath = (p) => p.replace(/\//g, '\\')

/* ------------------------------------------------------------------ 找产物 */
function findExe() {
  if (process.argv[2]) return resolve(process.argv[2])
  const targetBase = process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR)
    : join(PROJECT, 'src-tauri', 'target')
  const candidates = [
    join(targetBase, 'release', 'mozhan.exe'),
    join(targetBase, 'debug', 'mozhan.exe')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

const EXE = findExe()
if (!EXE) {
  console.error('没找到桌面端可执行文件。先跑 `npm run desktop:build`，或把 exe 路径当参数传进来。')
  console.error('（找过：release / debug 两处，目标目录取自 CARGO_TARGET_DIR 或 src-tauri/target）')
  process.exit(1)
}
if (/[\\/]debug[\\/]/.test(EXE)) {
  warnings.push('跑的是 debug 产物（带控制台窗口），结论对 release 同样成立但性能数字不可比')
}

/* ------------------------------------------------------------------ 进程收尾小工具
 *
 * `child.kill()` 只收掉宿主进程，WebView2 那一串子进程会留下来。
 * 更要命的是**下一轮开头的 rmSync 会把这些进程正在用的用户数据目录删掉**，
 * 新的浏览器就起在一个残缺的 profile 上 —— 症状是「调试端口闪一下 about:blank 就退」
 * 或者「端口通了但页面永远不导航」。实测：连着跑一次比一次差，中间歇一会儿再跑又好，
 * 正是这个竞态。所以规矩是：**删 profile 之前先确认没有实例在跑，并给它时间真的退干净。**
 */
function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {}
}

/** 收掉上一次失败留下的宿主进程。
 *  只按我们自己的 exe 名收 —— `msedgewebview2.exe` 是全机共享的
 *  （系统小组件、Office 都在用），按名字杀会伤及无辜。 */
function sweepAppStragglers() {
  if (process.platform !== 'win32') return
  try {
    execFileSync('taskkill', ['/IM', 'mozhan.exe', '/F'], { stdio: 'ignore' })
  } catch {}
}

/* ------------------------------------------------------------------ 备好沙盒目录 */
sweepAppStragglers()
await sleep(2500)
rmSync(join(TMP_BASE, 'writer-desktop-e2e'), { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const DST_PARENT = join(TMP_BASE, 'writer-desktop-e2e', '另存为')
mkdirSync(DST_PARENT, { recursive: true })

const ROOT = winPath(WORK)
const DST = winPath(DST_PARENT)

/* WebView2 的用户数据目录：默认跟作品根目录待在一起，但允许单独指定。
 *
 * 为什么要留这个后门：WebView2 是**多进程**架构（UI 线程 + 若干渲染/GPU/网络子进程），
 * 子进程创建时会继承父进程的完整性级别与目录权限。实测在受限会话里，
 * 如果这个目录落在低完整性（Low Mandatory Level）的卷/目录树上，
 * 子进程起来后会在 10 秒左右静默消失 —— 调试端口跟着一起没了，
 * 表现成「等 桌面端调试端口 超时」，非常误导（看着像应用挂不起来，其实应用是好的）。
 * 参考 esbuild 那次（见工具链的 env 脚本）：同一个可执行文件换个目录就正常。
 */
const WV2_PROFILE = process.env.WEBVIEW2_USER_DATA_FOLDER || join(TMP_BASE, 'writer-desktop-e2e', 'webview2-profile')

console.log('='.repeat(60))
console.log('桌面版真机验收（Tauri / WebView2）')
console.log(`可执行文件：${EXE}`)
console.log(`作品根目录：${WORK}`)
console.log(`调试端口：  ${PORT}`)
console.log(`WV2 配置：  ${WV2_PROFILE}`)

/* ------------------------------------------------------------------ 起窗口 */
let child = null
let exited = false
let exitCode = null
let browser = null
let page = null

/**
 * 起窗口 → 附着 → 等页面挂上。这一段是**允许重试**的。
 *
 * 为什么要重试：本机上 WebView2 的浏览器进程偶发起不来 —— 有时调试端口只闪一下
 * `about:blank` 就退，有时端口通了但页面永远不导航，有时 `Page.enable` 直接超时。
 * 同一份产物、同一套参数，换一次启动就完全正常（探针反复证明应用本体是好的），
 * 所以这是宿主的启动不稳，不该记成「应用坏了」。
 *
 * 每次重试换一个全新的用户数据目录，并先把上一轮的进程树收干净，
 * 否则第二次会撞在第一次的残骸上。只有全部试完还起不来才算失败。
 */
const LAUNCH_TRIES = Number(process.env.DESKTOP_LAUNCH_TRIES || 3)

async function launchAndAttach() {
  let lastErr = null
  for (let attempt = 1; attempt <= LAUNCH_TRIES; attempt++) {
    if (attempt > 1) {
      console.log(`  · 第 ${attempt - 1} 次没起来（${lastErr?.message?.slice(0, 60)}），重试 ${attempt}/${LAUNCH_TRIES}…`)
      killTree(child?.pid)
      sweepAppStragglers()
      await sleep(1500)
    }
    exited = false
    exitCode = null
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        // WebView2 默认不开调试端口，必须显式告诉它
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        // 把 WebView2 的用户数据也隔离开，免得和真实使用的那份互相污染
        WEBVIEW2_USER_DATA_FOLDER: attempt === 1 ? WV2_PROFILE : `${WV2_PROFILE}-r${attempt}`
      },
      stdio: 'ignore',
      windowsHide: false
    })
    child.on('exit', (code) => {
      exited = true
      exitCode = code
    })
    child.on('error', (e) => {
      exited = true
      exitCode = `spawn 失败：${e.message}`
    })

    try {
      const attached = await attachBrowser({ port: PORT, match: /tauri\.localhost|index\.html/, timeoutMs: 60000 })
      browser = attached.browser
      page = attached.page

      // 附着到的是已经加载完的页面，Runtime.enable 不会重放之前的异常。
      // 主动刷一次，让「启动期」的报错也进到我们的监听里。
      await page.send('Page.reload', { ignoreCache: true })
      await page.waitFor('document.readyState === "complete"', { timeout: 30000, label: '页面重载完成' })
      await page.waitFor('document.querySelector("#app") && document.querySelector("#app").children.length > 0', {
        timeout: 30000,
        label: 'Vue 挂载'
      })
      await sleep(600)

      if (attempt > 1) {
        // 不藏着：重试成功也说明宿主启动不稳，报告里要看得见，
        // 否则「每次都要第二次才起来」会被当成正常。
        warnings.push(`WebView2 第 ${attempt} 次启动才成功 —— 宿主启动不稳（不是应用的问题，但值得留意）`)
      }
      ok('WebView2 调试端口连上了', `${attached.target.url}（第 ${attempt} 次启动）`)
      return
    } catch (e) {
      lastErr = e
      try {
        await browser?.close()
      } catch {}
      browser = null
      page = null
    }
  }
  throw lastErr
}

/** 把 Tauri 命令包一层，让「预期会失败」的调用也能拿到中文错误原文 */
async function call(cmd, args) {
  const payload = JSON.stringify({ cmd, args })
  return page.evaluate(`
    const { cmd, args } = ${payload}
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(cmd, args)
      return { ok: true, value }
    } catch (e) {
      return { ok: false, error: typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e) }
    }
  `)
}

/** 直接读磁盘，用来对照 Rust 到底写了什么（不信任 IPC 自己的回答） */
function disk(rel) {
  const p = join(WORK, rel)
  return existsSync(p) ? { exists: true, text: readFileSync(p, 'utf8') } : { exists: false }
}

try {
  /* ================================================================ 一、窗口起没起来 */
  section('一、窗口与 IPC 桥接')
  await launchAndAttach()

  const title = await page.evaluate('return document.title')
  check(title === '墨栈写作台 · 本地中文网文写作 AI 辅助', '窗口标题正确', title)

  const bridge = await page.evaluate(`
    const i = window.__TAURI_INTERNALS__
    return { has: !!i, invoke: typeof i?.invoke, transformCallback: typeof i?.transformCallback }
  `)
  check(bridge.has && bridge.invoke === 'function', 'Tauri IPC 桥在场', `invoke=${bridge.invoke}`)
  // withGlobalTauri: false 的意义就是**不**往 window 上挂这个
  const noGlobal = await page.evaluate('return typeof window.__TAURI__')
  check(noGlobal === 'undefined', 'withGlobalTauri=false 生效（window.__TAURI__ 不存在）', noGlobal)

  const bootText = (await page.text()) || ''
  check(bootText.length > 10, '首页渲染出内容（不是白屏）', `${bootText.length} 字符`)
  check(/作品|新建/.test(bootText), '首页有可识别入口文案', bootText.split('\n').filter(Boolean)[0] || '')

  await page.screenshot(join(SHOTS, 'desktop-01-首页.png')).catch(() => {})

  /* ================================================================ 二、Rust 命令面 */
  section('二、Rust 命令面（真实磁盘 + 真实 IPC）')

  const perm = await call('fs_perm', { root: ROOT })
  check(perm.ok && perm.value === 'granted', 'fs_perm 认得出存在的根目录', JSON.stringify(perm.value ?? perm.error))

  const mk = await call('fs_mkdir', { root: ROOT, path: ['设定'] })
  check(mk.ok && existsSync(join(WORK, '设定')), 'fs_mkdir 建目录落到盘上', mk.error || '')

  const mkHidden = await call('fs_mkdir', { root: ROOT, path: ['.snapshots'] })
  check(mkHidden.ok, 'fs_mkdir 能建隐藏目录（软件自己用）', mkHidden.error || '')

  const person = '---\ntype: 人物\ntags: [主角]\n---\n\n# 阿禾\n\n渡口长大的女孩，右手虎口有一道旧疤。\n'
  const w1 = await call('fs_write_file', { root: ROOT, path: ['设定', '人物·阿禾.md'], content: person })
  const d1 = disk(join('设定', '人物·阿禾.md'))
  check(w1.ok && d1.exists, 'fs_write_file 写进真实磁盘', w1.error || '')
  check(d1.text === person, '写进去的字节和给的一模一样（含 front matter）')

  const r1 = await call('fs_read_file', { root: ROOT, path: ['设定', '人物·阿禾.md'] })
  check(r1.ok && r1.value === person, 'fs_read_file 读回来一致', r1.error || '')

  // BOM：浏览器宿主的 Blob.text() 会自动去掉，桌面端必须对齐
  const bomContent = '\ufeff# 带 BOM 的文档\n'
  await call('fs_write_file', { root: ROOT, path: ['设定', '带bom.md'], content: bomContent })
  const rBom = await call('fs_read_file', { root: ROOT, path: ['设定', '带bom.md'] })
  check(rBom.ok && rBom.value === '# 带 BOM 的文档\n', '读文件时去掉 BOM，与浏览器宿主一致', JSON.stringify(rBom.value ?? rBom.error))

  const list = await call('fs_list_dir', { root: ROOT, path: [] })
  const names = list.ok ? list.value.map((e) => `${e.kind}:${e.name}`) : []
  check(list.ok && names.includes('dir:设定'), 'fs_list_dir 列出目录', names.join(' ') || list.error)
  check(list.ok && !names.some((n) => n.includes('.snapshots')), '隐藏目录（. 开头）不出现在列表里')

  const kindOk = list.ok && list.value.every((e) => e.kind === 'file' || e.kind === 'dir')
  check(kindOk, 'DirEntry.kind 只会是 file / dir（前端按这个分叉）', names.join(' '))

  const ex1 = await call('fs_exists', { root: ROOT, path: ['设定'] })
  const ex2 = await call('fs_exists', { root: ROOT, path: ['不存在的目录'] })
  check(ex1.value === true && ex2.value === false, 'fs_exists 分得清存在与不存在')

  /* --- AI 网络桥（桌面端唯一出网点，commands/ai.rs）---
     这里只测确定性路径（不依赖真实外网）：
     · 协议白名单在 Rust 侧拒绝，不产生任何网络流量；
     · 连接拒绝发生在 Rust 的 reqwest 里，WebView 的网络栈看不见，
       所以不会污染最后那条「没有失败的网络请求」检查。 */
  const badScheme = await call('ai_models', { url: 'ftp://example.com/v1/models', apiKey: 'x' })
  check(
    !badScheme.ok && /http/.test(String(badScheme.error)),
    'ai_models 拒绝非 http(s) 地址（协议白名单）',
    String(badScheme.error).slice(0, 60)
  )
  const dead = await page.evaluate(`
    try {
      // 手工构造一个 Tauri Channel（IPC 线上格式就是 "__CHANNEL__:<id>" 字符串），
      // 收到的每条事件记下来，供断言用
      const got = []
      const id = window.__TAURI_INTERNALS__.transformCallback((raw) => { got.push(raw) }, false)
      const value = await window.__TAURI_INTERNALS__.invoke('ai_chat', {
        url: 'http://127.0.0.1:9/v1/chat/completions',
        apiKey: 'x',
        body: '{}',
        onEvent: '__CHANNEL__:' + id
      })
      return { ok: true, value, events: got.length }
    } catch (e) {
      return { ok: false, error: typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e) }
    }
  `)
  check(
    !dead.ok && /网络请求失败/.test(String(dead.error)),
    'ai_chat 对连不上的地址给出中文错误（不静默）',
    String(dead.error).slice(0, 60)
  )

  /* --- 路径越界：桌面端没有 FSA 的句柄保护，这层必须在 Rust 里重新做一遍 --- */
  const escapes = [
    [['..', '逃逸.md'], '上跳一级'],
    [['..', '..', '逃逸.md'], '连上跳两级'],
    [['设定', '..', '..', '逃逸.md'], '中途折返'],
    [['C:', '逃逸.md'], '夹带盘符'],
    [['a/b', '逃逸.md'], '片段里带分隔符'],
    [['con.md'], 'Windows 保留名'],
    [['尾点.'], '结尾的句点'],
    [['尾空格 '], '结尾的空格']
  ]
  let escaped = 0
  for (const [path, label] of escapes) {
    const r = await call('fs_write_file', { root: ROOT, path, content: 'x' })
    if (r.ok) {
      escaped++
      bad(`越界写入被拒绝（${label}）`, '居然写成了！')
    } else ok(`越界写入被拒绝（${label}）`, String(r.error).slice(0, 40))
  }
  check(escaped === 0, '八种越界写法一条都没漏')
  check(!existsSync(join(TMP_BASE, 'writer-desktop-e2e', '逃逸.md')), '越界尝试没有在作品根目录外留下文件')

  const emptyRead = await call('fs_read_file', { root: ROOT, path: [] })
  check(!emptyRead.ok, 'fs_read_file 拒绝空路径（不能把目录当文件读）', String(emptyRead.error).slice(0, 40))

  const writeToDir = await call('fs_write_file', { root: ROOT, path: ['设定'], content: 'x' })
  check(!writeToDir.ok, 'fs_write_file 拒绝把目录当文件写', String(writeToDir.error).slice(0, 40))

  /* --- 原子写不能留残渣 --- */
  const residue = readdirSync(join(WORK, '设定')).filter((f) => f.endsWith('.wrtmp'))
  check(residue.length === 0, '原子写不留下 .wrtmp 临时文件', residue.join(' ') || '目录干净')

  /* --- 重命名 --- */
  const rn = await call('fs_rename', { root: ROOT, path: ['设定', '人物·阿禾.md'], newName: '阿禾.md' })
  check(rn.ok && existsSync(join(WORK, '设定', '阿禾.md')) && !existsSync(join(WORK, '设定', '人物·阿禾.md')), 'fs_rename 改名落到盘上', rn.error || '')
  const rnBad = await call('fs_rename', { root: ROOT, path: ['设定', '阿禾.md'], newName: '../跑出去.md' })
  check(!rnBad.ok, 'fs_rename 拒绝带分隔符的新名字', String(rnBad.error).slice(0, 40))

  /* --- 复制整库（另存为）：from 为空是合法用法 --- */
  const cp = await call('fs_copy_dir', { root: ROOT, from: [], dstRoot: DST, toParent: [], toName: '备份一份' })
  const cpOk = cp.ok && existsSync(join(DST_PARENT, '备份一份', '设定', '阿禾.md'))
  check(cpOk, 'fs_copy_dir 整库另存为（from=[]）且保留嵌套', cp.error || '')
  const cpSelf = await call('fs_copy_dir', { root: ROOT, from: [], dstRoot: ROOT, toParent: [], toName: '自己' })
  check(!cpSelf.ok, 'fs_copy_dir 拒绝复制到自己里面（否则无限递归）', String(cpSelf.error).slice(0, 40))

  /* --- 删除必须幂等 --- */
  const del1 = await call('fs_remove', { root: ROOT, path: ['设定', '带bom.md'] })
  const del2 = await call('fs_remove', { root: ROOT, path: ['设定', '带bom.md'] })
  check(del1.ok && del2.ok && !existsSync(join(WORK, '设定', '带bom.md')), 'fs_remove 幂等（删两次都算成功）', del2.error || '')
  const delRoot = await call('fs_remove', { root: ROOT, path: [] })
  check(!delRoot.ok && existsSync(WORK), 'fs_remove 拒绝删掉作品根目录自己', String(delRoot.error).slice(0, 40))

  /* --- 不存在的根：要报告「文件不存在」而不是「路径非法」 --- */
  const ghost = await call('fs_list_dir', { root: winPath(join(TMP_BASE, 'writer-desktop-e2e', '根本没有这个目录')), path: [] })
  check(!ghost.ok, '读不存在的目录会失败', String(ghost.error).slice(0, 60))
  check(!/非法|不允许|不能/.test(String(ghost.error)), '「不存在」没被误报成「路径非法」', String(ghost.error).slice(0, 60))

  await page.screenshot(join(SHOTS, 'desktop-02-命令面跑完.png')).catch(() => {})

  /* ================================================================ 三、关窗 */
  section('三、关窗守卫（不能把关窗本身弄坏）')

  // plugin:window|close 正是 getCurrentWindow().close() 发的那个命令，
  // 也就是 onCloseRequested 的回调来源。守卫如果在里面 await 卡住、或者忘了
  // destroy()，窗口就会关不掉 —— 那是比丢稿更严重的问题。
  //
  // 注意：窗口一关，这条 IPC 的回执就永远回不来了（ws 也断了）。
  // 所以**不 await 它**，只把 promise 留着，回执等不到是正常的。
  const closePromise = page
    .evaluate(`await window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }); return 'ack'`)
    .catch((e) => 'no-ack(' + String(e.message).slice(0, 30) + ')')

  const t0 = Date.now()
  while (!exited && Date.now() - t0 < CLOSE_WAIT_MS) await sleep(200)
  const closeSent = await Promise.race([closePromise, sleep(300).then(() => '窗口已关闭，没等到 IPC 回执')])
  log.push(`  · 关闭请求结果：${closeSent}`)

  check(exited, `关窗请求后进程自行退出（${CLOSE_WAIT_MS / 1000}s 内）`, `耗时 ${Date.now() - t0}ms`)
  if (exited && exitCode !== 0 && exitCode !== null) {
    warnings.push(`进程退出码是 ${exitCode}（正常关闭一般是 0）`)
  }

  /* ================================================================ 四、启动期报错 */
  section('四、启动期报错采集')
  const errs = page.consoleErrors.filter((e) => !/favicon/i.test(e))
  const pageErrs = page.pageErrors
  const failed = page.failedRequests
  check(errs.length === 0, '控制台没有 error', errs.slice(0, 3).join(' | '))
  check(pageErrs.length === 0, '没有未捕获的页面异常', pageErrs.slice(0, 3).join(' | '))
  check(failed.length === 0, '没有失败的网络请求', failed.slice(0, 3).join(' | '))
  if (page.consoleWarns.length) warnings.push(`${page.consoleWarns.length} 条控制台 warning（不阻断）：${page.consoleWarns.slice(0, 2).join(' | ')}`)
} catch (e) {
  bad('验收过程本身出错', e.message)
  console.log('\n' + (e.stack || e.message))
} finally {
  if (!process.env.DESKTOP_KEEP) {
    try {
      if (!exited) killTree(child?.pid)
    } catch {}
    try {
      await browser?.close()
    } catch {}
    if (!exited && !process.argv.includes('--keep')) await sleep(500)
  }
}

/* ------------------------------------------------------------------ 汇总 */
console.log('\n' + '='.repeat(60))
if (failures.length === 0) console.log(`桌面版验收：${pass} 项全部通过 ✅`)
else {
  console.log(`桌面版验收：通过 ${pass} 项，失败 ${failures.length} 项 ❌`)
  for (const f of failures) console.log('  ✗ ' + f)
}
if (warnings.length) console.log(`\n值得看一眼（不阻断）：\n` + warnings.map((w) => '  ! ' + w).join('\n'))
console.log(`截图目录：${SHOTS}`)

try {
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(
    join(SHOTS, 'desktop-report.txt'),
    [
      `时间：${new Date().toISOString()}`,
      `可执行文件：${EXE}`,
      `作品根目录：${WORK}`,
      `结果：通过 ${pass} 项，失败 ${failures.length} 项`,
      failures.length ? '\n失败项：\n' + failures.map((f) => '  - ' + f).join('\n') : '',
      warnings.length ? '\n提示：\n' + warnings.map((w) => '  - ' + w).join('\n') : '',
      '\n流程记录：\n' + log.join('\n')
    ].join('\n')
  )
  console.log(`报告：${join(SHOTS, 'desktop-report.txt')}`)
} catch {}

process.exit(failures.length === 0 ? 0 : 1)
