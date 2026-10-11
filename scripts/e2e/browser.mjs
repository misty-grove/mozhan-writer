/**
 * 真实浏览器端到端验收（P3-A）
 *
 * 之前所有验证都跑在 jsdom 里，最担心的三件事——File System Access API 授权、
 * 刷新后目录句柄能否恢复、编辑器与各面板真实渲染——从来没在真浏览器里验过。
 *
 * 这里用真实 Chrome 走一遍完整用户流程：
 *   新建作品 → 建章 → 写作 → 自动保存 → 读盘校验 → 刷新恢复 → 五个视图 → 九个面板 → 采集报错
 *
 * File System Access API 怎么在无头环境里测：
 *   目录选择器是原生弹窗、自动化点不了，于是注入 showDirectoryPicker()
 *   让它直接返回 OPFS（navigator.storage.getDirectory()）的句柄。
 *   OPFS 返回的是**货真价实的 FileSystemDirectoryHandle**，
 *   因此 fsAccessAdapter 里 getDirectoryHandle / createWritable / values() /
 *   removeEntry / 句柄存 IndexedDB 这些代码路径全部是真实执行的，没有被替换掉。
 *
 * 用法：
 *   node scripts/e2e/browser.mjs                 # 需先起好 dev/preview 服务器
 *   E2E_URL=http://127.0.0.1:5199/ node scripts/e2e/browser.mjs
 */
import { launchChrome, sleep } from './cdp.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dirname, '../..')
const URL = process.env.E2E_URL || 'http://127.0.0.1:5199/'
// 截图落在工程内的 .e2e-shots（已 gitignore），跟着仓库走。
// 早先写的是一个硬编码绝对路径，别人 clone 下来必挂，已改成工程内相对路径。
const SHOTS = process.env.E2E_SHOTS || join(ROOT, '.e2e-shots')
const PORT = Number(process.env.E2E_PORT || 9333)
const WORK = '端到端验收作品'
const CH_TITLE = '启程'
const BODY_LINES = ['船靠岸的时候，雨还没停。', '他站在跳板上，闻到了故乡的煤烟味。']
/** 降级沙盒那一段用的一组常量 */
const SBX_WORK = '沙盒验收作品'
const SBX_LINE = '这一行是沙盒里写的，磁盘上还没有。'

/* ------------------------------------------------------------------ 导入用样例稿件 */
const FIXTURES = join(SHOTS, 'fixtures')

/** 手工拼 GBK 字节：Node 不自带 GBK 编码器，而这些字的码位是确定的 */
const GBK_MAP = {
  第: [0xb5, 0xda],
  一: [0xd2, 0xbb],
  二: [0xb6, 0xfe],
  章: [0xd5, 0xc2],
  归: [0xb9, 0xe9],
  乡: [0xcf, 0xe7],
  旧: [0xbe, 0xc9],
  人: [0xc8, 0xcb],
  启: [0xc6, 0xf4],
  程: [0xb3, 0xcc],
  重: [0xd6, 0xd8],
  逢: [0xb7, 0xea],
  船: [0xb4, 0xac],
  靠: [0xbf, 0xbf],
  岸: [0xb0, 0xb6],
  了: [0xc1, 0xcb],
  '。': [0xa1, 0xa3],
  她: [0xcb, 0xfd],
  没: [0xc3, 0xbb],
  回: [0xbb, 0xd8],
  头: [0xcd, 0xb7],
   ' ': [0x20],
  '\n': [0x0a]
}

function gbkBytes(text) {
  const out = []
  for (const ch of text) {
    const b = GBK_MAP[ch]
    if (!b) throw new Error(`GBK 样例里出现了没登记的字符：${ch}`)
    out.push(...b)
  }
  return Buffer.from(out)
}

function writeFixtures() {
  mkdirSync(FIXTURES, { recursive: true })
  const utf8 = ['第一章 启程', '', '船靠岸的时候，雨还没停。', '', '第二章 重逢', '', '他站在跳板上，闻到了故乡的煤烟味。', ''].join('\n')
  writeFileSync(join(FIXTURES, 'utf8.txt'), utf8, 'utf8')
  writeFileSync(join(FIXTURES, 'gbk.txt'), gbkBytes('第一章 启程\n\n船靠岸了。\n\n第二章 重逢\n\n她没回头。\n'))
  return { utf8: join(FIXTURES, 'utf8.txt'), gbk: join(FIXTURES, 'gbk.txt') }
}

/* ------------------------------------------------------------------ 断言 */
let pass = 0
const failures = []
const warnings = []
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(extra ? `${name} — ${extra}` : name)
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}
function section(t) {
  console.log(`\n── ${t}`)
}

/* ------------------------------------------------------------------ 注入脚本 */
const INIT = `
(() => {
  // 目录选择器直接给 OPFS 根句柄：真实 FileSystemDirectoryHandle，不做任何假实现
  window.showDirectoryPicker = async () => await navigator.storage.getDirectory()

  window.__fs = {
    async root() { return await navigator.storage.getDirectory() },
    async dir(path, create) {
      let cur = await this.root()
      for (const s of String(path || '').split('/').filter(Boolean)) cur = await cur.getDirectoryHandle(s, { create: !!create })
      return cur
    },
    async read(path) {
      const segs = String(path).split('/').filter(Boolean)
      const d = await this.dir(segs.slice(0, -1).join('/'))
      const fh = await d.getFileHandle(segs[segs.length - 1])
      return await (await fh.getFile()).text()
    },
    async list(path) {
      const d = await this.dir(path)
      const out = []
      for await (const h of d.values()) out.push(h.name + (h.kind === 'directory' ? '/' : ''))
      return out.sort()
    },
    async walk(path, out) {
      out = out || []
      const d = await this.dir(path)
      for await (const h of d.values()) {
        const p = (path ? path + '/' : '') + h.name
        if (h.kind === 'directory') await this.walk(p, out)
        else out.push(p)
      }
      return out.sort()
    },
    async wipe() {
      const r = await this.root()
      const names = []
      for await (const h of r.values()) names.push(h.name)
      for (const n of names) { try { await r.removeEntry(n, { recursive: true }) } catch (e) {} }
    }
  }
})()
`

/* ------------------------------------------------------------------ 主流程 */
const shot = (p, name) => p.screenshot(join(SHOTS, name))
mkdirSync(SHOTS, { recursive: true })

const browser = await launchChrome({ port: PORT })
let page
const log = []
function note(s) {
  log.push(s)
  console.log(s)
}

