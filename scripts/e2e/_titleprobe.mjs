/**
 * 桌面真机探针（一次性验收）：稿纸顶部标题就地改 + 目录树同步 + 磁盘文件名同步。
 *
 * 背景：作者装的是修复前的旧包，报「上端还是不能直接修改」。浏览器 e2e 7.09b 已在
 * Chromium 里验过这条链路；本探针把同一套动作跑在**真实 WebView2 + 真实 Tauri IPC** 上，
 * 证明交付的桌面包里这条链路是通的。
 *
 * 做法（不碰作者任何真实数据）：
 *   1. 在 TEMP 下手搓一个最小探针作品（正文/第001章 归乡.md + 作品信息.md + 五个标准目录）；
 *   2. 起**全新 WebView2 profile** 的桌面 exe（调试端口附着）——不读不写作者的真实设置；
 *   3. 给页面预置 localStorage 最近作品指向探针作品 → reload → 应用自动进书
 *      （restoreLastWork 走 fs_perm + openWork，全程不开任何原生对话框）；
 *   4. 点稿纸标题 → 输入框就地出现 → 改名回车 → 断言稿纸标题 / 目录树 / 磁盘文件名三处同步。
 *
 * 纪律：绝不用 taskkill /IM 按镜像名全杀（作者可能正开着他自己的 mozhan.exe），
 * 只收自己 spawn 的进程树。
 *
 * 用法：node scripts/e2e/_titleprobe.mjs [exe路径]   （缺省取 CARGO_TARGET_DIR 或 src-tauri/target 的 release）
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { attachBrowser, sleep } from './cdp.mjs'

const PROJECT = resolve(import.meta.dirname, '../..')
const PORT = Number(process.env.PROBE_PORT || 9447)
const TMP = process.env.TMP || process.env.TEMP || PROJECT
const BASE = join(TMP, 'writer-title-probe')
const BOOK = join(BASE, '探针作品')
const PROFILE = join(BASE, 'wv2-profile')

function findExe() {
  if (process.argv[2]) return resolve(process.argv[2])
  const base = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(PROJECT, 'src-tauri', 'target')
  for (const c of [join(base, 'release', 'mozhan.exe'), join(base, 'debug', 'mozhan.exe')]) if (existsSync(c)) return c
  return null
}
const EXE = findExe()
if (!EXE) {
  console.error('找不到桌面 exe（传路径或设 CARGO_TARGET_DIR）')
  process.exit(1)
}

let pass = 0
const fails = []
function check(cond, label, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  —— ${extra}` : ''}`)
  } else {
    fails.push(label)
    console.log(`  ✗ ${label}${extra ? `  —— ${extra}` : ''}`)
  }
}

/* ---------------------------------------------------------------- 探针作品 */
rmSync(BASE, { recursive: true, force: true })
for (const d of ['正文', '大纲', '设定', '记忆', '技能']) mkdirSync(join(BOOK, d), { recursive: true })
writeFileSync(
  join(BOOK, '正文', '第001章 归乡.md'),
  '---\ntitle: 归乡\nstatus: 待写\nupdated: 2026-10-16 22:00:00\n---\n\n归乡的正文，探针用。\n'
)
writeFileSync(join(BOOK, '作品信息.md'), '---\ntitle: 探针作品\n---\n\n# 探针作品\n')

