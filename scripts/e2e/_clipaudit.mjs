/**
 * 一次性审计：全界面「文字被裁 / 被挤」扫描。
 *
 * 起因：导入对话框的下拉框被写死 height:26px —— 13px 的字塞进 12px 的内容盒，
 * 上下各削掉 2.5px，「第X章」看着像「第x音」，用户报成「乱码」。
 * 一台机器上一个下拉框能这么干，别处也可能，所以在真 Chrome 里把每个视图、
 * 每个面板、每个弹窗都扫一遍，并把可疑处**高倍截图**，用像素判断而不是猜。
 *
 * 检测项：
 *   A 定高盒子里放不下的一行字（下拉框、输入框、单行按钮）
 *   B overflow:hidden/clip 的盒子，内容比盒子高
 *   C overflow:hidden/clip 的盒子，内容比盒子宽又没有省略号
 *   D 下拉框/输入框里的字比可显示宽度还宽（这类控件不会滚，直接切掉）
 *   E 不滚动的盒子里，内容比盒子宽（flex 压扁按钮会这样：字溢出到盒子外面）
 *
 * 用法：node scripts/e2e/_clipaudit.mjs
 */
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchChrome, sleep } from './cdp.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const WEB_PORT = Number(process.env.PROBE_PORT || 5315)
const URL = `http://127.0.0.1:${WEB_PORT}/`
const SHOTS = join(ROOT, '.e2e-shots')
const WORK = '裁剪审计作品'

mkdirSync(SHOTS, { recursive: true })

const SCAN = `
  const hits = []
  const NON_TEXT_INPUT = /^(checkbox|radio|range|color|file|image|submit|reset|hidden)$/i
  const tag = (el) => {
    const parts = []
    let cur = el
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      let s = cur.tagName.toLowerCase()
      if (cur.id) s += '#' + cur.id
      else if (typeof cur.className === 'string' && cur.className.trim()) s += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.')
      parts.unshift(s)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }
  const directText = (el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3 && n.nodeValue.trim())
    .map((n) => n.nodeValue.trim()).join(' ')
  // 控件上的字不在文本节点里：select 是 option、input 是 value/placeholder
  const controlText = (el) => {
    const t = el.tagName.toUpperCase()
    if (t === 'SELECT') return el.options[el.selectedIndex]?.text || ''
    if (t === 'INPUT') return el.value || el.getAttribute('placeholder') || ''
    if (t === 'TEXTAREA') return el.value || el.getAttribute('placeholder') || ''
    return ''
  }
  const needH = (s) => {
    const p = document.createElement('div')
    p.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;margin:0;padding:0;border:0;' +
      'font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';font-weight:' + s.fontWeight +
      ';line-height:' + s.lineHeight + ';letter-spacing:' + s.letterSpacing
    p.textContent = '汉字Xg'
    document.body.appendChild(p)
    const h = +p.getBoundingClientRect().height.toFixed(1)
    p.remove()
    return h
  }
  const textW = (s, t) => {
    const p = document.createElement('div')
    p.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;margin:0;padding:0;border:0;' +
      'font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';font-weight:' + s.fontWeight +
      ';line-height:' + s.lineHeight + ';letter-spacing:' + s.letterSpacing
    p.textContent = t
    document.body.appendChild(p)
    const w = +p.getBoundingClientRect().width.toFixed(1)
    p.remove()
    return w
  }
  const px = (v) => parseFloat(v) || 0
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const t = el.tagName.toUpperCase()
    const isForm = t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || t === 'BUTTON'
    if (t === 'INPUT' && NON_TEXT_INPUT.test(el.type || 'text')) continue
    const txt = t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' ? controlText(el) : directText(el)
    const oneLine = t === 'INPUT' || t === 'SELECT' ? true : s.whiteSpace === 'nowrap' || s.whiteSpace === 'pre'
    const contentH = r.height - px(s.paddingTop) - px(s.paddingBottom) - px(s.borderTopWidth) - px(s.borderBottomWidth)
    const contentW = r.width - px(s.paddingLeft) - px(s.paddingRight) - px(s.borderLeftWidth) - px(s.borderRightWidth)
    const rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    // A
    // display:inline 的元素没有「盒子」可言：它的 rect 就是字身框（12px 的字量出来 12px），
    // 行距是父级行盒给的，不会被它裁掉。拿它跟行高比必然误报（第一版就报了一串 code 标签）。
    if (oneLine && txt && t !== 'TEXTAREA' && s.display !== 'inline' && contentH + 0.5 < needH(s)) {
      hits.push({ kind: 'A-纵向裁字', el: tag(el), text: txt.slice(0, 26), contentH: +contentH.toFixed(1), need: needH(s), rect })
    }
    // D
    if ((t === 'SELECT' || t === 'INPUT') && txt) {
      const w = textW(s, txt)
      if (w > contentW + 1) hits.push({ kind: 'D-横向放不下', el: tag(el), text: txt.slice(0, 26), contentW: +contentW.toFixed(1), need: w, rect })
    }
    // B
    if ((s.overflowY === 'hidden' || s.overflowY === 'clip') && el.scrollHeight - el.clientHeight > 2) {
      hits.push({ kind: 'B-纵向溢出', el: tag(el), text: (txt || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 26), scrollH: el.scrollHeight, clientH: el.clientHeight, rect })
    }
    // C
    if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && s.textOverflow !== 'ellipsis' && el.scrollWidth - el.clientWidth > 2) {
      hits.push({ kind: 'C-横向切断', el: tag(el), text: (txt || '').replace(/\\s+/g, ' ').trim().slice(0, 26), scrollW: el.scrollWidth, clientW: el.clientWidth, rect })
    }
    // E：不滚动的盒子，内容比盒子宽（flex 把按钮压扁时，字会溢出到盒子外）
    if (s.overflowX === 'visible' && el.scrollWidth - el.clientWidth > 2) {
      hits.push({ kind: 'E-内容超宽', el: tag(el), text: (txt || '').replace(/\\s+/g, ' ').trim().slice(0, 26), scrollW: el.scrollWidth, clientW: el.clientWidth, rect })
    }
  }
  const seen = new Set()
  return hits.filter((h) => { const k = h.kind + h.el + h.text; if (seen.has(k)) return false; seen.add(k); return true })
`

