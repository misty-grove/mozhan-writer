/**
 * 面板渲染冒烟（本机没有可用浏览器时，用 jsdom 验证组件能否真的挂载、取值、不报错）
 *
 * 流程：内存 FS 里造一部作品 → 灌进 stores → 逐个挂载 P1 的新面板 → 检查渲染结果与数据流。
 * 由 scripts/smoke-panels.mjs 调用（先搭 jsdom 环境，再 import 打包产物）。
 */
import { createApp, nextTick } from 'vue'
import { installMemoryFs } from './memfs'
import * as ws from '@/core/workspace'
import { writeMemoryFile, readMemoryFile } from '@/core/memory'
import * as codex from '@/core/codex'
import { serializeTable, emptyRow } from '@/core/foreshadow'
import { parseBaseline } from '@/core/style'
import { applyTheme, cycleTheme, settings } from '@/core/settings'
import { ensureBodies, markDirty, newChapter, orderedChapters, renameChapter, saveNow, selectChapter, state } from '@/stores/workspace'
import { editorState, pushNav, resetNav } from '@/stores/editor'
import { askConfirm, askText, cancelDialog, dialogState, resetDialog } from '@/stores/dialog'
import { chipText, createSandbox, discardSandbox, exportSandbox, importFolder, sandbox, summaryText } from '@/stores/sandbox'
import { collectFiles } from '@/core/backup'
import { readZip } from '@/core/zip'
import RightDock from '@/components/RightDock.vue'
import CodexPanel from '@/components/CodexPanel.vue'
import ForeshadowPanel from '@/components/ForeshadowPanel.vue'
import StylePanel from '@/components/StylePanel.vue'
import CheckPanel from '@/components/CheckPanel.vue'
import SearchPanel from '@/components/SearchPanel.vue'
import MemoryPanel from '@/components/MemoryPanel.vue'
import BoardView from '@/views/BoardView.vue'
import GraphView from '@/views/GraphView.vue'
import TimelineView from '@/views/TimelineView.vue'
import StatsView from '@/views/StatsView.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import ChapterTree from '@/components/ChapterTree.vue'
import ShortcutHelp from '@/components/ShortcutHelp.vue'
import TopBar from '@/components/TopBar.vue'
import AppDialog from '@/components/AppDialog.vue'
import ReferencePane from '@/components/ReferencePane.vue'
import OutlineDialog from '@/components/OutlineDialog.vue'
import ImportOutlineDialog from '@/components/ImportOutlineDialog.vue'
import SandboxDialog from '@/components/SandboxDialog.vue'
import HomeView from '@/views/HomeView.vue'
import fs from '@/platform'
import { setAdapter } from '@/platform'
import { memAdapter } from '@/platform/memAdapter'

let failures = 0
function check(label: string, cond: boolean, extra = '') {
  if (!cond) {
    failures++
    console.log('  ✗ ' + label + (extra ? ' → ' + extra : ''))
  } else {
    console.log('  ✓ ' + label)
  }
}

async function seed() {
  const host = installMemoryFs()
  const ref = host.rootRef()
  await ws.createWork(ref, '冒烟作品', { author: '甲', brief: '测试用', targetWords: 200000 })

  await codex.createEntry(ref, 'character', '林晚', {}, '# 林晚\n\n前将军。与 [[晨曦联盟]] 有旧账。\n')
  await codex.createEntry(ref, 'lore', '晨曦联盟', {}, '# 晨曦联盟\n\n由方舟组成的联盟。\n')
  await codex.createEntry(ref, 'timeline', '大事记', {}, '# 大事记\n\n- 元年：云杉出生\n- 三年后：剑穗断了\n')

  const vol = await ws.createVolume(ref, '第一卷 启程')
  const c1 = await ws.createChapter(ref, vol.id, '启程')
  await ws.saveChapter(
    ref,
    c1.id,
    '总而言之，这趟归程并不轻松。林晚站在船头，望着[[晨曦联盟]]的灯火，不禁想起往事，心中五味杂陈。TODO 补一段打斗。十年后，故里已成废墟。',
    { title: '启程', status: '草稿' }
  )
  const c2 = await ws.createChapter(ref, vol.id, '重逢')
  // 正文里放一个内置敏感词，供一致性面板的敏感词区命中
  await ws.saveChapter(ref, c2.id, '她没有回头。林浼（笔误）也没有追上去。他后来沾上了赌博。', { title: '重逢', status: '待修' })
  const c3 = await ws.createChapter(ref, vol.id, '雨夜车站')
  // 第 3 章写「三年后」、第 1 章写「十年后」——故意制造一处时序倒流给时间线视图查
  await ws.saveChapter(ref, c3.id, '风停了。三年后，渡口重新开了。', { title: '雨夜车站', status: '待写' })

  // 插件：作者自己写的导出模板与统计规则（声明式，不执行脚本）
  await fs().writeFile(ref, ['插件', '导出', '投稿版.md'], '# {{书名}}\n\n作者：{{作者}}\n\n{{目录}}\n')
  await fs().writeFile(ref, ['插件', '统计.json'], JSON.stringify([{ name: '剑出现次数', type: 'keyword', words: ['剑'] }]))

  const r1 = emptyRow()
  r1.text = '云杉的血统秘密'
  r1.planted = '第001章'
  r1.planned = '第002章'
  await writeMemoryFile(ref, '伏笔台账.md', serializeTable('伏笔台账', '', [r1]))

  const scan = await ws.scanWork(ref)
  state.ref = ref
  state.volumes = scan.volumes
  state.rootChapters = scan.rootChapters
  state.info = await ws.readWorkInfo(ref)
  state.currentId = c1.id
  state.content = await ws.readChapterBody(ref, c1.id)
  await ensureBodies(true)
  return { ref, c1, c2, c3 }
}

async function mount(name: string, comp: any, waitMs = 60, props: Record<string, any> = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const errs: string[] = []
  const app = createApp(comp, props)
  app.config.warnHandler = (msg) => {
    if (/Hydration|__VUE/.test(msg)) return
    errs.push(msg)
  }
  app.config.errorHandler = (e: any) => errs.push(String(e?.message || e))
  const vm = app.mount(el)
  await nextTick()
  await new Promise((r) => setTimeout(r, waitMs))
  return { el, text: el.textContent || '', errs, vm, app }
}