/* ---------------------------------------------------------------- 起窗口 */
console.log(`可执行：${EXE}`)
console.log(`探针作品：${BOOK}`)
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --no-sandbox`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE
  },
  stdio: 'ignore',
  windowsHide: false
})
function killChild() {
  try {
    if (child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
}
process.on('exit', killChild)

let page = null
try {
  const attached = await attachBrowser({ port: PORT, match: /tauri\.localhost|index\.html/, timeoutMs: 60000 })
  page = attached.page
  await page.waitFor('document.querySelector("#app") && document.querySelector("#app").children.length > 0', {
    timeout: 30000,
    label: 'Vue 挂载'
  })
  await sleep(500)

  // 预置最近作品（deepMerge，部分 JSON 安全）→ reload → 自动进书
  const bookWin = BOOK.replace(/\//g, '\\')
  await page.evaluate(`localStorage.setItem('writer.settings.v1', JSON.stringify({
    recent: [{ refId: ${JSON.stringify(bookWin)}, name: '探针作品', pathLabel: '探针作品', lastOpened: '2026-10-16 22:00:00', lastWordCount: 5 }],
    ui: { sidebarOpen: true }
  })); return true`)
  await page.send('Page.reload', { ignoreCache: true })
  await page.waitFor('document.readyState === "complete"', { timeout: 30000, label: '页面重载完成' })
  await page.waitFor('document.querySelector("#app") && document.querySelector("#app").children.length > 0', {
    timeout: 30000,
    label: 'Vue 重挂载'
  })

  console.log('\n[一、进书并拿到稿纸标题]')
  await page.waitFor("document.querySelector('.head-line .ch-title')", { timeout: 15000, label: '稿纸标题出现' })
  const t0 = await page.evaluate("return document.querySelector('.head-line .ch-title')?.textContent?.trim() || ''")
  check(t0 === '归乡', '自动进书并选中第一章', `当前标题：${t0}`)

  console.log('\n[二、点标题就地变输入框]')
  await sleep(300)
  await page.click('.head-line .ch-title')
  await sleep(400)
  check(
    await page.evaluate("return !!document.querySelector('.head-line .ch-title-input')"),
    '点击后原地出现输入框（不用跑去目录树）'
  )
  check(
    await page.evaluate("return document.activeElement?.classList?.contains('ch-title-input') && document.activeElement.value === '归乡'"),
    '输入框带着原名并自己拿到焦点',
    await page.evaluate("return (document.activeElement?.className || '') + ' / ' + (document.activeElement?.value || '')")
  )

  console.log('\n[三、改名回车 → 三处同步]')
  await page.evaluate("const i = document.querySelector('.head-line .ch-title-input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); return true")
  await page.typeText('归乡改过了')
  await page.pressKey('Enter')
  await page.waitFor(
    `return (document.querySelector('.head-line .ch-title')?.textContent?.trim() || '') === '归乡改过了'`,
    { timeout: 8000, label: '稿纸标题换成新名字' }
  ).catch(() => {})
  const t1 = await page.evaluate("return document.querySelector('.head-line .ch-title')?.textContent?.trim() || ''")
  check(t1 === '归乡改过了', '稿纸标题换成新名字', `${t0} → ${t1}`)

  await page.waitFor("document.querySelector('.tree-body .ch-title')", { timeout: 8000, label: '目录树出现' }).catch(() => {})
  const tree = await page.evaluate(
    "return Array.from(document.querySelectorAll('.tree-body .ch-title')).map((t) => t.textContent.trim())"
  )
  check(
    tree.includes('归乡改过了') && !tree.includes('归乡'),
    '左侧目录树名字同步换了',
    JSON.stringify(tree)
  )

  const files = readdirSync(join(BOOK, '正文'))
  check(
    files.includes('第001章 归乡改过了.md') && !files.includes('第001章 归乡.md'),
    '磁盘文件名同步换了（第001章 归乡改过了.md）',
    JSON.stringify(files)
  )
  const raw = readFileSync(join(BOOK, '正文', '第001章 归乡改过了.md'), 'utf8')
  check(raw.includes('title: 归乡改过了'), 'frontmatter 的 title 同步换了')
} catch (e) {
  fails.push('探针执行异常：' + (e?.message || e))
  console.error('探针执行异常：', e)
} finally {
  killChild()
}

console.log(`\n结果：${pass} 项通过，${fails.length} 项失败`)
for (const f of fails) console.log('  ✗ ' + f)
process.exit(fails.length ? 1 : 0)