/* ---------- 起服务 ---------- */
const server = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'pipe']
})
server.stderr.on('data', (d) => process.stderr.write(d))
const t0 = Date.now()
for (;;) {
  try {
    if ((await fetch(URL)).ok) break
  } catch {}
  if (Date.now() - t0 > 30000) throw new Error('预览服务器没起来')
  await sleep(300)
}

const browser = await launchChrome({ port: Number(process.env.PROBE_CDP || 9348) })
const report = []
let total = 0
let shotSeq = 0
try {
  const page = await browser.newPage()
  await page.setViewport(1440, 900)
  await page.inject('window.showDirectoryPicker = async () => await navigator.storage.getDirectory()')
  await page.navigate(URL, { waitMs: 1500 })
  await page.evaluate(`
    const r = await navigator.storage.getDirectory()
    const names = []; for await (const h of r.values()) names.push(h.name)
    for (const n of names) { try { await r.removeEntry(n, { recursive: true }) } catch (e) {} }
    localStorage.clear()
    return true
  `)
  await page.reload(1500)

  async function scan(where) {
    const state = await page.evaluate('return { len: (document.body.innerText || "").length, dialogs: document.querySelectorAll(".mask").length }')
    let hits = []
    try {
      hits = await page.evaluate(`const SCAN = () => { ${SCAN} }; return SCAN()`)
    } catch (e) {
      hits = [{ kind: '扫描失败', el: String(e.message || e) }]
    }
    total += hits.length
    report.push({ where, innerText: state.len, masks: state.dialogs, hits })
    console.log(`\n── ${where}  文字 ${state.len} 字 · 遮罩 ${state.dialogs} 个 · ${hits.length ? '★ ' + hits.length + ' 处' : '干净'}`)
    for (const h of hits) console.log('   ', JSON.stringify(h))
    for (const h of hits.slice(0, 6)) {
      if (!h.rect) continue
      const pad = 14
      const clip = { x: Math.max(0, h.rect.x - pad), y: Math.max(0, h.rect.y - pad), width: h.rect.w + pad * 2, height: h.rect.h + pad * 2, scale: 3 }
      try {
        const res = await page.send('Page.captureScreenshot', { format: 'png', clip })
        const f = join(SHOTS, `_clip-${++shotSeq}-${h.kind.slice(0, 1)}.png`)
        writeFileSync(f, Buffer.from(res.data, 'base64'))
        h.shot = f
        console.log('       ↳', f)
      } catch {}
    }
    return hits
  }

  /* ---------- 首页 ---------- */
  await scan('首页')

  /* ---------- 建作品 ---------- */
  await page.click('.actions button.primary')
  await page.waitFor("document.querySelector('.new-box')", { label: '新建作品表单' })
  await scan('新建作品表单')
  await page.evaluate("const i = document.querySelectorAll('.new-box input')[0]; i.focus(); i.select(); return true")
  await page.typeText(WORK)
  await page.click('.new-box .row button.primary')
  await page.waitFor("document.querySelector('.bar')", { timeout: 15000, label: '进入写作界面' })
  await page.evaluate("const i = document.querySelector('.blank-start .first-input'); i.focus(); i.select(); return true")
  await page.typeText('序章')
  await page.clickByText('.blank-start button', '新建第一章')
  await sleep(1200)
  await page.evaluate("document.querySelector('.ProseMirror').focus(); return true")
  await page.typeText('船上很静，只有水声。')
  await sleep(1500)

  /* ---------- 五个视图 ---------- */
  const VIEWS = [
    ['1', '写作视图', '.paper-col'],
    ['2', '看板视图', '.board'],
    ['3', '关系图视图', '.graph'],
    ['4', '时间线视图', '.tl'],
    ['5', '统计视图', '.stats']
  ]
  for (const [key, name, sel] of VIEWS) {
    await page.evaluate('document.body.focus(); return true')
    await page.pressKey(key, { ctrl: true })
    await sleep(650)
    if (!(await page.evaluate(`return !!document.querySelector(${JSON.stringify(sel)})`))) {
      console.log(`   （${name} 没切过去，跳过）`)
      continue
    }
    await scan(name)
  }
  await page.evaluate('document.body.focus(); return true')
  await page.pressKey('1', { ctrl: true })
  await sleep(400)

  /* ---------- 右侧面板 ---------- */
  const closeMask = async () => {
    await page.evaluate(`
      const head = document.querySelector('.dialog > .head')
      const b = (head && head.querySelector('.btn-icon')) ||
        Array.from(document.querySelectorAll('.mask button')).find((x) => /^(×|关闭)$/.test(x.textContent.trim()))
      if (b) b.click()
      else { const m = document.querySelector('.mask'); if (m) m.click() }
      return true
    `)
    await sleep(450)
    return await page.evaluate('return document.querySelectorAll(".mask").length')
  }

  await page.pressKey('j', { ctrl: true })
  await page.waitFor("document.querySelector('.dock')", { label: '右侧面板' })
  const tabs = await page.evaluate("return Array.from(document.querySelectorAll('.dock .tabs button')).map((b) => b.textContent.trim())")
  for (const t of tabs) {
    await page.clickByText('.dock .tabs button', t)
    await sleep(380)
    await scan('面板·' + t)
  }

  /* ---------- 各种弹窗（每次用完必须关掉，否则后面扫的是残留的它） ---------- */
  const DIALOGS = [
    ['顶栏·大纲', async () => page.clickByText('.bar button', '大纲')],
    ['顶栏·导入稿件', async () => page.clickByText('.right button', '导入稿件')],
    ['顶栏·导入大纲', async () => page.clickByText('.right button', '导入大纲')],
    ['顶栏·导出', async () => page.clickByText('.right button', '导出')],
    ['顶栏·快照', async () => page.clickByText('.right button', '快照')],
    ['顶栏·设置', async () => page.clickByText('.right button', '设置')],
    ['快捷键一览', async () => {
      await page.evaluate('document.body.focus(); return true')
      await page.pressKey('/', { ctrl: true })
    }]
  ]
  for (const [name, open] of DIALOGS) {
    try {
      await open()
      await sleep(900)
      const left = await page.evaluate('return document.querySelectorAll(".mask").length')
      if (!left) {
        console.log(`   （${name} 没弹出遮罩，跳过）`)
        continue
      }
      await scan(name)
      let remain = await closeMask()
      if (remain) {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await sleep(400)
        remain = await page.evaluate('return document.querySelectorAll(".mask").length')
      }
      if (remain) console.log(`   ⚠ ${name} 关不掉，还剩 ${remain} 个遮罩`)
    } catch (e) {
      console.log(`   （${name} 出错：${e.message}）`)
    }
  }

  /* ---------- 手机 390×844 ----------
     必须带 ?mobile=1：这个软件是按**宿主**判手机的（不看宽度），
     只把视口压到 390 得到的是「桌面布局塞进窄窗口」，不是作者手机上那一套。 */
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await page.navigate(URL + '?mobile=1', { waitMs: 2600 })
  await sleep(1500)
  const mob = await page.evaluate("return { ua: document.documentElement.classList.contains('ua-mobile'), len: (document.body.innerText || '').length }")
  console.log(`   （手机形态：ua-mobile=${mob.ua} · 文字 ${mob.len} 字）`)
  if (mob.len < 120) {
    console.log('   ⚠ 手机形态下没恢复出作品（文字太少），这一轮手机部分不算数 —— 手机布局另有 e2e §7.12/§7.14 覆盖')
  } else {
    await scan('手机·写作')
    const mobileTabs = await page.evaluate("return Array.from(document.querySelectorAll('.dock .tabs button, .drawer .tabs button')).map((b) => b.textContent.trim())")
    for (const t of mobileTabs.slice(0, 12)) {
      await page.clickByText('.drawer .tabs button', t)
      await sleep(320)
      await scan('手机·面板 ' + t)
    }
  }
  await page.screenshot(join(SHOTS, '_clip-mobile.png'))
  await page.evaluate('document.body.focus(); return true')

  console.log(`\n===== 合计 ${total} 处 =====`)
} catch (e) {
  console.error('审计失败：', e?.message || e)
} finally {
  const out = join(SHOTS, '_clip-audit.json')
  writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('明细：', out)
  await browser.close?.().catch?.(() => {})
  server.kill()
  await sleep(300)
}
process.exit(0)