try {
  page = await browser.newPage()
  await page.setViewport(1440, 900)
  await page.inject(INIT)

  /* ---------- 0. 干净起点 ---------- */
  section('0. 打开首页（真实 Chrome）')
  await page.navigate(URL, { waitMs: 1500 })
  check('页面加载且标题正确', (await page.evaluate('return document.title')).includes('写作'), await page.evaluate('return document.title'))

  await page.evaluate(`
    await window.__fs.wipe()
    localStorage.clear()
    await new Promise((r) => { const q = indexedDB.deleteDatabase('writer-fs'); q.onsuccess = q.onerror = q.onblocked = () => r() })
    return true
  `)
  await page.reload(1800)

  const homeText = await page.text()
  check('首页渲染（墨栈写作台 / 新建作品）', homeText.includes('墨栈写作台') && homeText.includes('新建作品'))
  check('浏览器被识别为支持 FSA（无「请用 Edge / Chrome」警告）', !homeText.includes('请用 Edge'))
  await shot(page, '01-home.png')

  /* ---------- 1. 新建作品 ---------- */
  section('1. 新建作品（走真实 showDirectoryPicker → OPFS 句柄）')
  await page.click('.actions button.primary')
  await page.waitFor("document.querySelector('.new-box')", { label: '新建作品表单' })

  await page.evaluate("const i = document.querySelectorAll('.new-box input')[0]; i.focus(); i.select(); return true")
  await page.typeText(WORK)
  const nameVal = await page.evaluate("return document.querySelectorAll('.new-box input')[0].value")
  check('书名输入框接受真实键盘输入', nameVal === WORK, `实际「${nameVal}」`)

  await page.evaluate("const i = document.querySelectorAll('.new-box input')[1]; i.focus(); i.select(); return true")
  await page.typeText('验收员')

  await page.click('.new-box .row button.primary')
  await page.waitFor("document.querySelector('.bar')", { timeout: 15000, label: '进入写作界面' })
  check('进入写作界面（顶栏出现）', true)

  const rootDirs = await page.evaluate(`return await window.__fs.list(${JSON.stringify(WORK)})`)
  const wantDirs = ['大纲/', '正文/', '记忆/', '设定/', '技能/']
  check('标准目录已落盘', wantDirs.every((d) => rootDirs.includes(d)), JSON.stringify(rootDirs))
  const infoMd = await page.evaluate(`return await window.__fs.read(${JSON.stringify(WORK + '/作品信息.md')})`)
  check('作品信息.md 写入书名', infoMd.includes(WORK))
  check('作品信息.md 写入作者', infoMd.includes('验收员'))
  await shot(page, '02-new-work.png')

  /* ---------- 2. 建章 ---------- */
  section('2. 建章：新作品给得出可见入口')
  // 这条是真实浏览器里才发现的问题：章节树默认收起，新作品一片空白
  const treeVisible = await page.evaluate("return !!document.querySelector('.tree-body')")
  check('新作品自动展开章节树（不再是一片空白）', treeVisible)
  const blankVisible = await page.evaluate("return !!document.querySelector('.blank-start')")
  check('编辑器给出「新建第一章」起步入口', blankVisible)

  await page.evaluate("const i = document.querySelector('.blank-start .first-input'); i.focus(); return true")
  await page.typeText(CH_TITLE)
  await page.clickByText('.blank-start button', '新建第一章')
  await page.waitFor("document.querySelectorAll('.tree-body .ch').length === 1", { timeout: 10000, label: '章节出现在树上（1 章）' })
  const chCount = await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")
  check('章节出现在章节目录里', chCount === 1, `章节数 ${chCount}`)
  const chTitle = await page.evaluate("return document.querySelector('.tree-body .ch-title')?.textContent || ''")
  check('章节标题取自起步输入框', chTitle === CH_TITLE, `实际「${chTitle}」`)
  check('起步入口在建成后自动收起', !(await page.evaluate("return !!document.querySelector('.blank-start')")))

  /* ---------- 3. 写作 + 自动保存 ---------- */
  section('3. 编辑器写作与自动保存')
  await page.waitFor("document.querySelector('.ProseMirror')", { label: '编辑器挂载' })
  await page.evaluate("document.querySelector('.ProseMirror').focus(); return true")
  await page.typeText(BODY_LINES[0])
  await page.pressKey('Enter')
  await page.typeText(BODY_LINES[1])

  const pmText = await page.evaluate("return document.querySelector('.ProseMirror').innerText")
  check('正文进入编辑器', BODY_LINES.every((l) => pmText.includes(l)), JSON.stringify(pmText.slice(0, 80)))

  const wordLabel = await page.evaluate("return Array.from(document.querySelectorAll('.center span')).map((s) => s.textContent).join(' | ')")
  check('顶栏字数已更新（不是 0）', !/本章 0\b/.test(wordLabel), wordLabel)

  // 等自动保存落地
  await page.waitFor("document.querySelector('.save')?.textContent.includes('已保存')", { timeout: 8000, label: '自动保存完成' })
  check('顶栏显示「已保存」', true)

  const files = await page.evaluate(`return await window.__fs.walk(${JSON.stringify(WORK)})`)
  note('    磁盘文件：' + JSON.stringify(files))
  const chFile = files.find((f) => f.includes('正文/') && f.endsWith('.md'))
  check('章节文件已写入 正文/', !!chFile, JSON.stringify(files))

  const chRaw = chFile ? await page.evaluate(`return await window.__fs.read(${JSON.stringify(chFile)})`) : ''
  check('落盘内容含正文', BODY_LINES.every((l) => chRaw.includes(l)), JSON.stringify(chRaw.slice(0, 120)))
  check('章文件带 front matter（title/status）', /^---[\s\S]*title:/.test(chRaw) && chRaw.includes('status:'))
  check('front matter 里 title 正确', chRaw.includes(`title: ${CH_TITLE}`))
  check('默认状态为「待写」', chRaw.includes('status: 待写'), chRaw.split('\n').slice(0, 12).join(' | '))
  await shot(page, '03-writing.png')

  /* ---------- 4. 刷新恢复（句柄持久化） ---------- */
  section('4. 刷新页面：目录句柄能否恢复')
  await page.reload(3000)
  const afterReload = await page.text()
  const backInEditor = await page.evaluate("return !!document.querySelector('.bar')")
  check('刷新后自动回到写作界面（不掉回首页）', backInEditor && !afterReload.includes('新建作品'), afterReload.slice(0, 120))
  const pmAfter = await page.evaluate("return document.querySelector('.ProseMirror')?.innerText || ''")
  check('刷新后正文内容完整恢复', BODY_LINES.every((l) => pmAfter.includes(l)), JSON.stringify(pmAfter.slice(0, 80)))
  const chAfter = await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")
  check('刷新后章节树恢复', chAfter === 1, `章节数 ${chAfter}`)
  const savedMark = await page.evaluate("return document.querySelector('.bk')?.textContent || ''")
  check('刷新后书名正确', savedMark.includes(WORK), savedMark)
  await shot(page, '04-after-reload.png')

  /* ---------- 5. 五个视图 ---------- */
  section('5. 五个主视图（Ctrl+1…5）')
  const VIEWS = [
    { key: '1', name: '写作', sel: '.ProseMirror' },
    { key: '2', name: '看板', sel: '.board' },
    { key: '3', name: '关系图', sel: '.graph' },
    { key: '4', name: '时间线', sel: '.tl' },
    { key: '5', name: '统计', sel: '.stats' }
  ]
  for (const v of VIEWS) {
    await page.evaluate("document.body.focus(); return true")
    await page.pressKey(v.key, { ctrl: true })
    await sleep(500)
    const ok = await page.evaluate(`return !!document.querySelector(${JSON.stringify(v.sel)})`)
    const txt = await page.evaluate('return document.body.innerText.length')
    check(`Ctrl+${v.key} 切到「${v.name}」且渲染成功`, ok && txt > 50, `sel=${v.sel} innerText=${txt}`)
  }
  /* ---------- 5.0b 稿纸宽度（回归）----------
     这章正文只有几十个字，max-content 远小于可用宽度 ——
     .editor-wrap 一旦丢了 flex:1 就会塌成一条几十像素的窄竖条贴在左边
     （真实截图事故：整张稿纸只剩「归」字那么宽）。空章也要是一张居中的固定宽度稿纸。 */
  await page.evaluate("document.body.focus(); return true")
  await page.pressKey('1', { ctrl: true })
  await sleep(400)
  const paper = await page.evaluate(`return (() => {
    const el = document.querySelector('.paper-col')
    const sc = document.querySelector('.editor-scroll')
    if (!el || !sc) return null
    const r = el.getBoundingClientRect()
    const s = sc.getBoundingClientRect()
    // 居中与否要相对滚动容器的**内容区**量：窗外还有目录（232px）和右侧面板（348px），
    // 拿 window.innerWidth 当参照永远「不居中」；而内容区右缘要用 clientWidth ——
    // 稿纸底下的 45vh 底垫让滚动条常驻，rect.width 是连滚动条一起算的，会冤枉它 5px。
    const contentRight = s.left + sc.clientWidth
    return { w: r.width, leftGap: r.left - s.left, rightGap: contentRight - r.right }
  })()`)
  check('稿纸宽度固定（空章也不塌缩）', !!paper && paper.w >= 400, paper ? `宽 ${Math.round(paper.w)}px` : '没找到 .paper-col')
  check(
    '稿纸在写作区里水平居中',
    !!paper && Math.abs(paper.leftGap - paper.rightGap) < 6,
    paper ? `左空 ${Math.round(paper.leftGap)} / 右空 ${Math.round(paper.rightGap)}` : '—'
  )

  await page.pressKey('2', { ctrl: true })
  await sleep(400)
  await shot(page, '05-board.png')

  /* ---------- 5.1 关系图：节点画得出来，而且拖得动 ─---------
     为什么值得单开一段：关系图的节点曾经是**普通对象**，拖动与「重排」只改 n.x / n.y
     这两个数字，Vue 收不到通知 —— 表现是「圆点拖着不动」，jsdom 冒烟也看不出来
     （它只在别的东西碰巧触发重渲染时才跳过去）。所以这里发真鼠标事件，
     断言 transform 真的跟着变。 */
  section('5.1 关系图：拖动节点真的重绘')
  const putEntry = (name, text) =>
    `(async () => {
      const d = await window.__fs.dir(${JSON.stringify(WORK + '/设定/人物设定')}, true)
      const fh = await d.getFileHandle(${JSON.stringify(name)}, { create: true })
      const w = await fh.createWritable()
      await w.write(${JSON.stringify(text)})
      await w.close()
      return true
    })()`
  await page.evaluate(putEntry('汀兰.md', '---\ntype: character\nname: 汀兰\n---\n\n# 汀兰\n\n关联：[[云杉]]\n'))
  await page.evaluate(putEntry('云杉.md', '---\ntype: character\nname: 云杉\n---\n\n# 云杉\n\n关联：[[汀兰]]\n'))

  // OPFS 的目录枚举是「最终一致」的：createWritable close 之后，列目录偶尔要再过一小会儿
  // 才能看见新文件。而关系图只在挂载时强刷一次设定库 —— 那一次读要是赶在元数据可见之前，
  // 节点就永远是 0（这条 flake 四次里挂过三次）。真机上同样存在：在外部改完文件切回来，
  // 偶尔会读到旧的空目录。所以先等到目录里真能列出这两个文件，再切视图，把顺序对齐。
  await page.waitFor(
    `(async () => (await window.__fs.list(${JSON.stringify(WORK + '/设定/人物设定')})).length >= 2)()`,
    { timeout: 10000, label: '种下的设定文件在 OPFS 目录枚举里可见' }
  )

  // 切视图前先把焦点还给 body：这段不在 §5 那个循环里，没有先跑 body.focus()，
  // 万一焦点停在某个输入框上，Ctrl+3 这一下就落不进全局派发（视图根本不切，
  // `.graph` 永远不出现 —— 症状恰好是「节点数一直是 0」，看着像设定没加载，其实是没切过去）。
  await page.evaluate("document.body.focus(); return true")
  // 先离开再回来：§5 那个循环已经进过一次关系图（那时设定库还是空的），
  // 直接按 Ctrl+3 只是把已经挂载的那份重新显示出来，读不读得到新文件全看
  // 谁先跑完 —— 于是这条四次里挂三次。而应用对作者的承诺是
  // 「切回这个视图就该看见新条目」（GraphView 的 onMounted 里就是 ensureCodex(true)），
  // 所以这里走「离开 → 回来」这条**设计好的路径**，让它变成确定的重挂载强制重读。
  await page.pressKey('1', { ctrl: true })
  await sleep(400)
  await page.pressKey('3', { ctrl: true })
  await page.waitFor("!!document.querySelector('.graph')", { timeout: 10000, label: '切到关系图视图' })
  await page.waitFor("document.querySelectorAll('.graph .node').length >= 2", { timeout: 10000, label: '关系图画出台子' })
  const gNodes = await page.evaluate("return document.querySelectorAll('.graph .node').length")
  const gLines = await page.evaluate("return document.querySelectorAll('.graph .edges line').length")
  check('关系图把设定条目画成节点', gNodes >= 2, `节点 ${gNodes}`)
  check('显式 [[双链]] 画成连线', gLines >= 1, `连线 ${gLines}`)
  await shot(page, '06-graph.png')

  const pt = await page.evaluate(`return (() => {
    const c = document.querySelector('.graph .node circle')
    const b = c.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, t: c.closest('.node').getAttribute('transform') }
  })()`)
  const mouse = (type, x, y, buttons) =>
    page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons })
  await mouse('mousePressed', pt.x, pt.y, 1)
  await mouse('mouseMoved', pt.x + 60, pt.y + 40, 1)
  await sleep(200)
  const dragged = await page.evaluate("return document.querySelector('.graph .node').getAttribute('transform')")
  check(
    '拖动节点后坐标跟着鼠标变（节点是响应式的）',
    dragged !== pt.t && !!dragged,
    `${pt.t} → ${dragged}（鼠标移动了 60,40）`
  )
  await mouse('mouseReleased', pt.x + 60, pt.y + 40, 0)
  await sleep(150)
  await page.pressKey('1', { ctrl: true })
  await sleep(400)

  /* ---------- 6. 右侧面板 ---------- */
  section('6. 右侧九面板')
  await page.pressKey('j', { ctrl: true })
  await page.waitFor("document.querySelector('.dock')", { label: '右侧面板打开' })
  const tabs = await page.evaluate("return Array.from(document.querySelectorAll('.dock .tabs button')).map((b) => b.textContent.trim())")
  note('    面板页签：' + JSON.stringify(tabs))
  check('九个离线面板都在（AI 未配置时不出现 AI 页签）', tabs.length >= 9 && !tabs.includes('上下文'))

  for (const t of tabs) {
    await page.clickByText('.dock .tabs button', t)
    await sleep(320)
    const len = await page.evaluate("return document.querySelector('.dock .body')?.innerText.trim().length || 0")
    check(`面板「${t}」可渲染`, len > 0, `innerText 长度 ${len}`)
  }
  await page.clickByText('.dock .tabs button', '统计')
  await sleep(400)
  await shot(page, '07-dock-stats.png')
  await page.clickByText('.dock .tabs button', '设定')
  await sleep(400)
  await shot(page, '08-dock-codex.png')

  /* ---------- 7. 查找 / 专注 / 参考 ---------- */
  section('7. 其它入口')
  await page.pressKey('f', { ctrl: true })
  await sleep(400)
  const findShown = await page.evaluate("return document.body.innerText.includes('查找') || !!document.querySelector('[class*=find], .find-bar')")
  check('Ctrl+F 打开查找', findShown)
  await page.pressKey('Escape')
  await sleep(200)

  // 专注模式用 F11。这里刻意不再用 Ctrl+E 验：P3-D 把「正文内 Ctrl+B / Ctrl+E 归编辑器
  // （加粗 / 行内代码）」这条规则立起来了，光标在正文里按 Ctrl+E 就不该再切专注。
  await page.pressKey('F11')
  await sleep(400)
  const focused = await page.evaluate("return !!document.querySelector('.exit-focus')")
  check('F11 进入专注模式', focused)
  await page.pressKey('Escape')
  await sleep(300)

  // 反向验一次：光标在正文里按 Ctrl+E，应该是行内代码，而不是切专注模式
  await page.evaluate("document.querySelector('.ProseMirror')?.focus(); return true")
  await page.pressKey('e', { ctrl: true })
  await sleep(400)
  check('正文内 Ctrl+E 不再抢去切专注（让位给行内代码）', !(await page.evaluate("return !!document.querySelector('.exit-focus')")))

  // 这条盯的是修掉的那个双重动作 bug：以前 Ctrl+B 会同时加粗并收起目录
  const sidebarBefore = await page.evaluate("return !!document.querySelector('.tree-body')")
  await page.pressKey('b', { ctrl: true })
  await sleep(400)
  const sidebarAfter = await page.evaluate("return !!document.querySelector('.tree-body')")
  check('正文内 Ctrl+B 不会顺手把章节目录收起来', sidebarBefore && sidebarBefore === sidebarAfter, `${sidebarBefore} → ${sidebarAfter}`)

  await page.clickByText('.right button', '参考')
  await sleep(500)
  const refOpen = await page.evaluate("return document.body.innerText.includes('参考') && document.querySelectorAll('.bar').length === 1")
  check('「参考」按钮可开合（未崩溃）', refOpen)
  await page.clickByText('.right button', '参考')
  await sleep(300)

  /* ---------- 7.5 章节树的 ＋：应用内对话框（P3-E 起不再用原生 prompt） ---------- */
  section('7.5 章节树 ＋：应用内对话框新建第二章')
  const clickPlus = () =>
    page.evaluate(`
      const btns = Array.from(document.querySelectorAll('.tree-body .btn-icon')).filter((b) => b.textContent.trim() === '＋')
      if (btns[0]) btns[0].click()
      return true
    `)
  await clickPlus()
  await page.waitFor("document.querySelector('.dlg-mask')", { timeout: 6000, label: '应用内对话框弹出' })

  // 这条是 P3-E 的核心：弹出的必须是页面里的对话框，而不是浏览器的 prompt
  check('建章走应用内对话框，没有触发任何原生弹窗', page.dialogs.length === 0, JSON.stringify(page.dialogs))
  const dlgHead = await page.evaluate("return document.querySelector('.dlg-mask .dlg-head')?.innerText.trim() || ''")
  check('对话框标题正确', dlgHead.includes('新建章节'), dlgHead)
  const dlgPlaceholder = await page.evaluate("return document.querySelector('.dlg-mask input')?.placeholder || ''")
  check('输入框给出「留空会得到什么名字」的提示', dlgPlaceholder.includes('第'), dlgPlaceholder)
  check('刚打开时没有红色报错（用户还没动手，不该先吓人）', !(await page.evaluate("return !!document.querySelector('.dlg-mask .dlg-err')")))
  await shot(page, '19-app-dialog.png')

  // 原生 prompt 给不了的约束：空着不让提交
  const emptyOkDisabled = await page.evaluate("const b = Array.from(document.querySelectorAll('.dlg-foot button')).pop(); return !!b.disabled")
  check('空输入时「确定」是禁用的（原生 prompt 做不到）', emptyOkDisabled)
  // 点一下被禁用的确定 → 什么也不该发生；错误文案则在用户动手后才出现
  const errAfterTry = await page.evaluate("return document.querySelector('.dlg-mask .dlg-err')?.innerText.trim() || ''")
  check('空输入时给出「不能为空」这类可读原因', errAfterTry === '' || errAfterTry.includes('不能为空'), errAfterTry)

  await page.evaluate("const i = document.querySelector('.dlg-mask input'); i.focus(); return true")
  await page.typeText('重逢')
  await sleep(250)
  const typed = await page.evaluate("return document.querySelector('.dlg-mask input')?.value || ''")
  check('对话框输入框收到了文字', typed === '重逢', typed)
  const okEnabled = await page.evaluate("const b = Array.from(document.querySelectorAll('.dlg-foot button')).pop(); return !b.disabled")
  check('填了标题后「确定」变为可点', okEnabled)

  // 回车直接提交，手感跟原生 prompt 一样
  await page.pressKey('Enter')
  await page.waitFor("document.querySelectorAll('.tree-body .ch').length === 2", { timeout: 8000, label: '第二章出现（2 章）' })
  check('回车即提交，对话框自动关闭', !(await page.evaluate("return !!document.querySelector('.dlg-mask')")))
  check('章节树 ＋ 能建出第二章', (await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")) === 2)
  const files2 = await page.evaluate(`return await window.__fs.list(${JSON.stringify(WORK + '/正文')})`)
  check('第二章文件已落盘（无 .crswap 临时文件残留）', files2.length === 2 && !files2.some((f) => f.includes('.crswap')), JSON.stringify(files2))

  // 取消路径：Esc 关掉，不该多出章节（以前原生 confirm 的取消做不到被验收）
  await clickPlus()
  await page.waitFor("document.querySelector('.dlg-mask')", { timeout: 6000, label: '第二次弹出对话框' })
  await page.pressKey('Escape')
  await sleep(300)
  check('Esc 关得掉对话框', !(await page.evaluate("return !!document.querySelector('.dlg-mask')")))
  check('取消后章节数不变（没偷偷建出空章）', (await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")) === 2)
  check('全程零原生弹窗', page.dialogs.length === 0, JSON.stringify(page.dialogs))

  /* ---------- 7.6 切章后编辑区内容要对得上 ---------- */
  section('7.6 章节切换：正文不能串章')
  // 这条对应一个真浏览器里才暴露的 bug：selectChapter 先改 currentId 再读正文，
  // 编辑器 watcher 会拿到上一章的内容。
  await page.evaluate("document.querySelector('.tree-body .ch-title').click(); return true")
  await sleep(600)
  const back1 = await page.evaluate("return document.querySelector('.ProseMirror')?.innerText || ''")
  check('切回第一章显示的是第一章正文', BODY_LINES.every((l) => back1.includes(l)), JSON.stringify(back1.slice(0, 80)))
  const head1 = await page.evaluate("return document.querySelector('.ch-title')?.textContent || ''")
  check('标题跟随切换到第一章', head1 === CH_TITLE, head1)

  await page.evaluate(`
    const chs = Array.from(document.querySelectorAll('.tree-body .ch'))
    chs[1].click()
    return true
  `)
  await sleep(600)
  const onCh2 = await page.evaluate("return document.querySelector('.ProseMirror')?.innerText || ''")
  check('切到第二章不再残留第一章正文', !onCh2.includes(BODY_LINES[0]), JSON.stringify(onCh2.slice(0, 80)))

  /* ---------- 7.7 导入已有稿件 ---------- */
  section('7.7 导入已有稿件（真实文件输入框）')

  /* 控件里的字会不会被自己的样式削掉（作者报「导入稿件处有乱码」）。
     量的是**真实控件的像素**：字需要的行高 vs 实际内容盒高度。
     真凶是下拉框被写死 height:26px —— 13px 的汉字要 17px 行高，减去 padding 12px 与
     边框 2px，内容盒只剩 12px，每个字上下各削 2.5px，「自动按「第X章」」的「章」
     被削成了「音」。换台机器、换个字号偶然就没事，所以不吃肉眼那一套。 */
  const scanControls = () =>
    page.evaluate(`
      const out = []
      const px = (v) => parseFloat(v) || 0
      const tag = (el) => {
        const parts = []
        let cur = el
        for (let i = 0; i < 3 && cur && cur !== document.body; i++) {
          let s = cur.tagName.toLowerCase()
          if (typeof cur.className === 'string' && cur.className.trim()) s += '.' + cur.className.trim().split(/\\s+/).slice(0, 1)
          parts.unshift(s)
          cur = cur.parentElement
        }
        return parts.join('>')
      }
      const measure = (s, text) => {
        const p = document.createElement('div')
        p.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;margin:0;padding:0;border:0;' +
          'font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';font-weight:' + s.fontWeight + ';line-height:' + s.lineHeight
        p.textContent = text
        document.body.appendChild(p)
        const r = p.getBoundingClientRect()
        const o = { h: +r.height.toFixed(1), w: +r.width.toFixed(1) }
        p.remove()
        return o
      }
      const NON_TEXT = /^(checkbox|radio|range|color|file|image|submit|reset|hidden)$/i
      for (const el of document.querySelectorAll('select, input, button')) {
        const s = getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden') continue
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        const t = el.tagName.toUpperCase()
        if (t === 'INPUT' && NON_TEXT.test(el.type || 'text')) continue
        const txt = t === 'SELECT' ? (el.options[el.selectedIndex]?.text || '')
          : t === 'INPUT' ? (el.value || el.getAttribute('placeholder') || '')
          : el.textContent.trim()
        if (!txt) continue
        const contentH = r.height - px(s.paddingTop) - px(s.paddingBottom) - px(s.borderTopWidth) - px(s.borderBottomWidth)
        const contentW = r.width - px(s.paddingLeft) - px(s.paddingRight) - px(s.borderLeftWidth) - px(s.borderRightWidth)
        const oneLine = t !== 'BUTTON' || s.whiteSpace === 'nowrap' || s.whiteSpace === 'pre'
        const m = measure(s, '汉字Xg')
        if (oneLine && contentH + 0.5 < m.h) out.push({ why: '纵向削字', el: tag(el), txt: txt.slice(0, 20), contentH: +contentH.toFixed(1), need: m.h })
        if (t !== 'BUTTON') {
          const tw = measure(s, txt).w
          if (tw > contentW + 1) out.push({ why: '横向切字', el: tag(el), txt: txt.slice(0, 20), contentW: +contentW.toFixed(1), need: tw })
        }
      }
      return out
    `)

  const fx = writeFixtures()
  await page.clickByText('.right button', '导入稿件')
  await page.waitFor("document.querySelector('.dialog')", { label: '导入对话框打开' })

  /* 就着刚打开的这个弹窗把「三个控件」量清楚：这一屏是作者截图报错的那一屏 */
  const grid = await page.evaluate(`return (() => {
    const px = (v) => parseFloat(v) || 0
    const sel = document.querySelector('.dialog .grid3 select')
    const inp = document.querySelector('.dialog .grid3 input')
    const cs = getComputedStyle(sel)
    const r = (e) => e.getBoundingClientRect()
    const contentH = r(sel).height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth)
    const contentW = r(sel).width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth)
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;margin:0;padding:0;border:0;font-family:' + cs.fontFamily + ';font-size:' + cs.fontSize + ';line-height:' + cs.lineHeight
    document.body.appendChild(probe)
    let widest = { text: '', w: 0 }
    for (const o of sel.options) {
      probe.textContent = o.text
      const w = probe.getBoundingClientRect().width
      if (w > widest.w) widest = { text: o.text, w: +w.toFixed(1) }
    }
    probe.textContent = '汉字Xg'
    const lineH = +probe.getBoundingClientRect().height.toFixed(1)
    probe.remove()
    return { selH: +r(sel).height.toFixed(1), inpH: +r(inp).height.toFixed(1), contentH: +contentH.toFixed(1), contentW: +contentW.toFixed(1), lineH, widest }
  })()`)
  note('    切章下拉框：高 ' + grid.selH + 'px · 旁边输入框 ' + grid.inpH + 'px · 内容盒 ' + grid.contentH + 'px · 一行字要 ' + grid.lineH + 'px')
  check('切章方式下拉框与旁边输入框一样高（三格对齐，不再矮一截）', Math.abs(grid.selH - grid.inpH) <= 1, `下拉 ${grid.selH} / 输入 ${grid.inpH}`)
  check('下拉框的内容盒装得下一行汉字（装不下就会削字，第X章 看成 第x音）', grid.contentH + 0.5 >= grid.lineH, `内容盒 ${grid.contentH} < 需要 ${grid.lineH}`)
  check(
    '三个切章方式选项都完整显示（最长那个也不被横切）',
    grid.widest.w <= grid.contentW,
    `最宽选项「${grid.widest.text}」需要 ${grid.widest.w}px，只有 ${grid.contentW}px`
  )
  const dlgText77 = await page.evaluate("return document.querySelector('.dialog')?.innerText.replace(/\\s+/g, ' ') || ''")
  check(
    '正则那格换成人话（示例不再是 § 这种符号，并说明留空即可）',
    dlgText77.includes('正则不会写就留空') && dlgText77.includes('^第\\d+章') && !dlgText77.includes('§'),
    dlgText77.slice(0, 120)
  )
  check(
    '说明文字不再被从中间劈开（大纲那段自成一行，「纲）。」不再孤零零占一行）',
    await page.evaluate("const s = document.querySelector('.dialog .blk'); return !!s && getComputedStyle(s).display === 'block'")
  )
  check('导入弹窗里没有控件在削字 / 切字', (await scanControls()).length === 0, JSON.stringify(await scanControls()))

  // 高倍局部图：修的就是这一处，回看时一眼能确认字没被削
  const gridBox = await page.evaluate("const r = document.querySelector('.dialog .grid3').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }")
  const clipShot = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: gridBox.x - 8, y: gridBox.y - 8, width: gridBox.w + 16, height: gridBox.h + 16, scale: 3 }
  })
  writeFileSync(join(SHOTS, '36-import-grid.png'), Buffer.from(clipShot.data, 'base64'))


  await page.setFileInput('.dialog input[type=file]', [fx.utf8])
  await page.waitFor("document.querySelectorAll('.dialog .ch-row').length === 2", { timeout: 8000, label: '预览出 2 章' })
  const encTag = await page.evaluate("return document.querySelector('.dialog .meta')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('UTF-8 稿件被识别为 UTF-8', /UTF-8/.test(encTag), encTag)
  const rows = await page.evaluate(
    "return Array.from(document.querySelectorAll('.dialog .ch-row')).map((r) => r.innerText.replace(/\\s+/g, ' ').trim())"
  )
  check('预览列出两章且标题已去掉「第X章」前缀', rows.length === 2 && rows[0].includes('启程') && !rows[0].includes('第一章'), JSON.stringify(rows))
  await shot(page, '10-import-preview.png')

  await page.evaluate(
    "const i = Array.from(document.querySelectorAll('.dialog input')).find((x) => (x.placeholder || '').includes('旧稿')); i.focus(); return true"
  )
  await page.typeText('旧稿')
  await page.clickByText('.dialog button', '导入 2 章')
  await page.waitFor("document.querySelectorAll('.tree-body .ch').length === 4", { timeout: 20000, label: '章节树变成 4 章' })
  const chNow = await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")
  check('导入后章节树变成 4 章（原有 2 章没被动）', chNow === 4, `章节数 ${chNow}`)
  const allBody = await page.evaluate(`return await window.__fs.walk(${JSON.stringify(WORK + '/正文')})`)
  const importedFiles = allBody.filter((p) => p.includes('旧稿') && /第\d+章.*\.md$/.test(p))
  const volOutline = allBody.filter((p) => p.includes('旧稿') && p.endsWith('卷纲.md'))
  check('导入的 2 章落进新建的卷目录', importedFiles.length === 2, JSON.stringify(allBody))
  check('新卷自动生成 卷纲.md', volOutline.length === 1, JSON.stringify(allBody))
  const importedRaw = await page.evaluate(`return await window.__fs.read(${JSON.stringify(importedFiles[0] || '')})`)
  check('导入文件带 front matter 且按「草稿」入库', /^---[\s\S]*title:/.test(importedRaw) && importedRaw.includes('status: 草稿'), importedRaw.split('\n').slice(0, 8).join(' | '))
  check('导入的正文内容完整落盘', importedRaw.includes('船靠岸的时候，雨还没停。'), importedRaw.slice(0, 160))
  await shot(page, '11-imported.png')

  // 同一份内容换 GBK 再走一遍：编码判断是这一步最容易出错的地方
  await page.setFileInput('.dialog input[type=file]', [fx.gbk])
  await page.waitFor("document.querySelectorAll('.dialog .ch-row').length === 2", { timeout: 8000, label: 'GBK 预览出 2 章' })
  const encTag2 = await page.evaluate("return document.querySelector('.dialog .meta')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('GBK 稿件被认出是 GB 系编码（没有静默变成乱码）', /GB/i.test(encTag2), encTag2)
  const rows2 = await page.evaluate(
    "return Array.from(document.querySelectorAll('.dialog .ch-row')).map((r) => r.innerText.replace(/\\s+/g, ' ').trim())"
  )
  check('GBK 稿件的章标题解码正确', rows2.some((r) => r.includes('启程')), JSON.stringify(rows2))
  const dlgText = await page.evaluate("return document.querySelector('.dialog')?.innerText || ''")
  check('GBK 稿件没有触发乱码告警', !dlgText.includes('无法识别'), dlgText.slice(0, 120))

  await page.click('.dialog .head .btn-icon')
  await sleep(300)
  check('导入对话框可关闭', !(await page.evaluate("return !!document.querySelector('.dialog')")))


  /* ---------- 7.7b 导入大纲 / 卷纲 / 章纲 ---------- */
  section('7.7b 导入大纲（粘进去 → 认层级 → 写卷纲与章纲）')
  await page.clickByText('.right button', '导入大纲')
  await page.waitFor("document.querySelector('.dialog')", { label: '导入大纲对话框打开' })
  const OUTLINE_MD = [
    '# 第一卷 启程',
    '卷目标：回到原点',
    '',
    '## 第一章 雪夜',
    '本章目标：立住人物与处境',
    '雪夜回乡。',
    '',
    '## 第二章 重逢',
    '本章目标：埋下旧怨',
    ''
  ].join('\n')
  await page.evaluate(
    `const ta = document.querySelector('.dialog textarea'); ta.value = ${JSON.stringify(OUTLINE_MD)}; ta.dispatchEvent(new Event('input')); return true`
  )
  await page.waitFor("document.querySelectorAll('.dialog .ch-row').length >= 1", { timeout: 8000, label: '预览出一卷' })
  const ovText = await page.evaluate("return document.querySelector('.dialog').innerText")
  check('粘进去就认出卷与章', ovText.includes('第一卷 启程') && /2 章/.test(ovText), ovText.slice(0, 200))
  check('写进哪个文件写在按钮旁边（作者不用猜）', ovText.includes('卷纲.md'), ovText.slice(0, 200))
  await shot(page, '11b-outline-import.png')

  await page.clickByText('.dialog button', '导入 1 卷的卷纲')
  await page.waitFor("document.querySelectorAll('.tree-body .ch').length === 6", { timeout: 20000, label: '章节树加上导入的 2 章' })
  const afterVol = await page.evaluate(`return await window.__fs.walk(${JSON.stringify(WORK + '/正文')})`)
  const volFile = afterVol.filter((x) => x.includes('第一卷') && x.endsWith('卷纲.md'))
  check('卷目录与卷纲都建出来了', volFile.length === 1, JSON.stringify(afterVol))
  const vgRaw = await page.evaluate(`return await window.__fs.read(${JSON.stringify(volFile[0] || '')})`)
  check('卷纲的 front matter 里写了卷目标', vgRaw.includes('target: 回到原点'), vgRaw.split('\n').slice(0, 10).join(' | '))
  check('卷纲正文里有章节安排', vgRaw.includes('第一章 雪夜') && vgRaw.includes('埋下旧怨'), vgRaw.slice(0, 200))
  const volChs = afterVol.filter((x) => x.includes('第一卷') && /第\d+章.*\.md$/.test(x))
  check('卷下建成 2 个空章坑位', volChs.length === 2, JSON.stringify(volChs))
  const emptyRaw = await page.evaluate(`return await window.__fs.read(${JSON.stringify(volChs[0] || '')})`)
  check('坑位是空的 —— 导入大纲不替作者写正文', !emptyRaw.includes('雪夜回乡'), emptyRaw.slice(0, 160))

  // 同一个大纲再导一次，这次写章纲：只补「本章目标」，不重复建章
  await page.evaluate(
    "const b = Array.from(document.querySelectorAll('.dialog button')).find((x) => (x.textContent || '').trim() === '章纲'); b.click(); return true"
  )
  await sleep(200)
  await page.clickByText('.dialog button', '导入 2 条章纲')
  await page.waitFor(
    "document.querySelectorAll('.tree-body .ch').length === 6",
    { timeout: 20000, label: '章纲导入后章数不变（没有重复建章）' }
  )
  const chTreeNow = await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")
  check('章纲导入后章数还是 6（对上已有章节只补目标）', chTreeNow === 6, `章节数 ${chTreeNow}`)
  const chTargetRaw = await page.evaluate(`return await window.__fs.read(${JSON.stringify(volChs[0] || '')})`)
  check('章纲写进了「本章目标」', chTargetRaw.includes('target: 立住人物与处境'), chTargetRaw.split('\n').slice(0, 10).join(' | '))
  check('章纲没有动正文', !chTargetRaw.includes('雪夜回乡'), chTargetRaw.slice(0, 200))
  await shot(page, '11c-outline-imported.png')

  await page.click('.dialog .head .btn-icon')
  await sleep(300)
  check('导入大纲对话框可关闭', !(await page.evaluate("return !!document.querySelector('.dialog')")))

  /* ---------- 7.8 备份与恢复 ---------- */
  section('7.8 备份与恢复（真的把 zip 下载下来验）')
  const dlDir = join(FIXTURES, 'downloads')
  await page.allowDownloads(dlDir)

  await page.clickByText('.right button', '设置')
  await page.waitFor("document.querySelector('.dialog')", { label: '设置对话框' })
  await page.clickByText('.dialog .head button', '通用')
  await sleep(250)
  await page.clickByText('.dialog button', '备份与存储…')
  await page.waitFor("document.querySelector('.backup-mask')", { label: '备份对话框' })
  check('设置 → 通用 里能打开「备份与存储」', true)

  await page.clickByText('.backup-mask button', '打包')
  await page.waitFor("document.querySelector('.backup-mask')?.innerText.includes('已打包')", { timeout: 20000, label: '打包完成' })
  const packText = await page.evaluate("return document.querySelector('.backup-mask')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('打包结果给出文件数与体积', /已打包 \d+ 个文件/.test(packText), packText.slice(0, 200))
  await shot(page, '12-backup.png')

  await page.clickByText('.backup-mask button', '下载 zip')
  const zipPath = await page.waitForDownload(dlDir, /\.zip$/)
  const zipBuf = readFileSync(zipPath)
  check('备份文件落到了磁盘', zipBuf.length > 200, `${zipBuf.length} 字节：${zipPath.split(/[\\/]/).pop()}`)
  check('产物是合法 zip（PK 头 + 中央目录结束记录）', zipBuf[0] === 0x50 && zipBuf[1] === 0x4b && zipBuf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])))
  // 条目名按 UTF-8 存进 zip；中文名必须带 bit 11 的 UTF-8 标志，否则资源管理器解出乱码目录名
  const has = (s) => zipBuf.includes(Buffer.from(s, 'utf8'))
  check('zip 里有备份清单', has('备份信息.json'))
  check('zip 里有正文与记忆目录的条目', has('正文/第001章 启程.md') && has('记忆/状态表.md'), '')
  check('条目名声明了 UTF-8 标志位（zip 通用位 bit 11）', (zipBuf[6] | (zipBuf[7] << 8)) === 0x0800, `flags=0x${(zipBuf[6] | (zipBuf[7] << 8)).toString(16)}`)

  // 从这份备份恢复：先预览，再以「跳过同名」模式恢复
  await page.clickByText('.backup-mask button', '从备份恢复')
  await sleep(250)
  await page.setFileInput('.backup-mask input[type=file]', [zipPath])
  await page.waitFor("document.querySelector('.backup-mask')?.innerText.includes('个文件可恢复')", { timeout: 10000, label: '备份预览' })
  const rvText = await page.evaluate("return document.querySelector('.backup-mask')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('恢复前能看到备份来自哪本书', rvText.includes(WORK), rvText.slice(0, 220))
  check('恢复前列出可恢复文件数', /个文件可恢复/.test(rvText), rvText.slice(0, 220))

  await page.evaluate(`
    const sel = document.querySelector('.backup-mask select')
    sel.value = 'skip'
    sel.dispatchEvent(new Event('change'))
    return true
  `)
  await page.clickByText('.backup-mask button', '开始恢复')
  await sleep(200)
  await page.clickByText('.backup-mask button', '确认恢复（再点一次）')
  await page.waitFor("document.querySelector('.backup-mask')?.innerText.includes('已恢复')", { timeout: 20000, label: '恢复完成' })
  const rdone = await page.evaluate("return document.querySelector('.backup-mask')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('恢复按 skip 模式执行并报出结果', /已恢复 \d+ 个文件，跳过 \d+ 个已存在/.test(rdone), rdone.slice(0, 260))
  check('恢复后作品内容仍完整（没被清空）', (await page.evaluate(`return await window.__fs.walk(${JSON.stringify(WORK)})`)).length >= 8)
  await shot(page, '13-restore.png')

  // 磁盘占用
  await page.clickByText('.backup-mask button', '磁盘占用')
  await sleep(600)
  const usageText = await page.evaluate("return document.querySelector('.backup-mask')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('占用页列出正文目录与体积', /正文/.test(usageText) && /\d/.test(usageText), usageText.slice(0, 240))
  check('占用页给出快照统计', /快照 \d+ 份/.test(usageText), usageText.slice(0, 300))
  check('占用页能改自动快照策略', await page.evaluate("return !!document.querySelector('.backup-mask')?.innerText.includes('每章最多保留')"))
  await shot(page, '14-usage.png')

  // 关掉备份对话框与设置对话框
  await page.click('.backup-mask .head .btn-icon')
  await sleep(250)
  await page.click('.dialog .head .btn-icon')
  await sleep(250)
  check('设置与备份对话框都能关掉', !(await page.evaluate("return !!document.querySelector('.backup-mask') || !!document.querySelector('.dialog')")))

  /* ---------- 7.9 P3-D：筛选 / 快捷键一览 / 编辑位置导航 / 主题 ---------- */
  section('7.9 写作体验补完：章节筛选 · 快捷键一览 · 导航历史 · 主题')
  // 到这一步树上一共 6 章（原始 2 章 + 导入 2 章 + 大纲导入建的 2 个空章），
  // 而且标题有重名（启程/重逢 各两份）—— 所以期望值一律现算，不写死数字。
  const treeTitles = await page.evaluate("return Array.from(document.querySelectorAll('.tree-body .ch-title')).map((t) => t.textContent.trim())")
  const treeStatus = await page.evaluate("return Array.from(document.querySelectorAll('.tree-body .ch .st')).map((s) => s.textContent.trim())")
  check('筛选前章节树有 6 章可筛', treeTitles.length === 6, JSON.stringify(treeTitles))

  // 关键词筛选：列表收窄到命中项 + 命中高亮 + 计数
  const term = '重逢'
  const expectHits = treeTitles.filter((t) => t.includes(term)).length
  check('样例里「重逢」是重名章，正好用来验「命中 N / 共 M」', expectHits >= 1 && expectHits < treeTitles.length, String(expectHits))
  await page.evaluate("const i = document.querySelector('.filter-input'); i.focus(); return true")
  await page.typeText(term)
  await page.waitFor(`document.querySelectorAll('.tree-body .ch').length === ${expectHits}`, { timeout: 8000, label: `筛选后只剩 ${expectHits} 章` })
  const fInfo = await page.evaluate("return document.querySelector('.filter-info')?.textContent.replace(/\\s+/g, ' ').trim() || ''")
  check('筛选框能收窄章节列表', (await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")) === expectHits)
  check('筛选给出「命中 N / 共 M 章」计数', new RegExp(`命中 ${expectHits} / 共 ${treeTitles.length} 章`).test(fInfo), fInfo)
  const hl = await page.evaluate("return Array.from(document.querySelectorAll('.tree-body mark.hl')).map((m) => m.textContent).join(',')")
  check('命中的关键词在树里高亮', hl.includes(term), hl)
  const shownTitles = await page.evaluate("return Array.from(document.querySelectorAll('.tree-body .ch-title')).map((t) => t.textContent.trim())")
  check('筛出来的每一章标题都含关键词', shownTitles.length === expectHits && shownTitles.every((x) => x.includes(term)), JSON.stringify(shownTitles))
  await shot(page, '15-tree-filter.png')

  // 状态筛选：语法能单独用，也能和关键词叠加
  const status = treeStatus[0]
  await page.evaluate("const i = document.querySelector('.filter-input'); i.focus(); i.select(); return true")
  await page.typeText(`#${status}`)
  await sleep(400)
  const fInfo2 = await page.evaluate("return document.querySelector('.filter-info')?.textContent.replace(/\\s+/g, ' ').trim() || ''")
  check('#状态 筛选生效并回显条件', fInfo2.includes(`状态 ${status}`), fInfo2)
  const shownStatus = await page.evaluate("return Array.from(document.querySelectorAll('.tree-body .ch .st')).map((s) => s.textContent.trim())")
  check('状态筛选后剩下的章确实都是该状态', shownStatus.length > 0 && shownStatus.every((s) => s === status), JSON.stringify(shownStatus))

  await page.pressKey('Escape')
  await page.waitFor(`document.querySelectorAll('.tree-body .ch').length === ${treeTitles.length}`, { timeout: 8000, label: 'Esc 清空筛选' })
  check('Esc 清空筛选、列表恢复', !(await page.evaluate("return !!document.querySelector('.filter-input').value")))

  // Ctrl+P：把焦点直接怼进筛选框
  await page.evaluate("document.querySelector('.ProseMirror')?.focus(); return true")
  await page.pressKey('p', { ctrl: true })
  await sleep(300)
  const focusCls = await page.evaluate("return document.activeElement?.className || ''")
  check('Ctrl+P 跳到章节筛选框', focusCls.includes('filter-input'), focusCls)
  await page.evaluate("document.activeElement?.blur?.(); return true")

  // 快捷键一览：`?` 打开，kbd 渲染，搜索能筛，Esc 关
  await page.pressKey('?', { shift: true })
  await page.waitFor("document.querySelector('.help-mask')", { timeout: 6000, label: '快捷键一览打开' })
  const helpText = await page.evaluate("return document.querySelector('.help-mask')?.innerText || ''")
  check('按 ? 打开快捷键一览', helpText.includes('快捷键一览'))
  check('一览里出现 Ctrl + S 与 Alt + ←', helpText.includes('Ctrl + S') && helpText.includes('Alt + ←'), helpText.slice(0, 160))
  check('一览按 写作/正文编辑器/导航/界面 分组', ['写作', '正文编辑器', '导航', '界面'].every((g) => helpText.includes(g)))
  const kbdCount = await page.evaluate("return document.querySelectorAll('.help-mask kbd').length")
  check('一览渲染出十几个键帽', kbdCount >= 15, String(kbdCount))
  await shot(page, '16-shortcuts.png')

  await page.evaluate("const i = document.querySelector('.help-mask .filter input'); i.focus(); return true")
  await page.typeText('导航')
  await sleep(300)
  const narrowed = await page.evaluate("return document.querySelector('.help-mask')?.innerText || ''")
  check('一览可以按关键词筛', narrowed.includes('Alt + ←') && !narrowed.includes('Ctrl + S'), narrowed.slice(0, 160))
  await page.pressKey('Escape') // 第一下只清搜索（输入框自己 stopPropagation 了）
  await sleep(250)
  check('第一下 Esc 只清搜索、面板还在', await page.evaluate("return !!document.querySelector('.help-mask') && !document.querySelector('.help-mask .filter input').value"))
  await page.pressKey('Escape')
  await page.waitFor("!document.querySelector('.help-mask')", { timeout: 5000, label: 'Esc 关闭一览' })
  check('第二下 Esc 关闭一览', true)

  // 编辑位置导航：点两章 → Ctrl+Alt+← 退回上一处 → Ctrl+Alt+→ 再前进
  await page.evaluate("document.querySelectorAll('.tree-body .ch')[0].click(); return true")
  await sleep(700)
  const spotA = await page.evaluate("return document.querySelector('.head-line .ch-title')?.textContent || ''")
  await page.evaluate("document.querySelectorAll('.tree-body .ch')[3].click(); return true")
  await sleep(700)
  const spotB = await page.evaluate("return document.querySelector('.head-line .ch-title')?.textContent || ''")
  check('两次点章后停在第 4 章', spotB !== spotA && !!spotB, `${spotA} → ${spotB}`)
  const navEnabled = await page.evaluate("return Array.from(document.querySelectorAll('button.nav')).map((b) => b.disabled)")
  check('工具栏「后退」此时可点、「前进」不可点', navEnabled[0] === false && navEnabled[1] === true, JSON.stringify(navEnabled))
  const backTip = await page.evaluate("return document.querySelector('button.nav')?.title || ''")
  check('「后退」按钮的提示写明要去哪一章', backTip.includes(spotA) && backTip.includes('Alt'), backTip)

  await page.pressKey('ArrowLeft', { ctrl: true, alt: true })
  await sleep(900)
  const backTo = await page.evaluate("return document.querySelector('.head-line .ch-title')?.textContent || ''")
  check('Ctrl+Alt+← 回到上一个编辑位置', backTo === spotA, `${backTo} vs ${spotA}`)
  const afterBack = await page.evaluate("return Array.from(document.querySelectorAll('button.nav')).map((b) => b.disabled)")
  check('后退之后「前进」变为可点', afterBack[1] === false, JSON.stringify(afterBack))

  await page.pressKey('ArrowRight', { ctrl: true, alt: true })
  await sleep(900)
  const fwdTo = await page.evaluate("return document.querySelector('.head-line .ch-title')?.textContent || ''")
  check('Ctrl+Alt+→ 前进回第 4 章', fwdTo === spotB, `${fwdTo} vs ${spotB}`)
  await shot(page, '17-nav-history.png')

  // 历史不止一格：一路后退要能连续走多步，最后退到底按钮变灰
  await page.evaluate("document.querySelectorAll('.tree-body .ch')[0].click(); return true")
  await sleep(700)
  let backSteps = 0
  for (let i = 0; i < 14; i++) {
    const can = await page.evaluate("return !document.querySelector('button.nav').disabled")
    if (!can) break
    await page.pressKey('ArrowLeft', { ctrl: true, alt: true })
    await sleep(450)
    backSteps++
  }
  check('后退能连续走多步（历史不只一格）', backSteps >= 2, `退了 ${backSteps} 步`)
  check('退到底后「后退」按钮变灰', await page.evaluate("return document.querySelector('button.nav').disabled"))
  check('退到底后编辑区仍有内容（回放不会把章节弄空）', (await page.evaluate("return (document.querySelector('.ProseMirror')?.innerText || '').length")) > 0)

  // 主题：Ctrl+. 轮换 → 类要挂到 <html>（body 背景与滚动条才会跟着走）
  const themeSteps = []
  for (let i = 0; i < 3; i++) {
    await page.pressKey('.', { ctrl: true })
    await sleep(250)
    themeSteps.push(
      await page.evaluate("return [document.documentElement.dataset.theme, document.documentElement.classList.contains('theme-dark'), document.documentElement.style.colorScheme].join('|')")
    )
  }
  check('Ctrl+. 依次切到 护眼 / 夜间 / 白底', themeSteps.map((s) => s.split('|')[0]).join('>') === 'sepia>dark>light', themeSteps.join(' , '))
  check('夜间主题：html 上有 theme-dark 且 color-scheme=dark', themeSteps[1].includes('true|dark'), themeSteps[1])
  check('切回白底后不留主题类', !themeSteps[2].includes('true'), themeSteps[2])

  // 主题要真的落到颜色上（不是只换了个类名）：比夜间与白底的正文底色
  const paperBg = () => page.evaluate("return getComputedStyle(document.querySelector('.paper') || document.body).backgroundColor")
  const bgLight = await paperBg()
  await page.pressKey('.', { ctrl: true }) // → 护眼
  await sleep(250)
  await page.pressKey('.', { ctrl: true }) // → 夜间
  await sleep(300)
  const bgDark = await paperBg()
  check('夜间模式的正文底色确实变暗了', bgDark !== bgLight && /rgb\((\d+)/.test(bgDark) && Number(bgDark.match(/rgb\((\d+)/)[1]) < 90, `${bgLight} → ${bgDark}`)
  const chromeBg = await page.evaluate("return getComputedStyle(document.body).backgroundColor")
  check('夜间模式下 body 底色也变了（说明类挂在 html 上生效）', chromeBg !== 'rgb(255, 255, 255)', chromeBg)
  await shot(page, '18-theme-dark.png')
  const forced = await page.evaluate("return !!document.querySelector('.theme-dark .paper') || document.documentElement.classList.contains('theme-dark')")
  check('夜间主题类生效于整页', forced)
  await page.pressKey('.', { ctrl: true }) // → 白底
  await sleep(300)
  check('再按一次回到白底', (await page.evaluate("return document.documentElement.dataset.theme")) === 'light')

  /* ---------- 7.10 章节目录的键盘操作（P3-E） ---------- */
  section('7.10 章节目录：焦点进列表后全键盘翻章')
  await page.evaluate("document.querySelector('.tree-body').focus(); return true")
  await sleep(250)
  const treeFocus = await page.evaluate("return document.activeElement?.className || ''")
  check('目录列表能拿到键盘焦点', treeFocus.includes('tree-body'), treeFocus)

  const cursorKey = () => page.evaluate("return document.querySelector('.ch.cursor')?.getAttribute('data-key') || ''")
  const activeKey = () => page.evaluate("return document.querySelector('.tree-body .ch.active')?.getAttribute('data-key') || ''")
  const cursorCls = () => page.evaluate("return document.querySelector('.cursor')?.className || ''")

  check('聚焦时光标自动落在当前章上', (await cursorKey()) === (await activeKey()), `${await cursorKey()} vs ${await activeKey()}`)

  await page.pressKey('Home')
  await sleep(250)
  check('Home 跳到列表最上面（卷标题行）', (await cursorCls()).includes('vol-line'), await cursorCls())

  await page.pressKey('ArrowDown')
  await sleep(200)
  const rowA = await cursorKey()
  await page.pressKey('ArrowDown')
  await sleep(200)
  const rowB = await cursorKey()
  check('↓ 逐行往下走，不会卡住', !!rowA && rowB !== rowA, `${rowA} → ${rowB}`)
  await page.pressKey('ArrowUp')
  await sleep(200)
  check('↑ 能退回上一行', (await cursorKey()) === rowA, `${await cursorKey()} vs ${rowA}`)

  await page.pressKey('End')
  await sleep(250)
  const lastKey = await cursorKey()
  check('End 跳到最后一章', !!lastKey, lastKey)

  await page.pressKey('Enter')
  await sleep(700)
  check('回车打开光标所在的那一章', (await activeKey()) === lastKey, `${await activeKey()} vs ${lastKey}`)

  const treeCountBefore = await page.evaluate("return document.querySelectorAll('.tree-body .ch').length")

  await page.pressKey('F2')
  await sleep(400)
  check('F2 就地重命名（该行标题变成输入框）', await page.evaluate("return !!document.querySelector('.tree-body .ch.cursor input')"))
  // 这是一个真浏览器里才暴露的缺陷：改名框是 v-if 现渲的，autofocus 属性对动态插入的元素不生效，
  // 于是按完 F2 光标还留在列表上，敲字没反应 —— 所以这里同时盯住「焦点真的进了输入框」
  check('改名框自己拿到焦点（否则按完 F2 敲字没反应）', await page.evaluate("return document.activeElement?.tagName === 'INPUT'"), await page.evaluate("return document.activeElement?.tagName || ''"))

  // 改成新名字并回车：名字要真的写进章节树（不是只改了个输入框的值）
  await page.evaluate("const i = document.querySelector('.tree-body .ch input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); return true")
  await page.typeText('改过名的章')
  await page.pressKey('Enter')
  await sleep(900)
  const afterRename = await page.evaluate("return Array.from(document.querySelectorAll('.tree-body .ch-title')).map((t) => t.textContent.trim())")
  check('回车确认后新名字出现在章节树里', afterRename.includes('改过名的章'), JSON.stringify(afterRename))
  check('改名后章节数不变（是改名，不是新建/删除）', afterRename.length === treeCountBefore, `${afterRename.length} vs ${treeCountBefore}`)
  check('改名后焦点回到列表（能接着用方向键）', (await page.evaluate("return document.activeElement?.className || ''")).includes('tree-body'))
  await shot(page, '20-tree-keyboard.png')

  /* ---------- 7.10b 快照回滚：屏幕和磁盘必须一起变 ---------- */
  section('7.10b 快照回滚：编辑器与磁盘必须同时改（不然下一个按键就把回滚冲掉）')
  // 曾经的写法是「读快照 → 只写 state.content」。编辑器**只在 currentId 变化时**
  // 才从 state.content 同步一次，而回滚时 id 没变 —— 结果是屏幕上还是回滚前的正文、
  // 盘上却已经是快照内容。作者随手敲一个字，自动保存就按屏幕上的旧正文把回滚**覆盖回去**：
  // 看着成功了，改动没了。这种「静默丢稿」只有真浏览器 + 真编辑器 + 真磁盘一起验才抓得住。
  const SNAP_A = '回滚前的正文甲甲甲'
  const SNAP_B = '改动后的正文乙乙乙'
  const BODY_DIR = WORK + '/正文'
  // 注意：不要把这个写成 page.waitFor 的表达式 —— waitFor 会把返回值当对象折算成 true，
  // 里面再套一层 async IIFE 的话它压根不会等，条件立刻"成立"。
  const waitDisk = async (needle, timeout = 9000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const hit = await page.evaluate(`
        const files = await window.__fs.walk(${JSON.stringify(BODY_DIR)})
        for (const f of files) if (f.endsWith('.md') && (await window.__fs.read(f)).includes(${JSON.stringify(needle)})) return f
        return ''
      `)
      if (hit) return hit
      await sleep(200)
    }
    return ''
  }
  const typeInto = async (text) => {
    await page.evaluate("document.querySelector('.ProseMirror').focus(); return true")
    await page.pressKey('a', { ctrl: true })
    await page.typeText(text)
    await sleep(300)
  }

  // 先显式落到写作视图：章节目录是 .main 的**兄弟**，看板/关系图下它照样在，
  // 所以「目录能点」推不出「编辑器挂着」——而下面全靠编辑器。别靠上下文猜。
  await page.pressKey('1', { ctrl: true })
  await sleep(600)

  await page.clickByText('.tree-body .ch-title', '改过名的章')
  await sleep(900)
  await page.waitFor("document.querySelector('.ProseMirror')", { timeout: 8000, label: '编辑器挂载（快照用例）' })

  await typeInto(SNAP_A)
  check('（前置）回滚前的正文已落盘（等自动保存真的写完）', !!(await waitDisk(SNAP_A)), `正文目录里找不到「${SNAP_A}」`)

  // 建一个手动快照，里面存的就是 SNAP_A
  await page.clickByText('.bar button', '快照')
  await page.waitFor("document.querySelector('.dialog')", { timeout: 6000, label: '快照面板' })
  await page.clickByText('.dialog button', '创建快照')
  await page.waitFor("document.querySelectorAll('.dialog .item').length >= 1", { timeout: 8000, label: '快照列表出现条目' })
  const manualSnap = await page.evaluate("return Array.from(document.querySelectorAll('.dialog .item')).filter((i) => i.innerText.includes('手动')).length")
  check('快照：手动快照建出来了并列在面板里', manualSnap >= 1, `手动快照 ${manualSnap} 个`)
  await page.clickByText('.dialog .head button', '×')
  await sleep(400)

  // 正文改成另一段，再回滚到刚才那份手动快照
  await typeInto(SNAP_B)
  check('（前置）改动后的正文已落盘', !!(await waitDisk(SNAP_B)), `正文目录里找不到「${SNAP_B}」`)

  await page.clickByText('.bar button', '快照')
  await page.waitFor("document.querySelector('.dialog')", { timeout: 6000, label: '快照面板（回滚）' })
  // 要认准刚建的那条手动快照：自动快照也在列表里，点错了回滚到别的内容就白测了
  const clickedRollback = await page.evaluate(`
    const item = Array.from(document.querySelectorAll('.dialog .item')).find((i) => i.innerText.includes('手动'))
    if (!item) return false
    const btn = Array.from(item.querySelectorAll('button')).find((b) => b.textContent.trim() === '回滚')
    if (!btn) return false
    btn.scrollIntoView({ block: 'center' })
    btn.click()
    return true
  `)
  check('快照：点得到那条手动快照的「回滚」', clickedRollback)
  await page.waitFor("document.querySelector('.dlg-foot')", { timeout: 6000, label: '回滚确认框' })
  check(
    '快照：回滚前走应用内确认框（不是原生 confirm）',
    String(await page.evaluate("return (document.querySelector('.dlg-body') || {}).innerText || ''")).includes('替换')
  )
  await page.clickByText('.dlg-foot button', '回滚')
  await sleep(1500)

  const screenAfter = await page.evaluate("return document.querySelector('.ProseMirror').innerText")
  check(
    '快照回滚：编辑区真的换成了快照内容（这是当初那个 bug 的正脸）',
    screenAfter.includes(SNAP_A) && !screenAfter.includes(SNAP_B),
    screenAfter.replace(/\s+/g, ' ').slice(0, 120)
  )
  const diskAfter = await page.evaluate(`
    const files = await window.__fs.walk(${JSON.stringify(BODY_DIR)})
    const hits = []
    for (const f of files) if (f.endsWith('.md') && (await window.__fs.read(f)).includes(${JSON.stringify(SNAP_A)})) hits.push(f)
    return hits
  `)
  check('快照回滚：磁盘上同步成了快照内容', diskAfter.length >= 1, JSON.stringify(diskAfter))

  // 真正的分水岭：回滚之后接着写。屏幕与盘不一致时，这一步就是「静默丢改动」的现场。
  await page.evaluate("document.querySelector('.ProseMirror').focus(); return true")
  await page.typeText('（回滚后接着写）')
  await sleep(2400)
  const tailDisk = await page.evaluate(`
    const files = await window.__fs.walk(${JSON.stringify(BODY_DIR)})
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const t = await window.__fs.read(f)
      if (t.includes(${JSON.stringify(SNAP_A)}) && t.includes('回滚后接着写')) return t
    }
    return ''
  `)
  check('快照回滚：之后接着写不会把回滚覆盖回去（屏幕与盘同源）', !!tailDisk, '磁盘上没找到「快照内容 + 新输入」的组合')
  await shot(page, '21-snapshot-rollback.png')

  /* ---------- 7.11 P3-F：没有 File System Access API 的浏览器怎么活 ---------- */
  section('7.11 降级沙盒：导入 → 写 → 导出（Firefox / Safari 走的那条路）')
  // `?sandbox=1` 强制降级。为什么要有这个开关：这条路真正的用户是 Firefox / Safari，
  // 而验收跑在 Chrome 上 —— 不开个口子，「没有 FSA 时长什么样」就只能靠想象。
  await page.evaluate(`
    localStorage.clear()
    await new Promise((r) => { const q = indexedDB.deleteDatabase('writer-sandbox'); q.onsuccess = q.onerror = q.onblocked = () => r() })
    return true
  `)
  await page.navigate(URL + '?sandbox=1', { waitMs: 1800 })
  const sbxHome = await page.text()
  check('降级：首页给出沙盒入口，而不是一句「请用 Edge / Chrome」', sbxHome.includes('这个浏览器不能直接读写本机文件夹') && sbxHome.includes('导入作品文件夹'), sbxHome.slice(0, 100))
  check('降级：代价写在明面上（不是只报喜）', sbxHome.includes('这样做的代价'), sbxHome.slice(0, 120))
  // 代价三条收在 <details> 里（不展开时 innerText 取不到），所以这里真的把它展开来看
  await page.evaluate("const d = document.querySelector('.degrade-box details'); if (d) d.open = true; return true")
  await sleep(150)
  const sbxHomeOpen = await page.text()
  check('降级：展开后能看到三条硬限制', /磁盘不是实时同步/.test(sbxHomeOpen) && /表达不了「删除」/.test(sbxHomeOpen) && /素材留在原地/.test(sbxHomeOpen), sbxHomeOpen.slice(-260))
  check('降级：直接读写文件夹的入口收起来了（留着也点不通）', !sbxHome.includes('打开已有作品'), sbxHome.slice(0, 200))
  await shot(page, '21-sandbox-home.png')

  const chip = () => page.evaluate("return document.querySelector('.bar .tag.sbx')?.innerText.trim() || ''")

  // 新建：连 FSA 都没有，自然不该弹目录选择器（真弹出来这里会一直等下去）
  await page.clickByText('.degrade-box button', '新建作品（沙盒）')
  await page.waitFor("document.querySelector('.create-sbx')", { label: '沙盒新建表单' })
  await page.evaluate("const i = document.querySelector('.create-sbx input'); i.focus(); i.select(); return true")
  await page.typeText(SBX_WORK)
  await page.clickByText('.create-sbx button', '创建并开始写')
  await page.waitFor("document.querySelector('.bar')", { timeout: 15000, label: '进入写作界面' })
  check('降级：不弹目录选择器也能新建作品', true)
  check('降级：顶栏立刻挂出沙盒标记', /沙盒 · 未导出 \d+/.test(await chip()), await chip())
  const opfsNow = await page.evaluate("return await window.__fs.walk('')")
  check('降级：沙盒作品一个文件都没写进真实目录', !opfsNow.some((p) => p.includes(SBX_WORK)), JSON.stringify(opfsNow.slice(0, 6)))

  // 建章 + 写作 + 等自动保存：整套编辑体验不该因为降级打折扣
  await page.evaluate("const i = document.querySelector('.blank-start .first-input'); i.focus(); return true")
  await page.typeText(CH_TITLE)
  await page.clickByText('.blank-start button', '新建第一章')
  await page.waitFor("document.querySelector('.ProseMirror')", { timeout: 10000, label: '编辑器挂载' })
  await page.evaluate("document.querySelector('.ProseMirror').focus(); return true")
  await page.typeText(SBX_LINE)
  await page.waitFor("document.querySelector('.save')?.textContent.includes('已保存')", { timeout: 8000, label: '自动保存' })
  check('降级：编辑器与自动保存照常（「已保存」指的是浏览器里）', true)
  const opfsAfterWrite = await page.evaluate("return await window.__fs.walk('')")
  check('降级：磁盘上依旧什么都没有 —— 自动保存 ≠ 落盘', !opfsAfterWrite.some((p) => p.includes(SBX_WORK)), JSON.stringify(opfsAfterWrite.slice(0, 6)))
  await shot(page, '22-sandbox-writing.png')

  // 导出：真的把 zip 下载下来，解开看条目名
  const sbxDir = join(FIXTURES, 'sandbox-dl')
  await page.allowDownloads(sbxDir)
  await page.click('.bar .tag.sbx')
  await page.waitFor("document.querySelector('.dialog.sbx')", { label: '沙盒面板打开' })
  const sbxPanel = await page.evaluate("return document.querySelector('.dialog.sbx')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('降级：面板第一句就说清「只有导出才落盘」', sbxPanel.includes('只有点了下面的导出'), sbxPanel.slice(0, 90))
  check('降级：面板列出「与磁盘不一样」的文件', /正文\/第001章/.test(sbxPanel), sbxPanel.slice(0, 200))
  await shot(page, '23-sandbox-panel.png')

  await page.clickByTextLike('.dialog.sbx button', '导出全部')
  const sbxZip = await page.waitForDownload(sbxDir, /沙盒导出-全量.*\.zip$/)
  const szBuf = readFileSync(sbxZip)
  check('降级：导出包落到了磁盘', szBuf.length > 400, `${szBuf.length} 字节：${sbxZip.split(/[\\/]/).pop()}`)
  check('降级：导出的是合法 zip', szBuf[0] === 0x50 && szBuf[1] === 0x4b)
  const hasS = (s) => szBuf.includes(Buffer.from(s, 'utf8'))
  check('降级：zip 里的条目名就是作品内的相对路径', hasS('正文/第001章 启程.md'), '')
  check('降级：zip 里带了「解开之后怎么用」的说明与清单', hasS('沙盒导出说明.md') && hasS('沙盒导出信息.json'))
  check('降级：导出后顶栏变成「已同步」', (await chip()).includes('已同步'), await chip())
  await page.click('.dialog.sbx .head .btn-icon')
  await sleep(300)
  check('降级：沙盒面板能关掉', !(await page.evaluate("return !!document.querySelector('.dialog.sbx')")))

  // 刷新：内存镜像存了 IndexedDB，所以「浏览器里那份」要自己回来（不靠任何授权）
  const idbMirror = await page.evaluate(`
    return await new Promise((res) => {
      const q = indexedDB.open('writer-sandbox', 1)
      q.onerror = () => res('open-error')
      q.onsuccess = () => {
        const db = q.result
        if (!db.objectStoreNames.contains('state')) return res('no-store')
        const r = db.transaction('state', 'readonly').objectStore('state').get('current')
        r.onsuccess = () => res(r.result ? 'saved:' + r.result.roots[0].files.length + ':' + r.result.meta.name : 'empty')
        r.onerror = () => res('get-error')
      }
    })
  `)
  check('降级：内存镜像已经落进 IndexedDB（刷新后才拿得回来）', /^saved:/.test(idbMirror), idbMirror)
  const recentTop = await page.evaluate("return JSON.parse(localStorage.getItem('writer.settings.v1') || '{}')?.recent?.[0]?.refId || ''")
  check('降级：最近作品记的是沙盒 id（下次打开才知道该恢复它）', recentTop.startsWith('mem:'), recentTop)

  await page.reload(2600)
  const sbxReload = await page.text()
  const backInSbx = await page.evaluate("return !!document.querySelector('.bar')")
  check('降级：刷新后自动回到沙盒作品（不用重新导入）', backInSbx && !sbxReload.includes('导入作品文件夹'), sbxReload.slice(0, 120))
  const pmSbx = await page.evaluate("return document.querySelector('.ProseMirror')?.innerText || ''")
  check('降级：刷新后正文没丢（内存镜像落过 IndexedDB）', pmSbx.includes(SBX_LINE), JSON.stringify(pmSbx.slice(0, 60)))
  check('降级：回来时标记仍是「已同步」', (await chip()).includes('已同步'), await chip())
  await shot(page, '24-sandbox-after-reload.png')

  /* ---------- 7.11 窄窗口：顶栏自适应 ---------- */
  section('7.11 窄窗口顶栏：三档密度（缩间距 / 收进菜单）+ 换行兜底')
  // 顶栏是按「1920 全屏正好放得下全部工具」排的。窗口一窄，`.right` 原先不收缩，
  // 十几个按钮整排被推到屏幕外 —— 看着就是「功能没了」。这段把这件事钉住：
  // 任何宽度下顶栏都不许溢出、不许矮到藏东西，动作要么在顶栏、要么在「更多」菜单里。
  const barProbe = () =>
    page.evaluate(`
      const bar = document.querySelector('.bar')
      const btns = Array.from(bar.querySelectorAll('button')).filter((b) => b.offsetParent !== null)
      const right = btns.length ? Math.max(...btns.map((b) => b.getBoundingClientRect().right)) : 0
      const more = bar.querySelector('.morebtn')
      return {
        vw: innerWidth,
        right: Math.round(right),
        density: bar.dataset.density,
        h: Math.round(bar.getBoundingClientRect().height),
        more: !!more && getComputedStyle(more).display !== 'none'
      }
    `)
  // 宽 → 窄逐档收紧（这正是作者把窗口拖小时走的那条路）
  const rank = { full: 0, compact: 1, mini: 2 }
  const seen = []
  for (const w of [1600, 1440, 1280, 1100, 980, 880]) {
    await page.setViewport(w, 900)
    await sleep(420)
    const fit = await barProbe()
    seen.push(fit)
    check(`窄窗口 ${w}px：顶栏不溢出（最右按钮完整落在视口内）`, fit.right <= fit.vw, JSON.stringify(fit))
    check(`窄窗口 ${w}px：顶栏不散架（最多两行）`, fit.h <= 96, JSON.stringify(fit))
    if (w === 1280) await shot(page, '30-narrow-bar-two-row.png')
  }
  check(
    '窗口越窄密度只降不升（不会在两档之间来回横跳）',
    seen.every((f, i) => i === 0 || rank[f.density] >= rank[seen[i - 1].density]),
    seen.map((f) => `${f.vw}:${f.density}`).join(' ')
  )
  check(
    '1600px：一条放得下就只占一条（不许白白多占一行）',
    seen[0].h <= 60,
    `${seen[0].vw}: ${seen[0].density} / ${seen[0].h}px`
  )
  // 「两行」是可接受的退让（作者要的就是这个）：前提是按钮全都完整可见，
  // 而不是像以前那样被推出屏幕 —— 那样看着就是「功能没了」。
  const twoRow = seen.find((f) => f.h > 60)
  check(
    '放不下时退回两行（工具栏独占第二行、按钮完整可见），而不是把按钮推出屏幕',
    !twoRow || (twoRow.right <= twoRow.vw && twoRow.h <= 96),
    twoRow ? JSON.stringify(twoRow) : '测过的宽度都是单行'
  )
  check(
    '两行时不动用「更多」菜单（入口只在更窄、真的放不下的档位才出现）',
    !twoRow || !twoRow.more,
    twoRow ? JSON.stringify(twoRow) : '—'
  )

  // 最窄那档：动作进菜单，但一个都不能少（到这一步连两行都排不下工具栏了）
  await page.setViewport(620, 900)
  await sleep(420)
  const narrow = await barProbe()
  check('窄窗口：右区让位后露出「更多」入口', narrow.more && narrow.density === 'mini', JSON.stringify(narrow))
  await page.click('.bar .morebtn')
  await page.waitFor("document.querySelector('.more-menu')", { label: '窄窗口下的更多菜单' })
  await shot(page, '31-narrow-bar-mini-menu.png')
  const narrowAll = await page.evaluate(`
    const bar = document.querySelector('.bar')
    const menu = document.querySelector('.more-menu')
    const top = Array.from(bar.querySelectorAll('button')).filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()).join('/')
    return top + '/' + (menu ? menu.innerText.replace(/\\s+/g, '') : '')
  `)
  check(
    '窄窗口：宽屏顶栏能做的动作，这里一个不少（顶栏 + 菜单里都找得到）',
    ['大纲', '导出', '快照', '导入稿件', '导入大纲', '参考面板', '设置', '专注写作', '关闭作品', 'AI 助手', '资料面板', '快捷键一览', '写作', '看板', '统计'].every(
      (t) => narrowAll.includes(t)
    ),
    narrowAll.slice(0, 220)
  )
  // 菜单别长到要滚动 —— 那等于把「关闭作品」这类末尾项换个地方藏起来（同一个毛病）
  const mmFit = await page.evaluate(`
    const m = document.querySelector('.more-menu')
    return { sh: m.scrollHeight, ch: m.clientHeight }
  `)
  check('窄窗口：菜单一屏放得下，不用滚动去找末尾的动作', mmFit.sh <= mmFit.ch + 4, JSON.stringify(mmFit))

  // 从菜单里真点一个：证明这些入口不是「看得见点不着」
  await page.clickByText('.more-menu button', '导出')
  await page.waitFor("document.querySelector('.dialog')", { timeout: 5000, label: '从更多菜单打开导出面板' })
  check('窄窗口：菜单里的动作真的能执行（导出面板打开了）', true)
  await page.evaluate("const d = document.querySelector('.dialog'); const b = Array.from(d.querySelectorAll('button')).find((x) => x.textContent.trim() === '×'); if (b) b.click(); return true")
  await sleep(300)

  // 拉宽回去：密度自动升档，不留「菜单开着但入口已经没了」的残影
  await page.setViewport(1440, 900)
  await sleep(450)
  const wide = await barProbe()
  check('窗口拉宽：密度自动升回、顶栏仍不溢出', wide.density !== 'mini' && wide.right <= wide.vw, JSON.stringify(wide))
  check('窗口拉宽：窄档的「更多」入口自己收回去', !wide.more, JSON.stringify(wide))

  // 关闭作品：沙盒要一起退出（宿主装回去），并留在浏览器里等下次继续
  await page.clickByText('.right button', '关闭作品')
  await page.waitFor("document.querySelector('.home')", { timeout: 8000, label: '回到首页' })
  const homeAfterClose = await page.text()
  check('降级：关闭作品后回到首页', homeAfterClose.includes('墨栈写作台'))
  check('降级：首页给出「继续写」入口（浏览器里那份还在）', homeAfterClose.includes('浏览器里还存着上次的沙盒作品') && homeAfterClose.includes('继续写'), homeAfterClose.slice(0, 160))
  check('降级：入口上标明已同步（不会让人以为还有东西没导出）', /已同步/.test(homeAfterClose), homeAfterClose.slice(0, 200))
  await shot(page, '25-sandbox-closed.png')

  /* ---------- 7.12 手机适配（?mobile=1） ---------- */
  section('7.12 手机适配：安全区 · 底部工具条 · 抽屉 · 返回键 · 标点条')
  // `?mobile=1` 把界面切到手机版（跟 `?sandbox=1` 一个路子）。手机上长什么样、手势接没接上，
  // 桌面 Chrome 里都能照着验 —— 走的是同一套 Vue 分支、同一份 CSS、同一份手势代码。
  // 尺寸也真的改成手机尺寸：安全区/触摸目标这些只有真尺寸下才有意义。
  await page.setViewport(390, 844)

  // (a) 手机版首页
  await page.evaluate('localStorage.clear(); return true')
  await page.navigate(URL + '?mobile=1', { waitMs: 1600 })
  check(
    '手机：<html> 挂上 ua-mobile（样式与脚本共用这一个标记）',
    await page.evaluate("return document.documentElement.classList.contains('ua-mobile')")
  )
  const sab = await page.evaluate("return getComputedStyle(document.documentElement).getPropertyValue('--sab').trim()")
  check('手机：安全区变量已接线（env(safe-area-inset-*) 取得到值）', /^-?\d+(\.\d+)?px$/.test(sab), `--sab = ${sab || '（取不到）'}`)
  const mHome = await page.text()
  check('手机：首页换成作品库形态（桌面那套入口收起来）', mHome.includes('作品库') && !mHome.includes('打开已有作品'), mHome.slice(0, 160))
  await shot(page, '26-mobile-home.png')

  // (b) 手机版写作界面：底部工具条 + 两个抽屉
  await page.navigate(URL + '?mobile=1&sandbox=1', { waitMs: 1600 })
  await page.clickByText('.degrade-box button', '新建作品（沙盒）')
  await page.waitFor("document.querySelector('.create-sbx')", { label: '沙盒新建表单' })
  await page.evaluate("const i = document.querySelector('.create-sbx input'); i.focus(); i.select(); return true")
  await page.typeText(SBX_WORK)
  await page.clickByText('.create-sbx button', '创建并开始写')
  await page.waitFor("document.querySelector('.mobile-bar')", { timeout: 15000, label: '手机底部工具条' })
  const barLabels = await page.evaluate(
    "return Array.from(document.querySelectorAll('.mobile-bar button')).map((b) => b.textContent.trim()).join('/')"
  )
  check('手机：底部工具条给出五个拇指区动作', barLabels === '目录/大纲/撤销/保存/资料', barLabels)
  const barH = await page.evaluate("return Math.round(document.querySelector('.mobile-bar button').getBoundingClientRect().height)")
  check('手机：工具条按钮触摸目标 ≥ 44px', barH >= 44, `${barH}px`)
  check(
    '手机：两个侧栏默认收起（一进来就能写字，不被抽屉盖住）',
    await page.evaluate("return !document.querySelector('.tree') && !document.querySelector('.dock:not(.ref)')")
  )
  // 顶栏溢出这个坑不写断言就永远发现不了：按钮在屏幕外，看着像「没做适配」
  const barFit = await page.evaluate(`
    const bar = document.querySelector('.bar')
    const btns = Array.from(bar.querySelectorAll('button')).filter((b) => b.offsetParent !== null)
    const right = btns.length ? Math.max(...btns.map((b) => b.getBoundingClientRect().right)) : 0
    return { vw: innerWidth, right: Math.round(right), shown: btns.length }
  `)
  check('手机：顶栏不溢出（最右的按钮完整落在屏幕内）', barFit.right <= barFit.vw, JSON.stringify(barFit))
  await shot(page, '27-mobile-write.png')

  // 先建第一章：后面要测章节行的触摸目标，切回写作视图也要它才有编辑器
  await page.evaluate("const i = document.querySelector('.blank-start .first-input'); i.focus(); return true")
  await page.typeText(CH_TITLE)
  await page.clickByText('.blank-start button', '新建第一章')
  await page.waitFor("document.querySelector('.ProseMirror')", { timeout: 10000, label: '编辑器挂载' })

  // 「更多」菜单：顶栏让位的那些动作得真的能点到
  await page.clickByText('.bar button', '⋯')
  await page.waitFor("document.querySelector('.more-menu')", { label: '更多菜单打开' })
  const mmText = await page.evaluate("return document.querySelector('.more-menu')?.innerText.replace(/\\s+/g, ' ') || ''")
  check(
    '手机：更多菜单收着被顶栏让位的动作（视图 / 导出 / 快照 / 导入 / 设置）',
    ['写作', '看板', '关系图', '导出', '快照', '导入稿件', '设置'].every((t) => mmText.includes(t)),
    mmText.slice(0, 140)
  )
  await page.clickByText('.more-menu button', '看板')
  await page.waitFor("document.querySelector('.board')", { timeout: 5000, label: '切到看板视图' })
  check('手机：从更多菜单切视图真的生效，菜单自己收起', !(await page.evaluate("return !!document.querySelector('.more-menu')")))
  await page.clickByText('.bar button', '⋯')
  await page.waitFor("document.querySelector('.more-menu')", { label: '再次打开更多菜单' })
  await page.clickByText('.more-menu button', '写作')
  await page.waitFor("document.querySelector('.ProseMirror')", { timeout: 5000, label: '切回写作视图' })

  // 抽屉 + 触摸目标
  await page.clickByText('.mobile-bar button', '目录')
  await page.waitFor("document.querySelector('.tree')", { label: '目录抽屉打开' })
  check('手机：目录是盖在稿纸上的抽屉，并挂出遮罩（点别处可收起）', await page.evaluate("return !!document.querySelector('.drawer-scrim')"))
  const chH = await page.evaluate("const el = document.querySelector('.tree .ch'); return el ? Math.round(el.getBoundingClientRect().height) : 0")
  check('手机：章节行的触摸目标 ≥ 44px', chH >= 44, `${chH}px`)
  await shot(page, '28-mobile-drawer.png')

  // 安卓返回键（WebView 里就是 history back）：应当先关抽屉，而不是退出写作
  await page.evaluate('history.back(); return true')
  await page.waitFor("!document.querySelector('.tree')", { timeout: 5000, label: '返回键收起抽屉' })
  check('手机：系统返回键先关抽屉（不退应用）', true)
  check('手机：抽屉收掉后遮罩也跟着没', await page.evaluate("return !document.querySelector('.drawer-scrim')"))

  // 边缘滑动：真的走一遍触摸输入管线（Input.dispatchTouchEvent），不是自己派发假事件
  const touch = async (x1, y1, x2, y2) => {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] })
    await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x2, y: y2 }] })
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(250)
  }
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await touch(8, 420, 150, 424)
  await page.waitFor("document.querySelector('.tree')", { timeout: 4000, label: '左边缘右滑拉开目录' })
  check('手机：左边缘右滑拉开目录（手势真的接上了）', true)
  // 收抽屉走遮罩：这里不该再动 history（返回键那条另有断言，掺在一起会互相干扰）
  await page.click('.drawer-scrim')
  await page.waitFor("!document.querySelector('.tree')", { timeout: 4000, label: '点遮罩收起目录' })
  check('手机：点抽屉外的遮罩能收起抽屉', true)

  // TEMP-DIAG4：在 document 捕获段再挂一层监听，区分「事件没进页面」和「手势没收到」
  await page.evaluate(
    "window.__touchLog = []; document.addEventListener('touchstart', (e) => { const t = e.touches[0]; window.__touchLog.push('ts@' + Math.round(t.clientX) + ',' + Math.round(t.clientY)) }, { capture: true, passive: true }); return true"
  )
  // 起点 x=370：仍在 28px 手势区里（390-28=362），但避开了 Chrome 触摸投递的
  // 右缘死区 —— 实测 x=382 的 touchStart 根本不会被送进页面（疑似模拟视口下
  // 右缘 ~8px 被滚动条/边缘区命中吃掉），而真机上系统返回手势也恰好把最外侧
  // 几像素让给了系统，用户实际就是从这条带起手的。
  await touch(370, 420, 240, 424)
  await page.waitFor("document.querySelector('.dock:not(.ref)')", { timeout: 4000, label: '右边缘左滑拉开资料面板' })
  check('手机：右边缘左滑拉开资料面板', true)
  await page.click('.drawer-scrim')
  await page.waitFor("!document.querySelector('.dock:not(.ref)')", { timeout: 4000, label: '点遮罩收起资料面板' })

  // 竖滑不参与：上下滚稿纸不该把抽屉拽出来
  await touch(20, 200, 26, 520)
  await sleep(250)
  check(
    '手机：竖滑不触发抽屉（上下滚稿纸不会误开）',
    await page.evaluate("return !document.querySelector('.tree') && !document.querySelector('.dock:not(.ref)')")
  )

  // 软键盘：把窗口高度缩掉一大截，键盘探测应当认出「键盘弹起来了」
  await page.setViewport(390, 380)
  await page.waitFor("document.querySelector('.mobile-bar.keys')", { timeout: 5000, label: '键盘上方的标点条' })
  const punct = await page.evaluate(
    "return Array.from(document.querySelectorAll('.mobile-bar.keys button')).map((b) => b.textContent.trim()).join(' ')"
  )
  check('手机：键盘弹起时工具条变成标点条（「」——……）', punct.includes('「」') && punct.includes('——') && punct.includes('……'), punct)
  const barBottom = await page.evaluate("return parseFloat(getComputedStyle(document.querySelector('.mobile-bar')).bottom) || 0")
  check('手机：标点条贴在键盘上沿（bottom = 量出来的键盘高度）', barBottom > 80, `bottom = ${barBottom}px`)
  await shot(page, '29-mobile-keyboard.png')
  await page.setViewport(390, 844)
  await page.waitFor("!document.querySelector('.mobile-bar.keys')", { timeout: 5000, label: '键盘收起后回到导航条' })
  check('手机：键盘收起后工具条回到导航形态', true)

  /* ---------- 7.13 切换动效 + 全局视图在手机上的重排 ---------- */
  section('7.13 切换动效（推入 / 抽屉 / 页签）与全局视图的手机重排')
  /* 过渡类只在两三百毫秒内存在，靠 evaluate 抢时机不可靠 ——
     在页面里挂一个 MutationObserver 守着，切完再回来取记录。
     顺带记下「同一时刻 .main 下有几个直接子元素」：左右推入要求新旧两份**同时在场上**，
     否则动画会退化成「先空一下再出现」，而这在肉眼上跟没做动画几乎分不出来。 */
  const armFx = () =>
    page.evaluate(`
      window.__fx = []
      window.__fxMax = 0
      if (window.__fxMo) window.__fxMo.disconnect()
      const push = (el) => {
        if (!el || el.nodeType !== 1 || !el.classList) return
        for (const c of el.classList) if (/^(vp|drawer|dock|scrim)-/.test(c)) window.__fx.push(c)
      }
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          push(m.target)
          for (const n of m.addedNodes || []) push(n)
        }
        const main = document.querySelector('.main')
        if (main) window.__fxMax = Math.max(window.__fxMax, main.children.length)
      })
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
      window.__fxMo = mo
      return true
    `)
  const readFx = () => page.evaluate('return { fx: window.__fx, max: window.__fxMax }')
  // 手机上切视图只能走顶栏的「⋯」菜单（视图按钮被顶栏让位收进去了）
  const switchView = async (label, sel) => {
    await page.clickByText('.bar button', '⋯')
    await page.waitFor("document.querySelector('.more-menu')", { timeout: 5000, label: `更多菜单 → ${label}` })
    await page.clickByText('.more-menu button', label)
    await page.waitFor(`document.querySelector(${JSON.stringify(sel)})`, { timeout: 8000, label: `切到${label}` })
    await sleep(460)
  }

  // (a) 往后翻：写作 → 看板，新页应当从右边推进来
  await armFx()
  await switchView('看板', '.board')
  const fxFwd = await readFx()
  check(
    '动效：往后翻（写作→看板）走「从右推入」这一组（vp-left）',
    fxFwd.fx.includes('vp-left-enter-active') && fxFwd.fx.includes('vp-left-leave-active'),
    fxFwd.fx.join(',') || '（一个过渡类都没挂上 = 硬切）'
  )
  check('动效：推入时新旧两份同时在场上，不是先空一下再出现', fxFwd.max >= 2, `同时在场 ${fxFwd.max} 个`)
  await shot(page, '30-mobile-board.png')

  // (b) 看板：桌面是五列横排，390px 上会挤成一条缝 —— 手机上要改成单列纵向
  const bd = await page.evaluate(`return (() => {
    const cols = document.querySelector('.board .cols')
    const col = document.querySelector('.board .col')
    if (!cols || !col) return null
    return {
      dir: getComputedStyle(cols).flexDirection,
      colsW: Math.round(cols.getBoundingClientRect().width),
      colW: Math.round(col.getBoundingClientRect().width),
      moveBtns: document.querySelectorAll('.board .move-btn').length
    }
  })()`)
  check('手机：看板五列横排改成单列纵向（滚动方向只留上下）', !!bd && bd.dir === 'column', `flex-direction: ${bd && bd.dir}`)
  check('手机：看板每列撑满屏宽，不再被挤成一条缝', !!bd && bd.colW >= bd.colsW - 24, bd ? `${bd.colW} / ${bd.colsW}` : '没有列')
  check('手机：卡片给出「移到…」入口（触摸屏没有 HTML5 拖放，桌面那套拖拽根本不触发）', !!bd && bd.moveBtns >= 1, `move-btn × ${bd && bd.moveBtns}`)

  // (c) 「移到…」真的改得动状态 —— 触摸设备上这是**唯一**的改法
  const stCur = await page.evaluate(`return (() => {
    const c = document.querySelector('.board .card')
    const h = c && c.closest('.col') && c.closest('.col').querySelector('.col-head b')
    return h ? h.textContent.trim() : ''
  })()`)
  const stNext = stCur === '已定稿' ? '待写' : '已定稿'
  await page.click('.board .move-btn')
  await page.waitFor("document.querySelector('.board .moves')", { timeout: 4000, label: '「移到…」展开' })
  check(
    '手机：「移到…」展开成一排够高的状态按钮',
    await page.evaluate(`return (() => {
      const b = document.querySelector('.board .moves button')
      return !!b && b.getBoundingClientRect().height >= 44 && document.querySelectorAll('.board .moves button').length >= 4
    })()`)
  )
  await page.clickByText('.board .moves button', stNext)
  await sleep(500)
  const stNow = await page.evaluate(`return (() => {
    const c = document.querySelector('.board .card')
    const h = c && c.closest('.col') && c.closest('.col').querySelector('.col-head b')
    return h ? h.textContent.trim() : ''
  })()`)
  const stNotice = await page.evaluate("return (document.querySelector('.board .head .ok') || {}).textContent || ''")
  check('手机：点「移到…」真的改了章节状态（触摸设备上唯一的改法）', stNow === stNext && stCur !== stNext, `${stCur} → ${stNow}（期望 ${stNext}）`)
  check('手机：改完给了一句回执，不和桌面那条路径两样', stNotice.includes(stNext), stNotice || '（没有回执）')

  // (d) 往前翻：方向必须反过来
  await armFx()
  await switchView('写作', '.ProseMirror')
  const fxBack = await readFx()
  check(
    '动效：往前翻（看板→写作）方向反过来（vp-right）',
    fxBack.fx.includes('vp-right-enter-active') && !fxBack.fx.includes('vp-left-enter-active'),
    fxBack.fx.join(',') || '（没挂过渡类）'
  )

  // (e) 左抽屉 + 遮罩
  await armFx()
  await page.clickByText('.mobile-bar button', '目录')
  await page.waitFor("document.querySelector('.tree')", { label: '目录抽屉' })
  await sleep(420)
  const fxDrawer = await readFx()
  check(
    '动效：目录从左边滑出来（drawer-l），遮罩同时淡入（scrim）',
    fxDrawer.fx.includes('drawer-l-enter-active') && fxDrawer.fx.includes('scrim-enter-active'),
    fxDrawer.fx.join(',') || '（没挂过渡类）'
  )
  await page.click('.drawer-scrim')
  await page.waitFor("!document.querySelector('.tree')", { timeout: 4000, label: '收起目录' })
  await sleep(420)
  const fxDrawerOut = await readFx()
  check(
    '动效：收起时也是滑出去（不是直接消失）',
    fxDrawerOut.fx.includes('drawer-l-leave-active'),
    fxDrawerOut.fx.join(',') || '（没挂离场过渡）'
  )

  // (f) 右侧页签
  await page.clickByText('.mobile-bar button', '资料')
  await page.waitFor("document.querySelector('.dock .tabs')", { label: '资料面板' })
  const dockTabs = await page.evaluate("return Array.from(document.querySelectorAll('.dock .tabs button')).map((b) => b.textContent.trim())")
  const tabH = await page.evaluate("return Math.round(document.querySelector('.dock .tabs button').getBoundingClientRect().height)")
  check('手机：资料面板的页签点得到（≥2 个）且触摸目标 ≥ 36px', dockTabs.length >= 2 && tabH >= 36, `${dockTabs.length} 个 / ${tabH}px`)
  await armFx()
  await page.clickByText('.dock .tabs button', dockTabs[1])
  await sleep(420)
  const fxDock = await readFx()
  check('动效：切右侧页签走淡入横移（dock-*），不是硬切', fxDock.fx.some((c) => c.startsWith('dock-')), fxDock.fx.join(',') || '（没挂过渡类）')

  // (g) 其余三个全局视图的重排。
  //     这一节只验**布局**：降级沙盒的作品存在 IndexedDB 里（`writer-sandbox`），
  //     不经过 OPFS，所以没法像 5.1 那样绕过界面往「设定/」里塞条目 —— 沙盒的关系图
  //     是没有节点的。`.stage` / `.side` 都是无条件渲染的，布局照样量得到。
  //     （节点拖动本身在 5.1 用真鼠标验过了，那条路径和手机上走的是同一套 Pointer Events；
  //       手机专属的那条 `touch-action: none` 是纯 CSS 声明，交给 selfcheck 的源码闸门。）
  await switchView('关系图', '.graph')
  const gp = await page.evaluate(`return (() => {
    const side = document.querySelector('.graph .side')
    const stage = document.querySelector('.graph .stage')
    const root = document.querySelector('.graph')
    if (!side || !stage || !root) return null
    return {
      sideW: Math.round(side.getBoundingClientRect().width),
      bodyW: Math.round(root.getBoundingClientRect().width),
      stageH: Math.round(stage.getBoundingClientRect().height)
    }
  })()`)
  check('手机：关系图详情栏撑满整行（不再是贴底那条 210px 窄栏）', !!gp && gp.sideW >= gp.bodyW - 24, gp ? `${gp.sideW} / ${gp.bodyW}` : '没有详情栏')
  check('手机：画布留出足够高度（不会被详情栏挤成一条）', !!gp && gp.stageH >= 200, gp ? `${gp.stageH}px` : '没有画布')
  // 桌面版那句「拖动圆点可摆位置」在手机上是**用不了的说明**（触摸没有 hover/鼠标拖），
  // 这类「文案还停在电脑上」的痕迹正是这一节要抓的东西之一
  check('手机：关系图的说明改成手指的说法（「按住圆点拖动」）', (await page.text()).includes('按住圆点拖动可摆位置'))
  await shot(page, '31-mobile-graph.png')

  await switchView('时间线', '.tl')
  const tlDir = await page.evaluate("return getComputedStyle(document.querySelector('.tl .body')).flexDirection")
  const tlSideW = await page.evaluate(`return (() => {
    const s = document.querySelector('.tl .side'), b = document.querySelector('.tl')
    return s && b ? Math.round(s.getBoundingClientRect().width) + '/' + Math.round(b.getBoundingClientRect().width) : ''
  })()`)
  check('手机：时间线右侧矛盾栏挪到底下（改成上下两段）', tlDir === 'column', `flex-direction: ${tlDir}`)
  check('手机：矛盾栏撑满整行，不再把事件流挤成一条缝', (() => {
    const [w, b] = String(tlSideW).split('/').map(Number)
    return w > 0 && b > 0 && w >= b - 24
  })(), tlSideW)

  await switchView('统计', '.stats')
  const st2 = await page.evaluate(`return (() => {
    const two = document.querySelector('.stats .two')
    return {
      cols: getComputedStyle(two).gridTemplateColumns,
      w: Math.round(document.querySelector('.stats .scroll').getBoundingClientRect().width)
    }
  })()`)
  check('手机：统计的固定两列改成单列（390px 上每列只有 ~180px，数字会换行）', st2.cols.split(' ').filter(Boolean).length === 1, `${st2.cols}（滚动区宽 ${st2.w}）`)
  await shot(page, '32-mobile-stats.png')

  // 第 8 节要回到写作视图，别把这一段的状态带过去
  await switchView('写作', '.ProseMirror')

  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 })
  await page.setViewport(1440, 900)

  /* ---------- 7.13 大纲：规模自己定 + 中文标签与想法 ---------- */
  section('7.13 大纲：卷数/章数自己定 · 导入后自动填 · 中文标签与想法')

  const openOutlineDlg = async () => {
    await page.clickByText('.bar button', '大纲')
    await page.waitFor("document.querySelector('.dialog .shape')", { timeout: 8000, label: '大纲对话框（规模区）' })
  }
  const closeDlg = async () => {
    await page.click('.dialog > .head .btn-icon')
    await page.waitFor("!document.querySelector('.dialog')", { timeout: 5000, label: '对话框关闭' })
  }
  const odlgText = () => page.evaluate("return document.querySelector('.dialog')?.innerText.replace(/\\s+/g, ' ') || ''")
  const shapeVals = () =>
    page.evaluate("return Array.from(document.querySelectorAll('.dialog .shape input')).map((i) => i.value).join('/')")
  const setShape = (idx, val) =>
    page.evaluate(`
      const ins = Array.from(document.querySelectorAll('.dialog .shape input'))
      const el = ins[${idx}]
      el.focus()
      el.value = ${JSON.stringify(String(val))}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    `)

  await openOutlineDlg()
  check(
    '大纲：规模是三个输入框（卷数 / 章数 / 每章字数），不是一段算好给人看的文字',
    (await page.evaluate("return document.querySelectorAll('.dialog .shape input').length")) === 3,
    await shapeVals()
  )
  const t1 = await odlgText()
  check('大纲：没有「共 N 卷 · M 章」那种自动算出来的行（没导入大纲时它最没意义）', !/共\s*\d+\s*卷/.test(t1), t1.slice(0, 200))
  await shot(page, '33-outline-shape.png')

  await setShape(1, 12)
  await sleep(220)
  const t2 = await odlgText()
  check('大纲：章数改成 12，预览跟着重排（4 卷 × 3 章）', /第1章-第3章/.test(t2) && /第10章-第12章/.test(t2), t2.slice(0, 220))

  // 用现有大纲：粘进去 → 卷数/章数**按大纲自动填好**，作者照样能改
  await page.clickByText('.dialog .row.small button', '用现有大纲')
  await sleep(180)
  const OUTLINE2 = [
    '# 林晚的雨季',
    '',
    '## 第一卷 启程（第1章-第3章）',
    '',
    '| 章节 | 目标 | 字数 |',
    '| --- | --- | --- |',
    '| 第001章 | 甲 | 3000 |',
    '| 第002章 | 乙 | 3000 |',
    '| 第003章 | 丙 | 3000 |',
    '',
    '## 第二卷 重逢（第4章-第5章）',
    '',
    '| 章节 | 目标 | 字数 |',
    '| --- | --- | --- |',
    '| 第004章 | 丁 | 3000 |',
    '| 第005章 | 戊 | 3000 |'
  ].join('\n')
  await page.evaluate(
    `const ta = document.querySelector('.dialog textarea'); ta.value = ${JSON.stringify(OUTLINE2)}; ta.dispatchEvent(new Event('input')); return true`
  )
  await sleep(260)
  check('大纲：粘进大纲后卷数/章数自动填成大纲的样子（2 卷 5 章）', (await shapeVals()) === '2/5/3000', await shapeVals())
  const t3 = await odlgText()
  check('大纲：预览照大纲原文显示（不均匀的分卷 3/2 不被抹平）', /第1章-第3章/.test(t3) && /第4章-第5章/.test(t3), t3.slice(0, 240))

  await setShape(1, 9)
  await setShape(0, 3)
  await sleep(260)
  const t4 = await odlgText()
  check('大纲：改卷数/章数后重排（3 卷 9 章，范围首尾相接）', /第1章-第3章/.test(t4) && /第7章-第9章/.test(t4), t4.slice(0, 240))
  await shot(page, '34-outline-reshape.png')
  await closeDlg()

  /* 配一套「假」AI 只为解锁 AI 入口（推荐页才会出现在界面上）。
     这里不点「测试连接」，也不点生成 —— 全程零网络请求，不会污染后面的控制台检查。
     注意：页面此刻还停在 §7.12 的 ?mobile=1 形态下（顶栏那些按钮是 `data-mobile="hide"`
     收起来的），所以这里用**直接点名点击**，不走「可见才算数」的那条路。 */
  await page.evaluate("const b = document.querySelector('.bar .aibtn'); if (!b) return false; b.click(); return true")
  await page.waitFor("document.querySelector('.dialog')", { timeout: 6000, label: '设置对话框' })
  await page.clickByText('.dialog .tabs button', 'AI')
  await sleep(150)
  const fillByPh = (ph, val) =>
    page.evaluate(`
      const el = document.querySelector('.dialog input[placeholder=${JSON.stringify(ph)}]')
      if (!el) return false
      el.focus()
      el.value = ${JSON.stringify(val)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    `)
  const okA = await fillByPh('https://api.deepseek.com', 'https://example.invalid/v1')
  const okB = await fillByPh('sk-...', 'sk-e2e-not-a-real-key')
  const okC = await fillByPh('deepseek-chat', 'e2e-model')
  // 「AI 层开关」默认是「关闭」，得把它拨到「启用」—— 这一档也是 aiEnabled() 的必要条件
  const okD = await page.evaluate(`
    const sel = Array.from(document.querySelectorAll('.dialog select')).find((s) =>
      Array.from(s.options).some((o) => (o.textContent || '').includes('AI 功能入口'))
    )
    if (!sel) return false
    sel.selectedIndex = 0
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  `)
  await sleep(150)
  check('设置：Base URL / Key / 模型名 / 开关都能配（只为解锁入口，不发请求）', okA && okB && okC && okD)
  check(
    '设置：填完就解锁 AI 层（不用重启）',
    await page.evaluate("return document.querySelector('.dialog')?.innerText.includes('AI 层已解锁')")
  )
  await closeDlg()

  await openOutlineDlg()
  await page.clickByText('.dialog .row.small button', 'AI 推荐')
  await sleep(220)
  const chipTexts = await page.evaluate(
    "return Array.from(document.querySelectorAll('.dialog .tchip')).map((b) => b.textContent.trim())"
  )
  check('AI 推荐：标签够多且分好组', chipTexts.length >= 40, `${chipTexts.length} 个`)
  check('AI 推荐：有男频 / 女频', chipTexts.includes('男频') && chipTexts.includes('女频'))
  check(
    'AI 推荐：有字数档（0-50 / 50-100 / 100-150 / 150-200 / 200 以上）',
    ['0-50万字', '50-100万字', '100-150万字', '150-200万字', '200万字以上'].every((t) => chipTexts.includes(t)),
    chipTexts.join('、').slice(0, 120)
  )
  check('AI 推荐：题材标签比原来多（都市 / 系统流 / 同人 / 克苏鲁 都在）', ['都市', '系统流', '同人', '克苏鲁'].every((t) => chipTexts.includes(t)))

  await page.clickByText('.dialog .tchip', '男频')
  await page.clickByText('.dialog .tchip', '玄幻')
  await page.evaluate(`
    const inp = Array.from(document.querySelectorAll('.dialog input')).find((i) => (i.placeholder || '').includes('都市异能'))
    inp.focus()
    inp.value = '都市异能、克苏鲁'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    const ta = document.querySelector('.dialog .idea')
    ta.focus()
    ta.value = '主角是个失业的修表匠，金手指是能听见钟表的心跳'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
  await sleep(240)
  const seenTags = await page.evaluate("return document.querySelector('.dialog .seen-tags')?.innerText.replace(/\\s+/g, ' ') || ''")
  check(
    'AI 推荐：点选 + 自定义标签都进了「AI 会看到」那一行（作者不用猜自己写的进没进去）',
    // 自定义输入是「都市异能、克苏鲁」：克苏鲁原样保留，都市异能被最长匹配切成 都市 + 异能
    ['男频', '玄幻', '都市', '异能', '克苏鲁'].every((t) => seenTags.includes(t)),
    seenTags
  )
  check('AI 推荐：想法是单独一栏，可写散句', await page.evaluate("return !!document.querySelector('.dialog .idea')"))

  // 中文分词：没打分隔符的一长串也要切得开（已知标签最长匹配兜底）
  await page.evaluate(`
    const inp = Array.from(document.querySelectorAll('.dialog input')).find((i) => (i.placeholder || '').includes('都市异能'))
    inp.value = '女频甜宠'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
  await sleep(220)
  const seenTags2 = await page.evaluate("return document.querySelector('.dialog .seen-tags')?.innerText.replace(/\\s+/g, ' ') || ''")
  check('AI 推荐：没打分隔符也切得开（女频甜宠 → 女频 + 甜宠）', seenTags2.includes('女频') && seenTags2.includes('甜宠'), seenTags2)

  await page.clickByText('.dialog .tchip', '100-150万字')
  await sleep(220)
  check(
    'AI 推荐：点「100-150万字」顺带把章数定好（125 万 ÷ 每章 3000 ≈ 417 章）',
    (await shapeVals()).split('/')[1] === '417',
    await shapeVals()
  )
  check(
    'AI 推荐：篇幅档的选中态是算出来的（跟着字数走，不另存一份状态）',
    await page.evaluate(
      `const b = Array.from(document.querySelectorAll('.dialog .tchip')).find((x) => x.textContent.trim() === '100-150万字'); return !!b && b.classList.contains('on')`
    )
  )
  await shot(page, '35-outline-tags.png')
  await closeDlg()

  /* ---------- 7.14 全界面扫一遍：还有没有别处的字被裁 ----------

     §7.7 已经在作者报错的那一屏量过了（下拉框被写死 26px → 「章」削成「音」）。
     这一节管的是**别处有没有同一个手滑**：每个视图、九个面板、五个弹窗的控件全量一遍。
     页面此刻还停在 §7.12 的 ?mobile=1 形态（输入框字号被顶到 16px）—— 那不是坏事：
     换一套字号还满足「内容盒 ≥ 一行字」，比只在一个字号下量过更值。 */
  section('7.14 全界面扫一遍：控件文字还有没有被裁的')
  note('    （本节停在手机样式下量，输入框 16px；作者看到的桌面那一屏已在 §7.7 量过）')

  // 别的地方也一起量一遍：这台机器上一个下拉框会出事，别处也可能是同一个手滑
  const SURFACES = [
    ['写作', async () => page.pressKey('1', { ctrl: true }), '.paper-col'],
    ['看板', async () => page.pressKey('2', { ctrl: true }), '.board'],
    ['统计', async () => page.pressKey('5', { ctrl: true }), '.stats']
  ]
  for (const [name, go, sel] of SURFACES) {
    await page.evaluate('document.body.focus(); return true')
    await go()
    await page.waitFor(`document.querySelector(${JSON.stringify(sel)})`, { timeout: 8000, label: name })
    await sleep(400)
    const bad = await scanControls()
    check(`「${name}」视图没有控件在削字 / 切字`, bad.length === 0, JSON.stringify(bad))
  }
  await page.evaluate('document.body.focus(); return true')
  await page.pressKey('1', { ctrl: true })
  await sleep(400)

  if (!(await page.evaluate("return !!document.querySelector('.dock')"))) {
    await page.pressKey('j', { ctrl: true })
  }
  await page.waitFor("document.querySelector('.dock')", { timeout: 8000, label: '右侧面板' })
  const tabs74 = await page.evaluate("return Array.from(document.querySelectorAll('.dock .tabs button')).map((b) => b.textContent.trim())")
  const badTabs = []
  for (const t of tabs74) {
    await page.clickByText('.dock .tabs button', t)
    await sleep(320)
    for (const b of await scanControls()) badTabs.push(t + ' → ' + JSON.stringify(b))
  }
  check(`九个面板都没有控件在削字 / 切字（查了 ${tabs74.length} 个）`, badTabs.length === 0, badTabs.slice(0, 3).join(' | '))

  const DIALOGS74 = [
    ['大纲', async () => page.clickByText('.bar button', '大纲')],
    ['导入大纲', async () => page.clickByText('.right button', '导入大纲')],
    ['导出', async () => page.clickByText('.right button', '导出')],
    ['快照', async () => page.clickByText('.right button', '快照')],
    ['设置', async () => page.clickByText('.right button', '设置')]
  ]
  const badDlgs = []
  for (const [name, open] of DIALOGS74) {
    await open()
    await sleep(700)
    for (const b of await scanControls()) badDlgs.push(name + ' → ' + JSON.stringify(b))
    await closeDlg()
  }
  check('五个弹窗都没有控件在削字 / 切字', badDlgs.length === 0, badDlgs.slice(0, 3).join(' | '))

  /* ---------- 7.15 候选区能删、换作品不留残影 ----------
     作者原话：「用 AI 续写后带有续写内容的窗口一直存在，不能删除内容以及窗口，
     切换作品还存在」。根因有两条，得分开验：
       ① 卡片上没有删除入口；
       ② aiState 是模块级 reactive，openWork / closeWork 都不碰它。
     这里不依赖真实 API：候选是内存里的数组，直接往里塞两张再验 UI 就行
     （fabricate 候选比等一次真网络稳定得多，验的是"删得掉吗"不是"生成得对吗"）。
     用 ?sandbox=1 起一个干净作品，免得依赖前面那些节留下的状态。 */
  section('7.15 候选区删除与换作品清理')
  {
    await page.evaluate(`
      localStorage.clear()
      await new Promise((r) => { const q = indexedDB.deleteDatabase('writer-sandbox'); q.onsuccess = q.onerror = q.onblocked = () => r() })
      return true
    `)
    await page.navigate(URL + '?sandbox=1', { waitMs: 1600 })

    // 先把 AI 层打开（候选页签只在 AI 启用后才出现），再建一个沙盒作品。
    //
    // 用 `engine: 'agent'` 而不是 api 档：`apiKey` 在 localStorage 里是**异或混淆过**的
    // （core/settings.ts 的 obfuscate），直接写明文 `'test'` 进去，读回来 deobfuscate
    // 出来是空串 → apiEnabled 判定为 false，候选页签根本不出现。
    // agent 档只要求 `configured: true`（DSH 自己管密钥），正好拿来验 UI。
    await page.evaluate(`
      const s = JSON.parse(localStorage.getItem('writer.settings.v1') || '{}')
      s.ai = Object.assign({}, s.ai, { configured: true, engine: 'agent', agentProfile: 'headless' })
      localStorage.setItem('writer.settings.v1', JSON.stringify(s))
      return true
    `)
    await page.send('Page.reload', { ignoreCache: true })
    await page.waitFor("document.querySelector('#app') && document.querySelector('#app').children.length > 0", {
      timeout: 20000,
      label: '重载出 AI 层'
    })
    await sleep(1200)

    // 建一个沙盒作品，好让右侧面板有得挂
    if (await page.evaluate("return !!document.querySelector('.degrade-box')")) {
      await page.clickByText('.degrade-box button', '新建作品（沙盒）')
      await page.waitFor("document.querySelector('.create-sbx')", { label: '沙盒新建表单' })
      await page.evaluate("const i = document.querySelector('.create-sbx input'); i.focus(); i.select(); return true")
      await page.typeText('候选区删除测试')
      await page.clickByText('.create-sbx button', '创建并开始写')
      await page.waitFor("document.querySelector('.bar')", { timeout: 15000, label: '进入写作界面' })
    }

    // 打开右侧面板
    if (!(await page.evaluate("return !!document.querySelector('.dock')"))) {
      await page.pressKey('j', { ctrl: true })
      await sleep(600)
    }
    await page.waitFor("document.querySelector('.dock .tabs')", { timeout: 8000, label: '右侧面板页签' })

    const hasCandTab = await page.evaluate(
      "return Array.from(document.querySelectorAll('.dock .tabs button')).some((b) => /候选/.test(b.textContent))"
    )
    check('AI 层开启后候选页签出现', hasCandTab)

    if (hasCandTab) {
      await page.clickByText('.dock .tabs button', '候选')
      await sleep(500)
      const emptyText = await page.evaluate("return (document.querySelector('.cand') || {}).innerText || ''")
      check('没有候选时给出去哪生成的指引（不是一片空白）', /还没有候选|去「上下文」/.test(emptyText), emptyText.slice(0, 40))

      // 空态下不该有「清空」按钮 —— 没东西可清还摆个按钮，点了没反应更让人困惑
      const clearOnEmpty = await page.evaluate(
        "return Array.from(document.querySelectorAll('.cand button')).some((b) => b.textContent.trim() === '清空')"
      )
      check('候选为空时不显示「清空」按钮', !clearOnEmpty)

      // 候选为空时也不该有删除按钮
      const delOnEmpty = await page.evaluate(
        "return Array.from(document.querySelectorAll('.cand button')).some((b) => b.textContent.trim() === '删除')"
      )
      check('候选为空时不显示删除按钮', !delOnEmpty)

      /* 真塞两张候选进去，验「删得掉」这个行为本身。
         候选是模块级 reactive 数组，没法从外面直接写 —— 但开发模式下模块是
         挂在 `window.__writerDev` 上的（见 src/main.ts），拿它塞最稳。 */
      const injected = await page.evaluate(`
        const dev = window.__writerDev
        if (!dev || !dev.aiState) return false
        dev.aiState.candidates.length = 0
        dev.aiState.candidates.push(
          { id: 'c1', title: '续写 · Agent', text: '第一段候选内容，用来验证单张删除。', model: 'm', skill: '', createdAt: '2026-10-10 21:00:00', mode: 'continue', targetChapterId: '', tokens: 20 },
          { id: 'c2', title: '纠错 · Agent', text: '第二段候选内容，用来验证清空。', model: 'm', skill: '', createdAt: '2026-10-10 21:01:00', mode: 'polish', targetChapterId: '', tokens: 18 }
        )
        return true
      `)
      if (injected) {
        await sleep(400)
        const cardCount = () => page.evaluate("return document.querySelectorAll('.cand .item, .cand .card').length")
        check('两张候选都渲染出来了', (await cardCount()) >= 2, `现在 ${await cardCount()} 张`)

        // 单张删除：点第一张的删除入口
        const delBtn = await page.evaluate(
          "const btns = Array.from(document.querySelectorAll('.cand button')).filter((b) => b.textContent.trim() === '删除'); return btns.length"
        )
        check('候选卡片上有删除入口', delBtn >= 1, `找到 ${delBtn} 个`)

        if (delBtn >= 1) {
          await page.evaluate(
            "const b = Array.from(document.querySelectorAll('.cand button')).find((x) => x.textContent.trim() === '删除'); b.click(); return true"
          )
          await sleep(500)
          // 删除要过确认弹窗（askConfirm，不是 window.confirm）
          const dlg = await page.evaluate("return !!document.querySelector('.dlg, .dialog')")
          if (dlg) {
            await page.evaluate(
              "const b = Array.from(document.querySelectorAll('.dlg button, .dialog button')).find((x) => /删除|确定|确认/.test(x.textContent)); if (b) b.click(); return true"
            )
            await sleep(500)
          }
          check('删一张后只剩一张', (await cardCount()) === 1, `现在 ${await cardCount()} 张`)
        }

        // 清空：点「清空」按钮 → 确认 → 回到空态
        const clearBtn = await page.evaluate(
          "const b = Array.from(document.querySelectorAll('.cand button')).find((x) => x.textContent.trim() === '清空'); if (b) { b.click(); return true } return false"
        )
        if (clearBtn) {
          await sleep(500)
          await page.evaluate(
            "const b = Array.from(document.querySelectorAll('.dlg button, .dialog button')).find((x) => /清空|确定|确认|删除/.test(x.textContent)); if (b) b.click(); return true"
          )
          await sleep(500)
          check('清空后候选区回到空态', (await cardCount()) === 0, `现在 ${await cardCount()} 张`)
        } else {
          check('候选区有「清空」入口', false, '没找到「清空」按钮')
        }
      } else {
        note('    （拿不到 __writerDev，跳过「删得掉」的行为验证；源码闸门在 selfcheck §52）')
      }
    }
  }

  /* ---------- 7.16 AI 生成设定：界面要摊开「AI 实际会看到什么」 ----------
     作者的要求是「AI 推荐世界观和人物设定，**综合大纲和作品标签**」。
     功能本身要发网络请求，这里不验「生成得对不对」（那靠 selfcheck 的提示词断言），
     只验**界面有没有如实把输入摊开** —— 这个项目栽过的坑就是「界面上说带上了、
     实际传了个空串」，所以必须让作者能自己看见大纲文件名、字数和标签串。 */
  section('7.16 AI 生成设定面板把输入摊开')
  {
    // 接着 7.15 的沙盒作品用（此时已开 AI 层、有作品、有右侧面板）
    const hasDock = await page.evaluate("return !!document.querySelector('.dock')")
    if (!hasDock) {
      await page.pressKey('j', { ctrl: true })
      await sleep(600)
    }
    const ok = await page.evaluate(`
      const b = Array.from(document.querySelectorAll('.dock .tabs button')).find((x) => /设定/.test(x.textContent))
      if (!b) return false
      b.click()
      return true
    `)
    if (!ok) {
      note('    （没找到「设定」页签，跳过本节）')
    } else {
      await sleep(700)
      const entry = await page.evaluate(`
        const b = Array.from(document.querySelectorAll('.codex button')).find((x) => /让 AI 生成设定/.test(x.textContent))
        if (!b) return false
        b.click()
        return true
      `)
      check('设定面板有「让 AI 生成设定」入口', entry)

      if (entry) {
        // loadOutline 是异步的（要 listDir + readFile），「读取中…」是它的第一帧状态。
        // 等它落到终态再断言，不然测的是「还没读完」那一瞬间。
        await page.waitFor(
          "(() => { const s = document.querySelector('.codex .seen'); if (!s) return false; return !/读取中/.test(s.innerText) })()",
          { timeout: 8000, label: '大纲读取完成' }
        ).catch(() => note('    （大纲状态停在「读取中…」超过 8s）'))
        const seen = await page.evaluate("return (document.querySelector('.codex .seen') || {}).innerText || ''")
        // innerText 在 flex 行里不一定吐换行，所以按「标签」二字切一刀取后半段
        const flat = seen.replace(/\s+/g, ' ')
        check('摊开了输入来源（大纲 / 标签两行都在）', /大纲/.test(flat) && /标签/.test(flat), flat.slice(0, 70))

        /* 这个沙盒作品建出来时带的是**空大纲模板**（新建作品会写 大纲/大纲.md），
           所以正常结果是「读到 大纲/大纲.md」。要是文件确实没有，报「还没读到大纲」
           也算如实 —— 不能接受的是停在「读取中…」。 */
        const outlineSeg = flat.split('标签')[0] || ''
        const honest = /大纲\/|还没读到大纲/.test(outlineSeg) && !/读取中/.test(outlineSeg)
        check('大纲那一行给出了实情（文件名，或明说没读到）', honest, outlineSeg.slice(0, 80))

        // 标签：这次没在大纲面板点过，就该明说「没选过」并指路，而不是默默留空
        const tagSeg = flat.split('标签')[1] || ''
        check('没选过标签时明说 + 指路（不是默默留空）', /没选过/.test(tagSeg) && /AI 推荐/.test(tagSeg), tagSeg.slice(0, 80))

        await shot(page, '08b-settings-ai.png')
      }
    }
  }

  /* ---------- 7.17 技能分类：五类页签 · 移动 · 隐藏 · AI 整理指令框 ----------
     作者的要求是「把技能分成大纲/设定/文本生成/记忆/文风五类，无关的全删，
     再加一个让 AI 按指令整理的框、能移动和删除」。
     这里不真发网络请求（那是 selfcheck 的提示词断言管的），只验**界面上这套真的能用**：
       - 分类页签点得动，点完里面的条目是对的；
       - 「移动」真的把技能挪到了另一类（不是下拉框变一下就完事）；
       - 内置/全局技能的删除是**隐藏**，拦一道确认，且能恢复；
       - AI 指令框在，默认已经替作者想好了第一句。
     接着 7.16 的沙盒作品跑（此时 AI 层已开、右侧面板已开）。 */
  section('7.17 技能分类：五类页签 · 移动 · 隐藏 · AI 指令框')
  {
    const hasSkillTab = await page.evaluate(
      "return Array.from(document.querySelectorAll('.dock .tabs button')).some((b) => /技能/.test(b.textContent))"
    )
    check('技能页签常驻（技能是作者的提示词资产，不联网也要能管）', hasSkillTab)

    if (hasSkillTab) {
      await page.clickByText('.dock .tabs button', '技能')
      await page.waitFor("document.querySelector('.sk')", { timeout: 8000, label: '技能面板' })
      await sleep(400)

      /* 分类页签 */
      const chips = await page.evaluate("return Array.from(document.querySelectorAll('.sk .chip')).map((b) => b.textContent.trim())")
      const flat = chips.join('|')
      check('⚠ 分类页签齐了（全部 + 大纲/设定/文本生成/记忆/文风）',
        /^全部/.test(chips[0] || '') && /大纲/.test(flat) && /设定/.test(flat) && /文本生成/.test(flat) && /记忆/.test(flat) && /文风/.test(flat),
        chips.join(' / '))
      check('页签上带数量（作者不用点进去数）', /\d/.test(flat), flat)

      const rows = () => page.evaluate("return Array.from(document.querySelectorAll('.sk .list .item')).map((d) => (d.querySelector('.nm') || {}).textContent || '')")

      /* 点「大纲」页签：里面应该只剩大纲类技能 */
      await page.evaluate("const b = Array.from(document.querySelectorAll('.sk .chip')).find((x) => /大纲/.test(x.textContent)); b.click(); return true")
      await sleep(400)
      const outlineRows = await rows()
      check('⚠ 点「大纲」页签，里面是「大纲拆分」（启发式没把它分错类）',
        outlineRows.length === 1 && /大纲拆分/.test(outlineRows[0]), outlineRows.join(','))

      /* 移动：把它挪到「设定」，它得真的从大纲页签消失、出现在设定页签 */
      const moved = await page.evaluate(`
        const sel = document.querySelector('.sk .list .item select')
        if (!sel) return false
        sel.value = 'setting'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      `)
      check('每条技能都有移动分类的下拉', moved)
      await sleep(600)
      const afterMove = await rows()
      check('⚠ 移动生效：挪到「设定」后从大纲页签消失（不是下拉框自嗨）', afterMove.length === 0, afterMove.join(','))

      await page.evaluate("const b = Array.from(document.querySelectorAll('.sk .chip')).find((x) => /设定/.test(x.textContent)); b.click(); return true")
      await sleep(500)
      const settingRows = await rows()
      check('⚠ 移动生效：它出现在「设定」页签里', settingRows.some((n) => /大纲拆分/.test(n)), settingRows.join(','))

      /* 隐藏：内置/全局技能走隐藏（不删别人的文件），拦确认，且可恢复 */
      await page.evaluate(`
        const b = Array.from(document.querySelectorAll('.sk .list .item button')).find((x) => /隐藏|删除/.test(x.textContent.trim()))
        if (!b) return false
        b.click()
        return true
      `)
      await sleep(500)
      const dlgShown = await page.evaluate("return !!document.querySelector('.dlg')")
      check('⚠ 隐藏/删除先拦一道应用内确认（不是 window.confirm，也不是直接动手）', dlgShown)
      if (dlgShown) {
        await page.evaluate("const b = Array.from(document.querySelectorAll('.dlg button')).find((x) => /隐藏|删除|确定|确认/.test(x.textContent)); if (b) b.click(); return true")
        await sleep(600)
      }
      const hiddenBox = await page.evaluate("return (document.querySelector('.sk .hidden-box') || {}).innerText || ''")
      check('⚠ 隐藏的技能进了「已隐藏的技能」，可恢复（不是单向操作）', /已隐藏的技能/.test(hiddenBox), hiddenBox.slice(0, 60))

      if (/已隐藏的技能/.test(hiddenBox)) {
        await page.evaluate("const d = document.querySelector('.sk .hidden-box'); if (!d.open) d.querySelector('summary').click(); return true")
        await sleep(300)
        const restored = await page.evaluate(`
          const b = Array.from(document.querySelectorAll('.sk .hidden-box button')).find((x) => /恢复/.test(x.textContent))
          if (!b) return false
          b.click()
          return true
        `)
        await sleep(600)
        const stillHidden = await page.evaluate("return !!document.querySelector('.sk .hidden-box')")
        check('恢复之后「已隐藏的技能」那一栏自己收起来', restored && !stillHidden)
      }

      /* AI 整理指令框 */
      const aiBtn = await page.evaluate("return Array.from(document.querySelectorAll('.sk .ai-box button')).some((b) => /让 AI 整理技能/.test(b.textContent))")
      check('⚠ 有「让 AI 整理技能」入口（作者下指令的框在这里）', aiBtn)
      if (aiBtn) {
        await page.evaluate("const b = Array.from(document.querySelectorAll('.sk .ai-box button')).find((x) => /让 AI 整理技能/.test(x.textContent)); b.click(); return true")
        await sleep(400)
        const box = await page.evaluate("return (document.querySelector('.sk .ai-box') || {}).innerText || ''")
        check('打开后有指令输入框', await page.evaluate("return !!document.querySelector('.sk .ai-box textarea')"))
        check('⚠ 默认指令已经替作者想好第一句（清掉无关技能）', /无关/.test(box), box.replace(/\s+/g, ' ').slice(0, 80))
        check('⚠ 明说「方案出来后由你勾选确认，不会直接动手」', /勾选确认|不会直接动手/.test(box))
        // 不点「让 AI 出方案」——那会真发网络请求，本节只验界面与本地行为
      }

      await shot(page, '08c-skill-cats.png')
    }
  }

  /* ---------- 7.18 长正文不出稿纸（「白气泡」bug 的回归闸门） ----------
     作者实报：AI 续写并采纳后，正文上浮着一块白色圆角「气泡」，跟着滚、能编辑、一直在。
     根因：.editor-scroll 是定高 flex 容器，稿纸 .paper-col 作为唯一 item 被默认的
     stretch 钉在容器高上，高度跟内容脱钩 —— 章节第一次超过一屏，ProseMirror 的内容
     就从稿纸底下画出去，稿纸的圆角投影只裹住前几行，后面的字漂在桌面底色上。
     修复是 .editor-scroll { align-items: flex-start }。这里灌 60 段让正文必然超一屏，
     断言稿纸始终裹住全部正文。 */
  section('7.18 长正文不出稿纸（白气泡 bug 回归闸门）')
  {
    // §7.15 建的沙盒作品可能还没有章，有起步入口就先建第一章
    if (await page.evaluate("return !!document.querySelector('.blank-start')")) {
      await page.evaluate(`
        const i = document.querySelector('.blank-start input')
        if (i) { i.focus(); i.select() }
        const b = Array.from(document.querySelectorAll('.blank-start button')).find((x) => /新建第一章/.test(x.textContent))
        if (b) b.click()
        return true
      `)
      await sleep(1200)
    }
    const long = Array.from({ length: 60 }, (_, i) => `第${i + 1}段：这是长正文验收段，用来确认稿纸能裹住全部内容。`).join('\n\n')
    await page.evaluate(`
      const pm = document.querySelector('.paper .ProseMirror') || document.querySelector('.paper')
      pm.focus()
      document.execCommand('insertText', false, ${JSON.stringify(long)})
      return true
    `)
    await sleep(900)
    const m = await page.evaluate(`
      const col = document.querySelector('.paper-col')
      const paper = document.querySelector('.paper')
      const sc = document.querySelector('.editor-scroll')
      if (!col || !paper || !sc) return null
      const cr = col.getBoundingClientRect()
      const pr = paper.getBoundingClientRect()
      return { colH: Math.round(cr.height), paperH: Math.round(pr.height), clientH: sc.clientHeight }
    `)
    check('⚠ 稿纸高度能跟着正文长（不是被 flex 钉在一屏高）', !!m && m.colH >= m.paperH - 2, JSON.stringify(m))
    check('⚠ 正文超过一屏时稿纸也超过一屏（内容全部还在纸上）', !!m && m.colH > m.clientH, JSON.stringify(m))
    await page.screenshot(join(SHOTS, '08d-long-body-paper.png'))
  }

  /* ---------- 7.19 中文引号 · 文风学习 · AI 指令对话框 ----------
     作者这三件事里，能被浏览器验的是「界面那条路走得通」：
       - 文风面板能粘文字存样本、样本能进列表、删之前拦一道（AI 归纳要点那一步要发请求，
         本节只验按钮按「有样本 + AI 已解锁」才亮，不真点）；
       - AI 指令对话框能从候选区打开、模式里有「扩写」、
         「动哪一段」那行真的给了一句人话（这是这个功能最怕翻车的地方）；
       - Esc 能关。
     引号那条是纯函数，行为断言在 selfcheck §60，浏览器这里不重复。
     接着 7.18 的长正文跑（正文 60 段，正好能验「扩写退化到本章最后一段」）。 */
  section('7.19 文风学习样本 · AI 指令对话框 · 扩写退化')
  {
    const hasDock = await page.evaluate("return !!document.querySelector('.dock')")
    if (!hasDock) {
      await page.pressKey('j', { ctrl: true })
      await sleep(600)
    }

    /* ---- 文风面板：粘一段存样本 ---- */
    await page.evaluate(`
      const b = Array.from(document.querySelectorAll('.dock .tabs button')).find((x) => /文风/.test(x.textContent))
      if (!b) return false
      b.click()
      return true
    `)
    await page.waitFor("document.querySelector('.st')", { timeout: 8000, label: '文风面板' })
    await sleep(400)

    const learnBox = await page.evaluate("return (document.querySelector('.st .learn') || {}).innerText || ''")
    const flatLearn = learnBox.replace(/\s+/g, ' ')
    check('⚠ 文风面板有「让 AI 学我的文风」这一块', /让 AI 学我的文风/.test(flatLearn), flatLearn.slice(0, 60))
    check('⚠ 明说样本存在作品目录的哪里（作者的目录是公开的）', /记忆\/文风样本/.test(flatLearn), flatLearn.slice(0, 80))
    check('⚠ 支持导入 docx / pdf / txt / md 四种', /\.docx \/ \.pdf \/ \.txt \/ \.md/.test(flatLearn))
    check('有粘贴文字的框（不想导文件时直接粘）', await page.evaluate("return !!document.querySelector('.st .learn .paste')"))

    const sample = '雨下了整夜。他站在檐下，没动。"进来吧。"屋里的人说。'
    const named = await page.evaluate(`
      const ta = document.querySelector('.st .learn .paste')
      const nm = document.querySelector('.st .learn .nm-input')
      if (!ta || !nm) return false
      const set = (el, v) => {
        el.focus()
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set(ta, ${JSON.stringify(sample)})
      set(nm, '旧稿·雨夜')
      return true
    `)
    check('样本名与粘贴框都能填', named)
    await sleep(200)
    await page.evaluate(`
      const b = Array.from(document.querySelectorAll('.st .learn button')).find((x) => /存为样本/.test(x.textContent))
      if (b) b.click()
      return true
    `)
    await page.waitFor("document.querySelector('.st .samples .srow')", { timeout: 8000, label: '样本进列表' })
    const srow = await page.evaluate("return (document.querySelector('.st .samples .srow') || {}).innerText || ''")
    check('⚠ 粘的文字真的存成了样本（列表里出现 + 带字数）', /旧稿/.test(srow) && /\d+\s*字/.test(srow), srow.replace(/\s+/g, ' '))

    /* 「让 AI 学」按钮：AI 层开着 + 有勾选，就该可点（不点，点了要发请求） */
    const canLearn = await page.evaluate(`
      const b = Array.from(document.querySelectorAll('.st .learn button')).find((x) => /让 AI 学/.test(x.textContent))
      return b ? !b.disabled : null
    `)
    check('⚠ 有样本且 AI 已解锁时「让 AI 学并出要点」可点（没样本时不该可点）', canLearn === true, String(canLearn))

    /* ---- 删样本：拦一道应用内确认，确认后真的从列表消失 ---- */
    await page.evaluate(`
      const b = document.querySelector('.st .samples .srow button')
      if (b) b.click()
      return true
    `)
    await sleep(450)
    const confirmShown = await page.evaluate(`
      const d = document.querySelector('.dlg')
      return d ? d.innerText.includes('旧稿') : false
    `)
    check('⚠ 删样本先摊开名单确认（那是作品目录里的真文件，不是内存里的一条记录）', confirmShown)
    if (confirmShown) {
      await page.evaluate(`
        const b = Array.from(document.querySelectorAll('.dlg button')).find((x) => /删除|确定|确认/.test(x.textContent))
        if (b) b.click()
        return true
      `)
      await sleep(700)
    }
    const gone = await page.evaluate("return !document.querySelector('.st .samples .srow')")
    check('确认之后样本真的从列表消失', gone)

    /* ---- AI 指令对话框 ---- */
    await page.evaluate(`
      const b = Array.from(document.querySelectorAll('.dock .tabs button')).find((x) => /候选/.test(x.textContent))
      if (!b) return false
      b.click()
      return true
    `)
    await sleep(500)
    const opened = await page.evaluate(`
      const b = Array.from(document.querySelectorAll('.dock button')).find((x) => /让 AI 写 \\/ 扩写/.test(x.textContent))
      if (!b) return false
      b.click()
      return true
    `)
    check('⚠ 候选区有「＋ 让 AI 写 / 扩写…」入口', opened)
    await page.waitFor(
      "Array.from(document.querySelectorAll('.dialog')).some((d) => /给 AI 下指令/.test(d.innerText))",
      { timeout: 8000, label: 'AI 指令对话框' }
    )

    const DIALOG = `
      Array.from(document.querySelectorAll('.dialog')).find((d) => /给 AI 下指令/.test(d.innerText))
    `
    const dlgTxt = await page.evaluate(`const d = ${DIALOG}; return d ? d.innerText : ''`)
    const flatDlg = dlgTxt.replace(/\s+/g, ' ')
    check('⚠ 指令框里有「扩写」（作者要的就是能下扩写指令）', /扩写/.test(flatDlg), flatDlg.slice(0, 90))
    check('⚠ 明写「动哪一段」，且给的是人话（不是空白 / 不是「undefined」）',
      /动哪一段/.test(flatDlg) && !/undefined|NaN/.test(flatDlg), flatDlg.slice(0, 120))
    check('有目标字数（「写得详细点」等于没说）', /目标字数/.test(flatDlg))
    check('⚠ 脚注重申「点了采纳才写进正文」（跟所有 AI 功能同一条铁律）', /点了采纳才会写进正文/.test(flatDlg))
    check('⚠ 大指令框够高（不是两行输入框）：8 行 textarea',
      await page.evaluate(`const d = ${DIALOG}; const t = d && d.querySelector('textarea.ins'); return !!t && t.rows >= 6`))

    /* 扩写：没有选区时要明说退化到本章最后一段 —— 这一屏正文有 60 段，必须给出字数 */
    await page.evaluate(`
      const d = ${DIALOG}
      const sel = d.querySelector('select.mode-sel')
      sel.value = 'expand'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    `)
    await sleep(350)
    const scope = await page.evaluate(`const d = ${DIALOG}; return (d.querySelector('.scope-box') || {}).innerText || ''`)
    check('⚠ 扩写没选区时说出来「将对本章最后一段扩写」并给字数（静默换目标是 bug）',
      /本章最后一段/.test(scope) && /\d+\s*字/.test(scope), scope.replace(/\s+/g, ' '))

    await page.pressKey('Escape')
    await sleep(400)
    check('Esc 能关掉指令框（不用去找×）',
      await page.evaluate(`return !Array.from(document.querySelectorAll('.dialog')).some((d) => /给 AI 下指令/.test(d.innerText))`))

    await page.screenshot(join(SHOTS, '08e-style-and-prompt.png'))
  }

  /* ---------- 8. 报错汇总 ---------- */
  section('8. 控制台与网络')
  const realErrors = page.consoleErrors.filter((e) => !/favicon/i.test(e))
  const realPageErrors = page.pageErrors.filter((e) => !/favicon/i.test(e))
  check('无未捕获的页面异常', realPageErrors.length === 0, realPageErrors.join(' ⏐ '))
  check('无控制台 error', realErrors.length === 0, realErrors.slice(0, 3).join(' ⏐ '))
  check('无失败的资源请求', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' ⏐ '))
  if (page.consoleWarns.length) {
    warnings.push(...page.consoleWarns)
    note('    控制台 warning（' + page.consoleWarns.length + ' 条，非阻断）：' + page.consoleWarns.slice(0, 4).join(' ⏐ '))
  }
  if (page.consoleErrors.length !== realErrors.length) note('    （已忽略 favicon 类资源告警）')

  await shot(page, '09-final.png')
} catch (e) {
  failures.push('脚本中断：' + (e?.message || e))
  console.error('\n脚本中断：', e)
  try {
    if (page) await shot(page, '99-crash.png')
  } catch {}
} finally {
  await browser.close()
}

/* ------------------------------------------------------------------ 汇总 */
console.log('\n' + '='.repeat(60))
if (failures.length === 0) {
  console.log(`真实浏览器验收：${pass} 项全部通过 ✅`)
} else {
  console.log(`真实浏览器验收：通过 ${pass} 项，失败 ${failures.length} 项 ❌`)
  for (const f of failures) console.log('  ✗ ' + f)
}
if (warnings.length) console.log(`（另有 ${warnings.length} 条控制台 warning，不阻断）`)
console.log(`截图目录：${SHOTS}`)
console.log(`报告：${join(SHOTS, 'report.txt')}`)
writeFileSync(
  join(SHOTS, 'report.txt'),
  [
    `时间：${new Date().toISOString()}`,
    `地址：${URL}`,
    `结果：通过 ${pass} 项，失败 ${failures.length} 项`,
    failures.length ? '\n失败项：\n' + failures.map((f) => '  - ' + f).join('\n') : '',
    warnings.length ? '\n控制台 warning：\n' + warnings.map((w) => '  - ' + w).join('\n') : '',
    '\n流程记录：\n' + log.join('\n')
  ].join('\n')
)
process.exit(failures.length === 0 ? 0 : 1)