async function main() {
  const seeded = await seed()

  /* 设定库面板：列出条目 + 选中后显示反向引用 */
  {
    const { el, text, errs } = await mount('CodexPanel', CodexPanel, 120)
    check('设定库面板渲染出条目名', text.includes('林晚') && text.includes('晨曦联盟'), text.slice(0, 80))
    check('设定库面板按分类分组', text.includes('人物') && text.includes('世界观'), text.slice(0, 120))
    const first = el.querySelector('.item') as HTMLElement | null
    if (first) {
      first.click()
      await nextTick()
      await new Promise((r) => setTimeout(r, 120))
    }
    const detail = el.textContent || ''
    check('选中后展开正文编辑区', !!el.querySelector('.body-box'))
    check('选中后算出反向引用', detail.includes('反向引用'), detail.slice(0, 160))
    check('设定库面板无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 伏笔台账面板：读出表格 + 超期预警（当前停在第 3 章，计划第 2 章回收 → 超期） */
  {
    state.currentId = seeded.c3.id
    const { el, text, errs } = await mount('ForeshadowPanel', ForeshadowPanel, 150)
    check('伏笔面板读出台账内容', text.includes('云杉的血统秘密'), text.slice(0, 120))
    check('伏笔面板给出超期预警', text.includes('超期'), text.slice(0, 200))
    check('伏笔面板无运行时错误', errs.length === 0, errs.join(' | '))
    state.currentId = seeded.c1.id
  }

  /* 文风面板：本章指标 + AI 腔命中 */
  {
    const { el, text, errs } = await mount('StylePanel', StylePanel, 150)
    check('文风面板算出平均句长', text.includes('平均句长'), text.slice(0, 120))
    check('文风面板命中 AI 腔', text.includes('AI 腔'), text.slice(0, 200))
    check('文风面板无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 一致性检查面板：跑一遍全量检查 */
  {
    const { el, errs } = await mount('CheckPanel', CheckPanel, 100)
    const btn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始检查')) as HTMLElement | undefined
    check('检查面板有开始检查按钮', !!btn)
    if (btn) {
      btn.click()
      await new Promise((r) => setTimeout(r, 300))
      await nextTick()
    }
    const t = el.textContent || ''
    check('检查跑完并给出结论', /共 \d+ 项待确认|没发现问题/.test(t), t.slice(0, 120))
    check('检查出草稿残留或疑似笔误', t.includes('草稿残留') || t.includes('疑似笔误'), t.slice(0, 240))
    check('检查面板无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 统计看板：dock 不再设「统计」页签（主视图 StatsView 是它的超集），
     StatsPanel 组件随之删除，这里不再挂载。主视图统计的冒烟由 e2e §5 视图轮询覆盖。 */

  /* 记忆库：离线自动整理（Task #8） */
  {
    const { el, errs } = await mount('MemoryPanel', MemoryPanel, 120)
    const btnStatus = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('同步状态表')) as HTMLElement | undefined
    const btnTimeline = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('抽取时间线')) as HTMLElement | undefined
    const btnRolling = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('滚动总述')) as HTMLElement | undefined
    check('记忆面板有离线整理按钮', !!btnStatus && !!btnTimeline && !!btnRolling)
    if (btnStatus) btnStatus.click()
    await new Promise((r) => setTimeout(r, 200))
    const statusFile = await readMemoryFile(state.ref!, '状态表.md')
    check('状态表写进 记忆/状态表.md', statusFile.includes('writer:status') && statusFile.includes('第1章'), statusFile.slice(0, 80))
    if (btnTimeline) btnTimeline.click()
    await new Promise((r) => setTimeout(r, 200))
    const tlFile = await readMemoryFile(state.ref!, '时间线.md')
    check('时间线写进 记忆/时间线.md', tlFile.includes('writer:timeline'))
    if (btnRolling) btnRolling.click()
    await new Promise((r) => setTimeout(r, 200))
    const rollFile = await readMemoryFile(state.ref!, '滚动总述.md')
    check('滚动总述独立成文件', rollFile.includes('writer:rolling') && rollFile.includes('写到哪儿了'), rollFile.slice(0, 60))
    check('记忆面板无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 文风基线存档（Task #7）：面板按钮 → 写入 记忆/文风基线.md */
  {
    const { el, text, errs } = await mount('StylePanel', StylePanel, 150)
    const btn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('重算并存档基线')) as HTMLElement | undefined
    check('文风面板有存档基线按钮', !!btn)
    if (btn) btn.click()
    await new Promise((r) => setTimeout(r, 250))
    const raw = await readMemoryFile(state.ref!, '文风基线.md')
    check('基线写进 记忆/文风基线.md', !!parseBaseline(raw), raw.slice(0, 60))
    const after = el.textContent || ''
    check('存档后立刻用新基线对比', after.includes('指纹') || after.includes('已存档基线'), after.slice(0, 160))
    check('文风面板（存档流程）无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 敏感词检查（P2-26）：词表归作者管，扫出命中并可跳章 */
  {
    const { el, text, errs } = await mount('CheckPanel', CheckPanel, 120)
    const btn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始检查')) as HTMLElement | undefined
    btn?.click()
    await new Promise((r) => setTimeout(r, 350))
    await nextTick()
    const head = [...el.querySelectorAll('b')].find((b) => (b.textContent || '').includes('敏感词')) as HTMLElement | undefined
    check('检查面板有敏感词区', !!head)
    check('敏感词区显示命中数', !!head && /·\s*\d+\s*处/.test(head.textContent || ''), head?.textContent || '')
    head?.click()
    await nextTick()
    await new Promise((r) => setTimeout(r, 120))
    const opened = el.textContent || ''
    check('展开后列出命中的词与章节', opened.includes('赌博') && opened.includes('重逢'), opened.slice(0, 300))
    const editBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('编辑词表')) as HTMLElement | undefined
    editBtn?.click()
    await nextTick()
    check('可以编辑词表', !!el.querySelector('textarea'))
    check('敏感词检查无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* EPUB 导出（P2-29）：导出对话框里出现该选项 */
  {
    const { el, text, errs } = await mount('ExportDialog', ExportDialog, 120)
    check('导出对话框有 EPUB 选项', text.includes('EPUB'), text.slice(0, 200))
    check('EPUB 选项可选中', [...el.querySelectorAll('option')].some((o) => (o.textContent || '').includes('EPUB')))
    check('导出对话框无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 全文搜索：建索引 → 分组 → 命中（Task #6） */
  {
    const { el, text, errs } = await mount('SearchPanel', SearchPanel, 400)
    check('搜索面板自动建了索引', text.includes('重建索引') || text.includes('建立索引'), text.slice(0, 120))
    const input = el.querySelector('input') as HTMLInputElement | null
    check('搜索面板有输入框', !!input)
    if (input) {
      input.value = '林晚'
      input.dispatchEvent(new window.Event('input'))
      await nextTick()
      const searchBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '搜索') as HTMLElement | undefined
      searchBtn?.click()
      await new Promise((r) => setTimeout(r, 200))
      await nextTick()
    }
    const after = el.textContent || ''
    check('搜到正文里的命中', after.includes('处'), after.slice(0, 160))
    check('结果按来源分组（正文/记忆等）', /正文/.test(after), after.slice(0, 200))
    check('搜索面板无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 看板视图（P2-25）：按状态分列 + 拖拽改状态 */
  {
    const { el, text, errs } = await mount('BoardView', BoardView, 120)
    check('看板渲染四个状态列', ['待写', '草稿', '待修', '已定稿'].every((s) => text.includes(s)), text.slice(0, 120))
    check('看板列出章节名', text.includes('启程') && text.includes('重逢'), text.slice(0, 200))
    check('看板画出卡片', el.querySelectorAll('.card').length >= 3, String(el.querySelectorAll('.card').length))
    const before = await ws.readChapterText(state.ref!, seeded.c3.id)
    check('拖拽前《雨夜车站》是待写', before.includes('status: 待写'), before.slice(0, 60))
    // 模拟把「雨夜车站」拖到「草稿」列
    const card = [...el.querySelectorAll('.card')].find((c) => (c.textContent || '').includes('雨夜车站')) as HTMLElement | undefined
    const draftCol = [...el.querySelectorAll('.col')].find((c) => (c.textContent || '').includes('草稿')) as HTMLElement | undefined
    if (card && draftCol) {
      const data: Record<string, string> = {}
      const ev: any = new window.Event('drop', { bubbles: true })
      ev.dataTransfer = { getData: () => seeded.c3.id, setData: (k: string, v: string) => (data[k] = v), effectAllowed: '' }
      draftCol.dispatchEvent(ev)
      await new Promise((r) => setTimeout(r, 250))
      await nextTick()
    }
    const after = await ws.readChapterText(state.ref!, seeded.c3.id)
    check('拖拽后状态落进 md', after.includes('status: 草稿'), after.slice(0, 80))
    check('看板视图无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 关系图视图（P2-21）：节点 / 边 / 点击看关系 / 拖着走 */
  {
    const { el, text, errs } = await mount('GraphView', GraphView, 400)
    check('关系图渲染 SVG', !!el.querySelector('svg'))
    check('关系图画出节点', el.querySelectorAll('.node').length >= 2, String(el.querySelectorAll('.node').length))
    check('关系图画出连线', el.querySelectorAll('.edges line').length >= 1, String(el.querySelectorAll('.edges line').length))
    check('关系图显示统计', /\d+ 节点 · \d+ 关系/.test(text), text.slice(0, 200))

    // 回归：节点必须是响应式的。
    // 曾经节点是普通对象，拖动只改 n.x / n.y，Vue 收不到通知 ——
    // 表现是「圆点拖着不动、点『重排』没反应」，要等碰巧有别的东西触发重渲染才跳过去。
    //
    // 走 Pointer Events，不是 mousedown + window 上的 mousemove：触摸设备上后者收不到，
    // 而且手指滑出圆点就断了。这里必须照新实现派发 —— 派发老事件的话，
    // 监听器根本没人接，这条断言会「绿」得毫无意义。
    const pos = (n: Element) => String(n.getAttribute('transform') || '')
    const pointer = (type: string, opts: PointerEventInit) =>
      new window.PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, button: 0, ...opts })
    const nodeBefore = el.querySelector('.node')
    const before = pos(nodeBefore!)
    nodeBefore!.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100, buttons: 1 }))
    await nextTick()
    // 事件落在节点自己身上：jsdom 里没有 setPointerCapture（真机上是靠它把后续事件
    // 锁在节点上的），所以这里直接往节点上派，别挂到 window 上去。
    nodeBefore!.dispatchEvent(pointer('pointermove', { clientX: 160, clientY: 130, buttons: 1 }))
    await nextTick()
    const after = pos(el.querySelector('.node')!)
    check('拖着节点走，坐标真的跟着动（节点响应式）', before !== after, `${before} → ${after}`)
    nodeBefore!.dispatchEvent(pointer('pointerup', { clientX: 160, clientY: 130, buttons: 0 }))
    await nextTick()

    check('点节点后显示关系面板', (el.textContent || '').includes('关系（'), (el.textContent || '').slice(0, 200))
    check('关系图视图无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 时间线视图（P2-22）：事件流 + 时序矛盾 */
  {
    const { el, text, errs } = await mount('TimelineView', TimelineView, 400)
    check('时间线抽出设定里的事件', text.includes('云杉出生'), text.slice(0, 200))
    check('时间线抽出正文里的时间', text.includes('十年后') || text.includes('三年后'), text.slice(0, 240))
    check('时间线渲染事件卡片', el.querySelectorAll('.ev').length >= 3, String(el.querySelectorAll('.ev').length))
    check('检出时序矛盾并给出说明', text.includes('时序矛盾') && text.includes('却回到'), text.slice(0, 300))
    check('时间线视图无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 统计视图（P2-23 / P2-28） */
  {
    const { el, text, errs } = await mount('StatsView', StatsView, 200)
    check('统计页渲染总字数卡片', text.includes('总字数'), text.slice(0, 120))
    check('统计页渲染健康度', text.includes('结构健康度') && text.includes('已定稿率'), text.slice(0, 200))
    check('统计页画出写作曲线', (el.querySelectorAll('.bar-col').length || 0) >= 14, String(el.querySelectorAll('.bar-col').length))
    check('统计页列出各卷字数', text.includes('各卷字数') && text.includes('第一卷'), text.slice(0, 240))
    check('统计视图无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 参考资料窗（P2-24 / P2-27）：分屏对照 + 钉住 */
  {
    editorState.refOpen = true
    editorState.refPinned = false
    const { el, text, errs } = await mount('ReferencePane', ReferencePane, 300, { mode: 'dock' })
    // 分组名在 optgroup 的 label 属性上，不进 textContent，所以查 DOM
    check('参考窗按组列出来源', el.querySelectorAll('optgroup').length >= 2, String(el.querySelectorAll('optgroup').length))
    const opts = [...el.querySelectorAll('option')]
    check('参考源下拉有选项', opts.length >= 2, String(opts.length))
    check('设定与正文都能当参考', opts.some((o) => o.textContent === '林晚') && opts.some((o) => o.textContent === '启程'), opts.map((o) => o.textContent).join('/'))
    check('参考窗渲染出正文', (el.querySelector('.rtext')?.textContent || '').length > 0, (el.querySelector('.rtext')?.textContent || '').slice(0, 60))
    const pinBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('钉住')) as HTMLElement | undefined
    check('可以钉成浮动窗', !!pinBtn)
    pinBtn?.click()
    await nextTick()
    // 按钮文案由 mode 这个 prop 决定（钉住之后由 WriteView 换挂 mode="pin" 的那一份），
    // 所以这里分两步验：① 状态真的翻了；② 浮动形态自己渲染成了「收回」。
    check('点钉住后状态切换', Boolean(editorState.refPinned))
    const pinned = await mount('ReferencePane', ReferencePane, 100, { mode: 'pin' })
    check('钉住形态渲染成浮动小窗', pinned.el.querySelector('.ref.pin') !== null, (pinned.el.className || '') + '|' + (pinned.el.innerHTML || '').slice(0, 80))
    check('钉住形态给的是「收回」而不是「钉住」', (pinned.el.textContent || '').includes('收回'), (pinned.el.textContent || '').slice(0, 60))
    check('参考窗无运行时错误', errs.length === 0, errs.join(' | '))
    // 收干净，别把「钉住」状态漏给后面的用例
    editorState.refPinned = false
    editorState.refOpen = false
  }

  /* 「大纲」窗口 = 本书大纲查看器（功能已汇总进「导入大纲」，这里只管看） */
  {
    const { el, text, errs } = await mount('OutlineDialog', OutlineDialog, 200)
    // seed 作品的 大纲/剧情大纲.md 还是新建时的稿纸模板（hasRealOutline 判为「不算」），卷纲也没写过 —— 正好走空态
    check(
      '大纲查看器：没有大纲时给实话 + 去导入的入口（不再塞生成骨架 / AI 推荐）',
      text.includes('还没有可看的大纲') && text.includes('去导入大纲'),
      text.slice(0, 200)
    )
    check('大纲查看器：头部保留「导入大纲」入口（与顶栏入口同名不同职）', !![...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '导入大纲'))
    check('大纲查看器无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 「导入大纲」= 功能汇总：导入（默认页）→ 原大纲窗口的规模/骨架（生成新骨架页签） */
  {
    /* 「AI 推荐」页签要 aiEnabled() 才渲染 —— 先把 AI 层配成「已配置」验四页签，
       验完立刻恢复（example.invalid，不会发出任何真实请求）。 */
    const aiBak = { ...settings.ai }
    Object.assign(settings.ai, {
      configured: true,
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'panelsmoke-not-a-real-key',
      model: 'panelsmoke-model'
    })
    const { el, text, errs } = await mount('ImportOutlineDialog', ImportOutlineDialog, 200)
    const ta = el.querySelector('textarea') as HTMLTextAreaElement | null
    check('导入大纲框给了可粘贴的输入框（文件选不了时还能粘）', !!ta)
    check(
      '导入大纲窗口四个页签俱全（导入 / 生成新骨架 / 用现有大纲 / AI 推荐）',
      ['导入', '生成新骨架', '用现有大纲', 'AI 推荐'].every((t) => (el.textContent || '').includes(t)),
      (el.textContent || '').slice(0, 160)
    )
    if (ta) {
      ta.value = '# 第一卷 启程\n卷目标：回到原点\n\n## 第一章 雪夜\n本章目标：立住人物与处境\n雪夜回乡。\n'
      ta.dispatchEvent(new window.Event('input'))
      await nextTick()
    }
    check('粘进去就认出卷章', (el.textContent || '').includes('第一卷 启程'), (el.textContent || '').slice(0, 200))
    check('统计出卷与章', /1 卷/.test(el.textContent || '') && /1 章/.test(el.textContent || ''), text.slice(0, 120))
    const volBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('导入 1 卷的卷纲')) as HTMLElement | undefined
    check('按卷给出导入按钮（写哪去写在按钮旁边）', !!volBtn)
    volBtn?.click()
    await new Promise((r) => setTimeout(r, 600))
    check('导入后给了结果提示', /写了 \d+ 个文件/.test(el.textContent || ''), (el.textContent || '').slice(0, 240))
    const volDirs = (await fs().listDir(state.ref!, ['正文'])).filter((x) => x.kind === 'dir').map((x) => x.name)
    check('卷目录建出来了', volDirs.some((n) => n.includes('第一卷')), volDirs.join(' / '))
    const vg = await ws.readVolumeOutline(state.ref!, `正文/${volDirs.find((n) => n.includes('第一卷'))}`)
    check('卷纲写进 front matter 与正文', String(vg.meta.target || '') === '回到原点' && vg.body.includes('第一章 雪夜'), JSON.stringify(vg.meta))
    check('导入大纲框无运行时错误', errs.length === 0, errs.join(' | '))

    /* —— 原「大纲」窗口的规模断言：功能搬进「生成新骨架」页签后在这里接着验 —— */
    const newTab = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '生成新骨架') as HTMLElement | undefined
    check('页签切得到「生成新骨架」', !!newTab)
    newTab?.click()
    await nextTick()
    check(
      '大纲：规模是三个输入框（卷数/章数/每章字数），没有自动算出来的卷章统计行',
      el.querySelectorAll('.shape input').length === 3 && !/共 \d+ 卷 · \d+ 章/.test(el.textContent || ''),
      (el.textContent || '').slice(0, 160)
    )
    check('大纲：目标字数跟着规模算出来（约 N 万字）', /约 \d+(\.\d+)? 万字/.test(el.textContent || ''), (el.textContent || '').slice(0, 120))
    check('大纲预览骨架', el.querySelectorAll('.prev .vol').length >= 1, String(el.querySelectorAll('.prev .vol').length))
    const chapterInput = el.querySelectorAll('.shape input')[1] as HTMLInputElement
    chapterInput.value = '12'
    chapterInput.dispatchEvent(new Event('input'))
    chapterInput.dispatchEvent(new Event('change'))
    await nextTick()
    check(
      '大纲：章数改成 12，预览跟着重排（4 卷 × 3 章）',
      /第1章-第3章/.test(el.textContent || ''),
      (el.textContent || '').slice(0, 200)
    )
    const writeBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').includes('写入大纲文件')) as HTMLElement | undefined
    check('有写入大纲按钮', !!writeBtn)
    writeBtn?.click()
    await new Promise((r) => setTimeout(r, 250))
    check('写入后提示成功', (el.textContent || '').includes('已写入'), (el.textContent || '').slice(0, 200))
    const omdRaw = await fs().readFile(state.ref!, ['大纲', '剧情大纲.md']).catch(() => '')
    check('大纲/剧情大纲.md 写成了 Markdown 表格', omdRaw.includes('| 章节 | 目标 | 字数 |'), omdRaw.slice(0, 80))
    check('生成骨架页无运行时错误', errs.length === 0, errs.join(' | '))
    Object.assign(settings.ai, aiBak) // 恢复 AI 层开关，别把状态带给后面的用例
  }

  /* 插件机制（P2-30）：导出模板下拉 + 自定义统计 */
  {
    const { el, text, errs } = await mount('ExportDialog', ExportDialog, 200)
    check('导出框列出自定义模板', text.includes('投稿版'), text.slice(0, 200))
    const sel = [...el.querySelectorAll('select')].find((s) => [...s.querySelectorAll('option')].some((o) => (o.textContent || '').includes('投稿版')))
    check('模板可选中', !!sel)
    if (sel) {
      sel.value = '插件/导出/投稿版.md'
      sel.dispatchEvent(new window.Event('change'))
      await nextTick()
    }
    check('选中模板后提示将按模板渲染', (el.textContent || '').includes('按模板渲染'), (el.textContent || '').slice(0, 240))
    check('插件导出无运行时错误', errs.length === 0, errs.join(' | '))
  }

  {
    const { text, errs } = await mount('StatsView', StatsView, 300)
    check('统计页加载自定义规则', text.includes('自定义统计'), text.slice(0, 200))
    check('自定义规则算出结果', text.includes('剑出现次数'), text.slice(0, 300))
    check('插件统计无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 语义检索（P1-20）：切到语义模式 → 召回相关段落 */
  {
    const { el, text, errs } = await mount('SearchPanel', SearchPanel, 400)
    const semBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '语义') as HTMLElement | undefined
    check('搜索面板有语义模式', !!semBtn)
    semBtn?.click()
    await nextTick()
    const input = el.querySelector('input') as HTMLInputElement | null
    if (input) {
      input.value = '林晚 船头'
      input.dispatchEvent(new window.Event('input'))
      await nextTick()
    }
    const goBtn = [...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '搜索') as HTMLElement | undefined
    goBtn?.click()
    await new Promise((r) => setTimeout(r, 400))
    await nextTick()
    const after = el.textContent || ''
    check('语义模式给出结果', /条结果/.test(after) && !after.includes('没有语义上相近'), after.slice(0, 240))
    check('结果带相关度', /相关度 \d+/.test(after), after.slice(0, 300))
    check('语义检索无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 右侧面板容器：页签切换 */
  {
    settings.ui.dockOpen = true
    editorState.dockTab = 'style'
    const { text, errs } = await mount('RightDock', RightDock, 120)
    check('右侧容器渲染出页签', text.includes('设定') && text.includes('伏笔') && text.includes('检查'), text.slice(0, 160))
    check('默认落在当前页签（文风）', (document.querySelectorAll('.dock').length || 0) > 0 && text.includes('文风'), text.slice(0, 200))
    check('右侧容器无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 章节树筛选（P3-D）：长篇里靠筛不用滚 */
  {
    resetNav()
    editorState.treeFilter = ''
    const { el, errs } = await mount('ChapterTree', ChapterTree, 120)
    const t0 = el.textContent || ''
    check('章节树渲染出全部章节', t0.includes('启程') && t0.includes('重逢') && t0.includes('雨夜车站'), t0.slice(0, 120))
    check('章节树带筛选框', !!el.querySelector('.filter-input'))

    editorState.treeFilter = '#待修'
    await nextTick()
    await new Promise((r) => setTimeout(r, 60))
    const t1 = el.textContent || ''
    check('按状态筛选后只剩命中的章', t1.includes('重逢') && !t1.includes('雨夜车站'), t1.slice(0, 160))
    check('筛选后给出命中计数', /命中 1 \/ 共 3 章/.test(t1), t1.slice(0, 160))

    editorState.treeFilter = '启程'
    await nextTick()
    await new Promise((r) => setTimeout(r, 60))
    const marks = [...el.querySelectorAll('mark.hl')].map((m) => m.textContent)
    check('关键词命中会高亮出来', marks.includes('启程'), marks.join(','))
    check('高亮落在章节标题里', !!el.querySelector('.ch-title mark.hl'))

    editorState.treeFilter = '这个词不存在'
    await nextTick()
    await new Promise((r) => setTimeout(r, 60))
    check('全不命中时给出空态', (el.textContent || '').includes('没有符合条件的章节'))

    editorState.treeFilter = ''
    await nextTick()
    await new Promise((r) => setTimeout(r, 60))
    check('清空筛选后恢复全部章节', (el.textContent || '').includes('雨夜车站'))
    check('章节树无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 快捷键一览（P3-D）：表与渲染同源 */
  {
    const { el, text, errs } = await mount('ShortcutHelp', ShortcutHelp, 80)
    check('帮助面板按「写作 / 正文编辑器 / 导航 / 界面」分组', ['写作', '正文编辑器', '导航', '界面'].every((g) => text.includes(g)), text.slice(0, 160))
    check('帮助面板渲染出 kbd 键帽', el.querySelectorAll('kbd').length >= 15, String(el.querySelectorAll('kbd').length))
    check('帮助面板显示 Ctrl + S 这样的组合键', text.includes('Ctrl + S'), text.slice(0, 200))
    check('帮助面板给出总条数', /\d+ 条/.test(text), text.slice(0, 120))

    const input = el.querySelector('.filter input') as HTMLInputElement | null
    check('帮助面板带搜索框', !!input)
    if (input) {
      input.value = '加粗'
      input.dispatchEvent(new window.Event('input'))
      await nextTick()
      await new Promise((r) => setTimeout(r, 40))
    }
    const f = el.textContent || ''
    check('帮助面板可按关键词筛', f.includes('加粗') && !f.includes('Ctrl + S'), f.slice(0, 200))
    check('快捷键面板无运行时错误', errs.length === 0, errs.join(' | '))
  }

  /* 工具栏：导航按钮 + 主题 + 帮助入口（P3-D） */
  {
    resetNav()
    let backCalls = 0
    let helpCalls = 0
    const { el, text, errs } = await mount('TopBar', TopBar, 60, { onNavBack: () => backCalls++, onHelp: () => helpCalls++ })
    const navBtns = [...el.querySelectorAll('button.nav')] as HTMLButtonElement[]
    check('工具栏有后退/前进两个按钮', navBtns.length === 2, String(navBtns.length))
    check('没有历史时两个按钮都禁用', navBtns.every((b) => b.disabled))
    check('工具栏显示当前主题名', /白底|护眼|夜间/.test(text), text.slice(0, 160))
    check('工具栏有快捷键入口按钮', [...el.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '?'))

    pushNav({ chapterId: 'a', pos: 0, label: '第一章 启程' })
    pushNav({ chapterId: 'b', pos: 0, label: '第二章 重逢' })
    await nextTick()
    const after = [...el.querySelectorAll('button.nav')] as HTMLButtonElement[]
    check('有历史后「后退」可点', !after[0].disabled && after[0].title.includes('第一章 启程'), after[0].title)
    check('此时「前进」仍禁用', after[1].disabled)
    after[0].click()
    await nextTick()
    check('点后退按钮会真的派发事件', backCalls === 1, String(backCalls))
    ;[...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '?')?.click()
    await nextTick()
    check('点 ? 会请求打开帮助面板', helpCalls === 1, String(helpCalls))
    check('工具栏无运行时错误', errs.length === 0, errs.join(' | '))
    resetNav()
  }

  /* 主题（P3-D）：类挂在 html 上，body/滚动条才跟着变 */
  {
    const root = document.documentElement
    settings.editor.theme = 'dark'
    applyTheme()
    check('夜间主题：html 上挂 theme-dark', root.classList.contains('theme-dark'))
    check('夜间主题：声明 color-scheme=dark', root.style.colorScheme === 'dark', root.style.colorScheme)
    check('夜间主题：留下 data-theme 供排查', root.dataset.theme === 'dark', String(root.dataset.theme))
    check('主题切换会摘掉上一个类的残留', (() => { settings.editor.theme = 'sepia'; applyTheme(); return root.classList.contains('theme-sepia') && !root.classList.contains('theme-dark') })())
    check('白底主题不挂任何主题类', (() => { settings.editor.theme = 'light'; applyTheme(); return !root.classList.contains('theme-sepia') && !root.classList.contains('theme-dark') })())
    const t1 = cycleTheme()
    const t2 = cycleTheme()
    const t3 = cycleTheme()
    check('Ctrl+. 轮换主题一圈能回到起点', t1 === 'sepia' && t2 === 'dark' && t3 === 'light', [t1, t2, t3].join('>'))
    settings.editor.theme = 'light'
    applyTheme()
  }

  /* 应用内对话框（P3-E）：不再用原生 prompt / confirm
     —— 原生弹窗样式不可控，而且桌面壳 / 部分 WebView 会直接禁掉，
        调用处静默失败（点了「新建章节」什么也没发生），是最难查的一类 bug。 */
  {
    resetDialog()
    const { el, errs } = await mount('AppDialog', AppDialog, 60)
    check('对话框：没有请求时不渲染任何东西', !el.querySelector('.dlg-mask'))

    const mask = () => el.querySelector('.dlg-mask') as HTMLElement | null
    const maskText = () => mask()?.textContent || ''
    const buttons = () => Array.from(el.querySelectorAll('.dlg-foot button')) as HTMLButtonElement[]
    const okBtn = () => buttons()[buttons().length - 1]
    const cancelBtn = () => buttons()[0]
    const tick = () => new Promise((r) => setTimeout(r, 20))
    const setInput = async (v: string) => {
      const i = el.querySelector('.dlg-input') as HTMLInputElement
      i.value = v
      i.dispatchEvent(new window.Event('input'))
      await nextTick()
    }
    const press = async (key: string) => {
      mask()?.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await nextTick()
    }
    const clickOk = async () => {
      okBtn().click()
      await nextTick()
    }
    const clickCancel = async () => {
      cancelBtn().click()
      await nextTick()
    }

    let r1: string | null | undefined
    const p1 = askText({ title: '新建章节', label: '章节标题', placeholder: '留空则为「第005章」', maxLength: 5 })
    void p1.then((r) => (r1 = r))
    await nextTick()
    await tick()

    check('askText 弹出应用内对话框（不是原生 prompt）', !!mask())
    check('对话框读出标题与说明', maskText().includes('新建章节') && maskText().includes('章节标题'), maskText().slice(0, 60))
    check('对话框显示占位提示', (el.querySelector('.dlg-input') as HTMLInputElement)?.placeholder === '留空则为「第005章」')
    check('对话框弹出次数被记下（方便验收取证）', dialogState.count === 1, String(dialogState.count))
    // 刚打开就飘一行红的「不能为空」，明明是还没开始填，看起来却像已经填错了
    check('刚打开时不预设错误（用户还没动手）', !el.querySelector('.dlg-err'))

    // 空输入：确定点不动
    check('空输入时「确定」是禁用的', okBtn().disabled)
    await clickOk()
    await tick()
    check('空输入硬点确定也提交不了，弹窗留在原地', !!mask() && r1 === undefined)

    // 超长：给出具体错误
    await setInput('一二三四五六')
    await tick()
    check('超长时亮出具体错误', maskText().includes('最多 5 个字'), maskText().slice(0, 80))
    check('超长时「确定」仍然禁用', okBtn().disabled)

    // 合规：Enter 直接提交，跟原生 prompt 一样顺手
    await setInput('启程')
    await tick()
    check('合规输入后「确定」可点', !okBtn().disabled)
    await press('Enter')
    await tick()
    check('回车即可提交（不必去点按钮）', r1 === '启程', String(r1))
    check('提交后弹窗自动关闭', !mask())

    // 取消：Esc 与「取消」按钮都要给出 null，调用处才好判断
    let r2: string | null | undefined
    void askText({ title: '第二个问题' }).then((r) => (r2 = r))
    await nextTick()
    await tick()
    await press('Escape')
    await tick()
    check('Esc 关掉弹窗', !mask())
    check('Esc 取消返回 null（调用处靠它判断放弃）', r2 === null, String(r2))

    let r3: string | null | undefined
    void askText({ title: '第三个问题' }).then((r) => (r3 = r))
    await nextTick()
    await tick()
    await clickCancel()
    await tick()
    check('点「取消」同样返回 null', r3 === null, String(r3))

    // 排队：连开两个不能互相挤掉，否则前一个 await 永远卡住（静默丢操作）
    let q1: string | null | undefined
    let q2: string | null | undefined
    void askText({ title: '排队甲' }).then((r) => (q1 = r))
    void askText({ title: '排队乙' }).then((r) => (q2 = r))
    await nextTick()
    await tick()
    check('排队：同时只显示第一个请求', maskText().includes('排队甲') && !maskText().includes('排队乙'), maskText().slice(0, 40))
    await setInput('甲')
    await clickOk()
    await tick()
    check('排队：第一个答完，第二个自动顶上', maskText().includes('排队乙'), maskText().slice(0, 40))
    check('排队：第一个拿到了自己的答案', q1 === '甲', String(q1))
    await clickCancel()
    await tick()
    check('排队：第二个拿到取消', q2 === null, String(q2))
    check('排队：都答完后界面干净了', !mask())

    // 确认框：危险操作要能一眼看出来
    let r4: boolean | undefined
    void askConfirm({
      title: '删除《启程》',
      message: '这一章的正文文件会从磁盘上移除。',
      detail: ['正文/第001章 启程.md · 3200 字', '已保存的快照不受影响'],
      danger: true
    }).then((r) => (r4 = r))
    await nextTick()
    await tick()
    check('确认框渲染影响清单', el.querySelectorAll('.dlg-detail li').length === 2, String(el.querySelectorAll('.dlg-detail li').length))
    check('危险确认框不显示输入框', !el.querySelector('.dlg-input'))
    check('危险操作默认按钮文案是「删除」', okBtn().textContent?.trim() === '删除', okBtn().textContent || '')
    check('危险操作的确定按钮走危险色', okBtn().classList.contains('danger'))
    await press('Enter')
    await tick()
    check('确认框按回车即确认', r4 === true, String(r4))

    let r5: boolean | undefined
    void askConfirm({ title: '普通确认', message: '继续吗', okText: '继续' }).then((r) => (r5 = r))
    await nextTick()
    await tick()
    check('非危险的确定按钮走主色', okBtn().classList.contains('primary') && okBtn().textContent?.trim() === '继续')
    await clickCancel()
    await tick()
    check('确认框取消返回 false', r5 === false, String(r5))

    check('对话框无运行时错误', errs.length === 0, errs.join(' | '))
    resetDialog()
  }

  /* 章节目录键盘导航（P3-E）：长篇里手不用离开键盘就能翻章 */
  {
    state.currentId = seeded.c1.id
    const { el, errs } = await mount('ChapterTree', ChapterTree, 120)
    const body = el.querySelector('.tree-body') as HTMLElement
    check('目录列表可聚焦（键盘能进去）', body.tabIndex === 0 && body.getAttribute('role') === 'listbox')
    const press = async (key: string) => {
      body.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await nextTick()
      await new Promise((r) => setTimeout(r, 30))
    }
    const curTitle = () => el.querySelector('.ch.cursor .ch-title')?.textContent?.trim() || ''
    const curCls = () => el.querySelector('.cursor')?.className || ''

    body.dispatchEvent(new window.Event('focus'))
    await nextTick()
    check('聚焦时光标落在当前正在写的那一章上', curTitle().includes('启程'), curTitle())

    await press('ArrowDown')
    check('↓ 移到下一章', curTitle().includes('重逢'), curTitle())
    await press('ArrowUp')
    check('↑ 移回上一章', curTitle().includes('启程'), curTitle())

    await press('End')
    check('End 跳到最后一章', curTitle().includes('雨夜车站'), curTitle())
    await press('Home')
    check('Home 跳到列表最上面（卷行）', curCls().includes('vol-line'), curCls())

    // v-show 挂在包裹层上，不是 .ch 自己身上
    const wrap = () => (el.querySelector('.tree-body .ch') as HTMLElement).parentElement as HTMLElement
    await press('ArrowLeft')
    check('← 折叠光标所在的卷', wrap().style.display === 'none', wrap().style.display)
    check('折叠只是藏起来，章节点没被销毁（展开即回）', el.querySelectorAll('.tree-body .ch').length === 3)
    await press('ArrowRight')
    check('→ 再展开', wrap().style.display !== 'none', wrap().style.display)

    await press('End')
    await press('Enter')
    await new Promise((r) => setTimeout(r, 150))
    check('回车打开光标所在的章节', state.currentId === seeded.c3.id, state.currentId)
    check('打开后该章在树里标成当前章', el.querySelector('.ch.active .ch-title')?.textContent?.includes('雨夜车站') === true)

    await press('F2')
    check('F2 就地重命名（光标行的标题变成输入框）', !!el.querySelector('.ch.cursor input'), el.querySelector('.tree-body')?.innerHTML?.slice(0, 60) || '')

    check('章节目录键盘导航无运行时错误', errs.length === 0, errs.join(' | '))
    state.currentId = seeded.c1.id
  }

  /* store：切章时正文必须跟着换
     —— 真浏览器验收时发现的 bug：selectChapter 先改 currentId 再异步读正文，
     编辑器拿到的是上一章的内容，表现为「切章串内容」「刚打开作品编辑区空白」。
     seed() 里是手动赋值 state.content 的，所以以前没盖住这条路径。 */
  {
    await selectChapter(seeded.c2.id)
    check('selectChapter 切到第二章后正文跟着换', state.content.includes('她没有回头'), state.content.slice(0, 60))
    await selectChapter(seeded.c1.id)
    check('selectChapter 切回第一章后不留上一章正文', state.content.includes('林晚站在船头') && !state.content.includes('她没有回头'), state.content.slice(0, 60))
    await selectChapter(seeded.c3.id)
    check('selectChapter 切到第三章正文同步更新', state.content.includes('渡口重新开了'), state.content.slice(0, 60))
    check('切章后 currentId 与 content 同源', state.bodies[state.currentId] === state.content)
    await selectChapter(seeded.c1.id)
  }

  /* 改章名不能吞掉还没保存的正文
     —— 真实浏览器验收揪出来的第二处：renameChapter 原来是「读磁盘上的旧正文 → 写新文件 → 删旧文件」，
        而自动保存是防抖的。刚敲的那几段还在内存里，读磁盘读到的是旧内容，
        改完名就等于把它们丢了。修法是动手前先 saveNow()。 */
  {
    await selectChapter(seeded.c1.id)
    const appended = '（刚刚新加的一段，还没到自动保存的点。）'
    markDirty(state.content + appended)
    await renameChapter(seeded.c1.id, '启程（改过名）')
    const renamed = orderedChapters.value.find((c) => c.title === '启程（改过名）')
    check('改章名后新文件名出现在目录里', !!renamed, orderedChapters.value.map((c) => c.title).join(' / '))
    check('改名后内存里保留着那段未保存的正文', state.content.includes(appended), state.content.slice(-40))
    const onDisk = renamed ? await ws.readChapterBody(seeded.ref, renamed.id) : ''
    check('落盘的正文也带着那段（没被旧内容顶掉）', onDisk.includes(appended), onDisk.slice(-40))
    const bodyFiles = await fs().listDir(seeded.ref, ['正文'])
    check(
      '改名后旧文件已不在（是改名，不是又复制了一份）',
      !bodyFiles.some((e) => e.name.startsWith('第001章') && !e.name.includes('改过名')),
      bodyFiles.map((e) => e.name).join(', ')
    )
  }

  /* 沙盒模式（P3-F）：拿不到 File System Access API 的浏览器上，这套软件还能不能用
     —— jsdom 里本来就没有 showDirectoryPicker，所以首页天然就是降级模式。
        正好借它把 Firefox / Safari 那条路整条走一遍：导入 → 写 → 导出 → 丢弃。 */
  {
    const prevAdapter = fs()

    /* 1) 首页：给一条能走通的路，而不是一句「请用 Chrome」 */
    {
      const { el, text, errs } = await mount('HomeView', HomeView, 120)
      check('降级：首页不再是一句死路提示', !text.includes('请用 Edge') && text.includes('这个浏览器不能直接读写本机文件夹'), text.slice(0, 60))
      check('降级：给得出「导入」与「新建」两条路', text.includes('导入作品文件夹') && text.includes('新建作品（沙盒）'))
      const input = el.querySelector('input[type=file]') as HTMLInputElement | null
      check('降级：文件夹选择框声明了 webkitdirectory（否则只能一个文件一个文件挑）', !!input && input.hasAttribute('webkitdirectory'))
      check('降级：代价写在明面上，不是只报喜', text.includes('这样做的代价') && /磁盘不是实时同步/.test(text))
      check('降级：首页无运行时错误', errs.length === 0, errs.join(' | '))
      el.remove()
    }

    /* 2) 导入一个作品文件夹（自己造一份完整的小作品，断言才不靠运气） */
    const fixture: Array<[string, string]> = [
      ['作品信息.md', '---\ntitle: 沙盒样书\nauthor: 乙\n---\n\n# 沙盒样书\n'],
      ['正文/第001章 启程.md', '---\ntitle: 启程\nstatus: 草稿\n---\n\n船靠岸的时候，雨还没停。\n'],
      ['正文/第002章 重逢.md', '---\ntitle: 重逢\nstatus: 草稿\n---\n\n她没有回头。\n'],
      ['记忆/逐章摘要.md', '# 逐章摘要\n\n> 测试用\n'],
      ['记忆/状态表.md', '# 状态表\n'],
      ['记忆/伏笔台账.md', '# 伏笔台账\n'],
      ['记忆/时间线.md', '# 时间线\n'],
      ['大纲/人物大纲/主角.md', '# 主角\n\n> 前将军。\n']
    ]
    const listing = [
      ...fixture.map(([rel, text]) => ({
        name: rel.split('/').pop() as string,
        // webkitdirectory 给出的是「作者选中的那层文件夹 / 里面的路径」
        webkitRelativePath: `沙盒样书/${rel}`,
        text: async () => text
      })),
      { name: '封面.png', webkitRelativePath: '沙盒样书/封面.png', text: async () => 'PNG占位' }
    ]
    const r = await importFolder(listing)
    check('降级：导入成功并报出文件数', r.ok && /已导入 8 个文件/.test(r.text), r.text)
    check('降级：非文本文件如实报出来，不装作导进去了', /1 个文件未导入/.test(r.text) && sandbox.skipped.includes('沙盒样书/封面.png'), r.text)
    check('降级：宿主换成了内存宿主', fs().kind === 'memory' && sandbox.active, fs().kind)
    check('降级：作品名取自被选中的那层文件夹', sandbox.name === '沙盒样书', sandbox.name)
    check('降级：刚导入就「已同步」（基线就是导进来那一刻）', sandbox.diff.count === 0, JSON.stringify(sandbox.diff))
    check('降级：沙盒里照样扫得出章节', orderedChapters.value.length === 2, String(orderedChapters.value.length))
    check('降级：备份层的目录遍历在内存宿主上也走得通', (await collectFiles(fs().kind === 'memory' && state.ref ? state.ref : seeded.ref)).length === 8)

    /* 3) 改一章 → 「未导出」跟着动 */
    const ch1 = orderedChapters.value[0]
    await selectChapter(ch1.id)
    markDirty(state.content + '（沙盒里新加的一段。）')
    await saveNow()
    await nextTick()
    check('降级：改一章之后正好「未导出 1」', sandbox.diff.count === 1 && sandbox.diff.changed[0] === ch1.id, summaryText.value)
    check('降级：顶栏标记随改动变（作者随时看得见没落盘）', chipText.value === '沙盒 · 未导出 1', chipText.value)

    /* 4) 导出：把下载拦下来，验产物本身 */
    {
      const w = window as any
      const origClick = w.HTMLAnchorElement.prototype.click
      const origUrl = (URL as any).createObjectURL
      const got: { name: string; blob: any }[] = []
      let lastBlob: any = null
      w.HTMLAnchorElement.prototype.click = function () {
        got.push({ name: (this as any).download, blob: lastBlob })
      }
      ;(URL as any).createObjectURL = (b: any) => {
        lastBlob = b
        return 'blob:smoke'
      }

      const { el, text: dtext, errs } = await mount('SandboxDialog', SandboxDialog, 80)
      check('降级：面板说清「只有导出才落盘」', /只有点了下面的导出/.test(dtext), dtext.slice(0, 100))
      check('降级：面板列出与磁盘不一样的文件', dtext.includes(ch1.id), dtext.slice(0, 200))

      const allBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('导出全部')) as HTMLButtonElement
      allBtn.click()
      await new Promise((r2) => setTimeout(r2, 250))
      const out = el.textContent || ''
      check('降级：导出全部报出产物名与文件数', /已导出 \d+ 个文件到 .*\.zip/.test(out), out.slice(-220))
      check('降级：确实触发了一次下载', got.length === 1 && /沙盒导出-全量/.test(got[0].name), got.map((g) => g.name).join())
      const bytes = new Uint8Array(await got[0].blob.arrayBuffer())
      const { entries } = await readZip(bytes)
      const names = entries.map((e) => e.name)
      check('降级：导出的是能解开的 zip', names.length === 10 && names.includes('沙盒导出信息.json'), `${names.length} 项：${names.slice(0, 4).join(' | ')}`)
      check('降级：zip 里正文的条目名就是相对作品根的路径', names.includes(ch1.id), names.filter((n) => n.startsWith('正文')).join(' | '))
      check('降级：zip 里带了「解开之后怎么用」的说明', names.includes('沙盒导出说明.md'))
      check('降级：导出之后回到「已同步」', sandbox.diff.count === 0, summaryText.value)
      check('降级：沙盒面板无运行时错误', errs.length === 0, errs.join(' | '))

      /* 5) 只导出改动的：条目只该是「那份文件 + 两份元信息」 */
      markDirty(state.content + '（第二次改动。）')
      await saveNow()
      await nextTick()
      const chgBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('仅导出改动的')) as HTMLButtonElement
      chgBtn.click()
      await new Promise((r2) => setTimeout(r2, 250))
      check('降级：只导出改动时文件名标了「改动」', got.length === 2 && /沙盒导出-改动/.test(got[1].name), got[1]?.name)
      const z2 = await readZip(new Uint8Array(await got[1].blob.arrayBuffer()))
      check('降级：只带那一个改动文件，不多带', z2.entries.length === 3, z2.entries.map((e) => e.name).join(' | '))

      /* 6) 丢弃：危险操作要走应用内确认框 */
      const del = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('丢弃沙盒')) as HTMLButtonElement
      del.click()
      await new Promise((r2) => setTimeout(r2, 80))
      check('降级：丢弃走应用内确认框（不是原生 confirm）', !!dialogState.current && /丢弃/.test(dialogState.current.title), dialogState.current?.title || '(无)')
      cancelDialog()
      await discardSandbox()
      check('降级：丢弃后浏览器里那份也没了', !sandbox.active && !memAdapter.hasRoot('mem:沙盒样书'))
      check('降级：退出沙盒后宿主装回原来的那个', fs().kind !== 'memory', fs().kind)

      w.HTMLAnchorElement.prototype.click = origClick
      ;(URL as any).createObjectURL = origUrl
      el.remove()
    }

    setAdapter(prevAdapter)
  }

  console.log(failures === 0 ? '\n面板冒烟全部通过 ✅' : `\n面板冒烟失败 ${failures} 项 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
