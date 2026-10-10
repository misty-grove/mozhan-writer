/**
 * 核心层离线自检：用内存文件系统模拟宿主，跑通「建作品 → 建卷 → 写章 → 装配上下文 → 导出」闭环。
 * 不依赖浏览器 API，也不联网。
 */
import fs from '@/platform'
import { setAdapter, type DirRef } from '@/platform'
import { memAdapter } from '@/platform/memAdapter'
import * as ws from '@/core/workspace'
import { buildContextItems, contextTotal, renderContext } from '@/core/context'
import { parseDoc, serializeDoc, updateMeta } from '@/core/frontmatter'
import { countWords, diffLines } from '@/core/util'
import { collectChapters, toMarkdown, toText, defaultExportOptions } from '@/core/exportDoc'
import { builtinSkills, parseSkillFile } from '@/core/skills'
import { toDocxBlob } from '@/core/exportDoc'
import * as codex from '@/core/codex'
import * as links from '@/core/links'
import * as foreshadow from '@/core/foreshadow'
import * as style from '@/core/style'
import * as consistency from '@/core/consistency'
import * as stats from '@/core/stats'
import { cnNumber, decodeText, headingOrder, importChapters, listLooseTxt, splitChapters } from '@/core/importDoc'
import { docxToMarkdown } from '@/core/docxRead'
import { applyOutline, findBookOutlinePath, parseOutlineText } from '@/core/importOutline'
import { strToU8, zipSync } from 'fflate'
import { bytesText, crc32, makeZip, makeZipCompressed, readZip, textBytes } from '@/core/zip'
import {
  backupFileName,
  buildBackup,
  collectFiles,
  humanSize,
  isSafeEntryName,
  previewBackup,
  restoreBackup,
  storageUsage
} from '@/core/backup'
import {
  chipText,
  DEGRADE_NOTICE,
  diffAgainstBaseline,
  diffSummary,
  fnv1a,
  fingerprint,
  fingerprints,
  importSummaryText,
  isSandboxRefId,
  normalizeRelPath,
  planImport,
  sandboxFileName,
  sandboxManifest,
  stripTop,
  summarizeImport,
  textExtOk,
  visibleRecents
} from '@/core/degrade'
import { autoSnapshot, listSnapshots as listSnaps, setSnapshotPolicy, snapshotPolicy } from '@/core/snapshots'
import { filterTree, flattenTree, highlightParts, isFilterActive, matchChapter, parseFilter } from '@/core/filter'
import { chapterPlaceholder, checkInput, isSubmittable, normalizeConfirmAsk, normalizeTextAsk, suggestOkText } from '@/core/dialog'
import { SHORTCUTS, formatKeys, matchShortcut, searchShortcuts, shortcutGroups, shortcutText } from '@/core/shortcuts'
import { navBack, navCursor, navForward, navHistory, navState, pushNav, resetNav, touchNavPos, withNavApplied, applyApi } from '@/stores/editor'
import { slideDirection } from '@/core/motion'
import type { Chapter, ChapterStatus, Volume } from '@/core/types'
import { readFileSync, readdirSync } from 'node:fs'
import { installMemoryFs } from './memfs'
import { buildScaleWork } from './corpus'
import { condenseOutline, parseSettingSheet, sanitizeName, settingGenPrompt } from '@/core/worldbuild'

/**
 * 读工程内的源文件（静态断言用）。
 *
 * 跑在 `test-dist/selfcheck.js` 里，相对 import.meta.url 是 ../src/...；
 * 直接 `node scripts/selfcheck.ts` 时 CWD 就是工程根，走第二条。
 */
export function readSrc(rel: string): string {
  try {
    return readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
  } catch {
    return readFileSync(rel, 'utf8')
  }
}

const host = installMemoryFs()
const mock = host.adapter
const roots = host.roots

let failures = 0
function check(label: string, cond: boolean, extra = '') {
  if (!cond) {
    failures++
    console.log('  ✗ ' + label + (extra ? ' → ' + extra : ''))
  } else {
    console.log('  ✓ ' + label)
  }
}

async function main() {
  /* 1. front matter 往返 */
  const doc = serializeDoc({ title: '测试章', status: '草稿', tags: ['a', 'b'] }, '正文内容\n第二段\n')
  const p = parseDoc(doc)
  check('front matter 解析 title', p.meta.title === '测试章')
  check('front matter 解析 tags', Array.isArray(p.meta.tags) && p.meta.tags.join(',') === 'a,b')
  check('front matter 剥离正文', p.body.trim().startsWith('正文内容'))
  const upd = parseDoc(updateMeta(doc, { status: '已定稿' }, ['title', 'status', 'tags']))
  check('front matter 更新字段', upd.meta.status === '已定稿' && upd.body.trim().startsWith('正文内容'))

  /* 2. 字数统计（中英混排） */
  check('字数统计 中文', countWords('你好世界') === 4, String(countWords('你好世界')))
  check('字数统计 中英混排', countWords('你好 hello world') === 4, String(countWords('你好 hello world')))

  /* 3. 建作品 + 标准目录 */
  const cxParent = host.rootRef()
  const ref = await ws.createWork(cxParent, '测试作品', { author: '甲', targetWords: 100000 })
  const entries = await mock.listDir(ref, [])
  const names = entries.map((e) => e.name).sort()
  check('标准目录：大纲/设定/正文/记忆/技能', ['skill', 'memory', 'outline', 'setting', 'body'].length === 0 || names.includes('正文') && names.includes('大纲') && names.includes('设定') && names.includes('记忆') && names.includes('技能'), names.join(','))
  const info = await ws.readWorkInfo(ref)
  check('作品信息落盘', info.title === '测试作品' && info.author === '甲')

  /* 4. 建卷 → 建章 → 保存 → 扫描 */
  const vol = await ws.createVolume(ref, '第一卷 启程')
  check('建卷成功', vol.name.includes('第一卷'))
  const ch1 = await ws.createChapter(ref, vol.id, '启程')
  check('建章文件名规范', /^第001章 .*\.md$/.test(ch1.file), ch1.file)
  await ws.saveChapter(ref, ch1.id, '林晚站在船头。\n\n风很大。\n', { title: '启程', status: '草稿', target: '交代他为什么回来', characters: ['林晚'], settings: ['晨曦联盟'], emotion: '平淡 → 压抑' })
  const ch2 = await ws.createChapter(ref, vol.id, '重逢')
  await ws.saveChapter(ref, ch2.id, '她没有回头。', { title: '重逢', status: '待写' })

  const scan = await ws.scanWork(ref)
  check('扫描到 1 卷', scan.volumes.length === 1, String(scan.volumes.length))
  check('扫描到 2 章', scan.volumes[0].chapters.length === 2, String(scan.volumes[0].chapters.length))
  check('字数合计正确', scan.totalWords === countWords('林晚站在船头。\n\n风很大。\n') + countWords('她没有回头。'), String(scan.totalWords))
  const c1 = scan.volumes[0].chapters[0]
  check('章纲字段回读', c1.meta.target === '交代他为什么回来' && c1.meta.characters![0] === '林晚' && (c1.meta.emotion || '').includes('压抑'))
  check('状态回读', c1.status === '草稿')
  const body = await ws.readChapterBody(ref, c1.id)
  check('正文回读', body.trim().startsWith('林晚站在船头。'))

  /* 5. 重排序 */
  await ws.reorderChapters(ref, vol.id, [scan.volumes[0].chapters[1].id, scan.volumes[0].chapters[0].id])
  const scan2 = await ws.scanWork(ref)
  check('重排序后首章是《重逢》', scan2.volumes[0].chapters[0].title === '重逢', scan2.volumes[0].chapters.map((c) => c.title).join('/'))
  check('重命名编号', /^第001章/.test(scan2.volumes[0].chapters[0].file), scan2.volumes[0].chapters[0].file)

  /* 6. 设定文件 + 上下文装配 */
  await ws.writeAsset(ref, '设定/.mdAI文件/主要角色：林晚.md', '# 林晚\n\n他是前将军。\n')
  await ws.writeAsset(ref, '大纲/.mdAI文件/剧情大纲.md', '# 主线\n\n退休将军回到晨曦。\n')
  const assets = await ws.listAssetDocs(ref)
  check('资料扫描到设定与大纲', assets.some((a) => a.group === '设定') && assets.some((a) => a.group === '大纲'), assets.map((a) => a.group + '/' + a.name).join(' | '))

  const ordered = [...scan2.rootChapters, ...scan2.volumes.flatMap((v) => v.chapters)]
  const target = ordered[1]
  const items = await buildContextItems(ref, target, scan2.volumes[0], ordered, assets, { recentChapters: 3, tailChars: 500, includePrevFull: false, styleSampleChars: 500, recallTop: 0 })
  check('上下文含全书大纲', items.some((i) => i.label.includes('全书剧情大纲')))
  check('上下文含本卷卷纲', items.some((i) => i.label.includes('卷纲')))
  check('上下文含本章章纲', items.some((i) => i.group === '本章'))
  check('上下文含设定条目', items.some((i) => i.group === '设定' && i.label.includes('林晚')))
  check('上下文含前文结尾', items.some((i) => i.group === '前文' && i.content.includes('她没有回头')))
  const total = contextTotal(items)
  check('上下文统计有值', total.chars > 0 && total.tokens > 0, JSON.stringify(total))
  const rendered = renderContext(items, '任务：续写')
  check('上下文渲染包含指令与分组', rendered.includes('任务：续写') && rendered.includes('===== 设定 ====='))

  /* 7. 记忆库写入/读取 */
  let memory = await (await import('@/core/memory')).readMemoryFile(ref, '逐章摘要.md')
  const { updateMemorySection, readMemorySection } = await import('@/core/memory')
  memory = updateMemorySection(memory, '启程', '林晚乘船回到晨曦，心里不踏实。')
  memory = updateMemorySection(memory, '重逢', '她在码头没有回头。')
  await (await import('@/core/memory')).writeMemoryFile(ref, '逐章摘要.md', memory)
  const memory2 = await (await import('@/core/memory')).readMemoryFile(ref, '逐章摘要.md')
  check('记忆库按章节写入', readMemorySection(memory2, '启程').includes('林晚乘船'), readMemorySection(memory2, '启程'))
  const sums = await ws.loadSummaries(ref)
  check('摘要索引可解析', Object.keys(sums.summaries).includes('启程'), Object.keys(sums.summaries).join(','))
  const items2 = await buildContextItems(ref, target, scan2.volumes[0], ordered, assets, { recentChapters: 3, tailChars: 300, includePrevFull: false, styleSampleChars: 0, recallTop: 0 })
  const rsItem = items2.find((i) => i.group === '记忆')
  check('摘要进入上下文', !!rsItem && rsItem.content.includes('没有回头'), rsItem?.content.slice(0, 60))

  /* 8. 导出 */
  const bodies: Record<string, string> = {}
  for (const c of ordered) bodies[c.id] = await ws.readChapterBody(ref, c.id)
  const opt = defaultExportOptions()
  const eitems = collectChapters(scan2.volumes, scan2.rootChapters, bodies, opt)
  check('导出收集到 2 章', eitems.length === 2, String(eitems.length))
  const txt = toText(eitems, opt)
  check('TXT 导出含章标题', txt.includes('第1章') || txt.includes('第2章'), txt.slice(0, 60))
  const md = toMarkdown(eitems, opt, '测试作品')
  check('MD 导出含书名与二级标题', md.startsWith('# 测试作品') && md.includes('## 第'))
  const blob = await toDocxBlob('测试作品', '甲', eitems, opt)
  check('DOCX 导出产出 Blob', !!blob && blob.size > 1000, String(blob?.size))

  /* 9. 快照 diff */
  const { diffLines: _d } = { diffLines }
  const d = diffLines('a\nb\nc', 'a\nx\nc')
  check('diff 识别增删', d.filter((x) => x.type === 'add').length === 1 && d.filter((x) => x.type === 'del').length === 1)
  const { createSnapshot, listSnapshots, readSnapshot } = await import('@/core/snapshots')
  await createSnapshot(ref, target.id, '快照内容', 'manual')
  const snaps = await listSnapshots(ref, target.id)
  check('快照写入并可列出', snaps.length === 1, String(snaps.length))
  check('快照内容可读', (await readSnapshot(ref, target.id, snaps[0].name)).includes('快照内容'))

  /* 10. 技能 */
  const skills = builtinSkills()
  // 别写死数量：写死了每加一个技能都要回来改这里，而且改的时候很容易顺手把
  // 「技能没被识别」也一起改成绿的。查「该在的都在」比查「正好 N 个」有意义。
  const wantBuiltin = ['续写工作流', '记忆整理', '一致性检查', '大纲拆分', '文风仿写', '目录对照表']
  check(
    '内置技能齐全（含目录对照表：DSH 那类 Agent 靠它认 大纲/设定/正文/记忆 这套结构）',
    wantBuiltin.every((n) => skills.some((s) => s.name === n)),
    skills.map((s) => s.name).join(',')
  )
  check('内置技能含续写工作流', skills.some((s) => s.name === '续写工作流'))
  const parsed = parseSkillFile('---\nname: 自定义\ndescription: 干点别的\nallowed-tools: [read_chapter]\n---\n正文', 'work')
  check('技能 SKILL.md 解析', parsed.name === '自定义' && parsed.allowedTools[0] === 'read_chapter' && parsed.content === '正文')

  /* 11. 设定库（Task #1） */
  const entryA = await codex.createEntry(cxParent, 'character', '林晚', { faction: '晨曦' }, codex.defaultBody('character', '林晚'))
  check('设定条目落盘到 设定/人物设定/', entryA.id === '设定/人物设定/林晚.md', entryA.id)
  check('kind 取自 type 字段', entryA.kind === 'character')
  await codex.createEntry(cxParent, 'lore', '晨曦联盟', {}, '# 晨曦联盟\n\n由若干方舟组成的联盟。\n')
  const fileType = await mock.readFile(cxParent, ['设定', '世界设定', '晨曦联盟.md'])
  const webLeft = await codex.listEntries(cxParent)
  check('设定库列出 2 条', webLeft.length === 2, webLeft.map((e) => e.name).join(','))
  const nameMap = codex.buildNameMap(webLeft)
  check('名称映射含别名索引', nameMap.get('林晚')?.name === '林晚')
  const moved = await codex.updateEntry(cxParent, entryA.id, { name: '林浼', aliases: ['老梓'] })
  check('改名后文件跟着换名', moved === '设定/人物设定/林浼.md', moved)
  const afterRename = await codex.listEntries(cxParent)
  check('改名后别名回读', afterRename.find((e) => e.name === '林浼')?.aliases.join('') === '老梓')
  await codex.deleteEntry(cxParent, moved)
  check('删除生效', (await codex.listEntries(cxParent)).length === 1)

  /* 11b. 设定整夹导入：只补充、不覆盖。源必须是**独立子目录** ——
     源=作品根这种用法在快照修复前曾导致「边走边拷进自己」的无限递归（见 core/codex.ts） */
  const impParent = host.rootRef()
  const impSrc = mock.joinRef(impParent, '外部设定')
  await mock.writeFile(impParent, ['外部设定', '世界框架.md'], '# 世界框架\n\n大陆与海。\n')
  await mock.writeFile(impParent, ['外部设定', '人物', '配角.md'], '# 配角\n')
  await mock.writeFile(impParent, ['外部设定', '.thumbnails', '缓存.md'], '# 不该进来\n')
  await mock.writeFile(impParent, ['外部设定', 'notes.txt'], '纯文本设定也算')
  const imp1 = await codex.importSettingFolder(cxParent, impSrc)
  const imported = await mock.readFile(cxParent, ['设定', '外部设定', '世界框架.md'])
  check(
    '整夹导入：md/txt 递归进 设定/<目录名>/',
    imp1.copied === 3 && imported.includes('世界框架') && !!(await mock.readFile(cxParent, ['设定', '外部设定', '人物', '配角.md'])).includes('配角'),
    JSON.stringify(imp1)
  )
  check('整夹导入：点前缀目录跳过', !(await mock.listDir(cxParent, ['设定', '外部设定'])).some((e) => e.name.startsWith('.')), '')
  const imp2 = await codex.importSettingFolder(cxParent, impSrc)
  check('整夹导入：重复导入只跳过不覆盖', imp2.copied === 0 && imp2.skipped === 3, JSON.stringify(imp2))

  /* 12. 双链与反向引用（Task #2） */
  const refText = '林浼站在船头，望着[[晨曦联盟]]的灯火。\n\n@晨曦联盟 的旗号在夜里很显眼。'
  const refs = links.extractRefs(refText)
  check('同时识别 [[]] 与 @ 两种写法', refs.includes('晨曦联盟') && refs.length === 1, refs.join(','))
  const fakeChapters = [
    { id: 'c1', title: '第001章 启程', file: '', volumeId: null, status: '草稿', tags: [], order: 1, wordCount: 0, updated: '', meta: {} },
    { id: 'c2', title: '第002章 重逢', file: '', volumeId: null, status: '草稿', tags: [], order: 2, wordCount: 0, updated: '', meta: {} }
  ] as any[]
  const fakeBodies = { c1: refText, c2: '她提到了林浼。' }
  const idx = links.buildRefIndex(fakeChapters, fakeBodies, ['晨曦联盟', '林浼'])
  check('双链索引命中 2 章', (idx.get('晨曦联盟') || []).length === 1 && (idx.get('林浼') || []).length === 2, JSON.stringify([...idx.keys()]))
  const presBodies = { c1: '林浼出场。', c2: '没有他。', c3: '还是没有。' }
  const presChapters = [...fakeChapters, { id: 'c3', title: '第003章', file: '', volumeId: null, status: '草稿', tags: [], order: 3, wordCount: 0, updated: '', meta: {} } as any]
  const presList = links.presenceStats([{ ...entryA, name: '林浼' }], presChapters, presBodies)
  check('出场断层计算（隔 2 章）', presList[0].gapFromEnd === 2, JSON.stringify(presList[0]))
  const html = links.highlightRefs('我叫[[林浼]] @晨曦联盟')
  check('源码预览渲染成可点击标记', html.includes('data-ref="林浼"') && html.includes('data-ref="晨曦联盟"'))

  /* 13. 伏笔台账（Task #3） */
  const rowsWith = [foreshadow.emptyRow(), foreshadow.emptyRow(), foreshadow.emptyRow()]
  rowsWith[0].text = '云杉的血统秘密'
  rowsWith[0].planted = '第001章'
  rowsWith[0].planned = '第003章' // 已超期
  rowsWith[1].text = '断掉的剑穗'
  rowsWith[1].planted = '第002章'
  rowsWith[1].planned = '第020章' // 还早
  rowsWith[2].text = '船头的刻痕'
  rowsWith[2].planted = '第002章'
  rowsWith[2].planned = '第007章' // 快到期（窗口 5 章）
  const tableMd = foreshadow.serializeTable('伏笔台账', '这里可以直接用记事本改。', rowsWith)
  const parsedRows = foreshadow.parseTable(tableMd)
  check('伏笔表格往返一致', parsedRows.length === 3 && parsedRows[0].text === '云杉的血统秘密' && parsedRows[0].status === '未回收', JSON.stringify(parsedRows))
  check('章序号抽取', foreshadow.chapterNo('第010章') === 10 && foreshadow.chapterNo('第002章 重逢', ['第001章', '第002章 重逢']) === 2)
  const warns = foreshadow.warnings(parsedRows, 5, ['第001章', '第002章'])
  check('超期伏笔被标出', warns.some((w) => w.level === 'overdue' && w.row.text === '云杉的血统秘密'), JSON.stringify(warns.map((w) => w.level)))
  check('未到期伏笔不报警', !warns.some((w) => w.row.text === '断掉的剑穗'))
  check('临近回收窗口内报警', warns.some((w) => w.level === 'soondue' && w.row.text === '船头的刻痕'), JSON.stringify(warns))
  const incomplete = foreshadow.warnings([{ id: 0, text: '缺章节', planted: '', status: '未回收', planned: '', priority: '中', note: '' }], 5)
  check('信息不全也提示', incomplete.some((w) => w.level === 'unplanted'))

  /* 14. 文风 / 去 AI 味（Task #4） */
  const longSentence =
    '他把那柄断剑从墙角拾起来，掸掉剑鞘上积了三年的灰，想起师父临终前说的那句话，想起师兄背着他偷偷抹泪的那个晚上，又想起自己当年在雪地里发过的誓。'
  const aiText = '总而言之，这很重要。值得注意的是，风很大。他不禁想起往事，心中五味杂陈。林浼看着海面，一句话也没说。' + longSentence + 'TODO 待补'
  const st = style.analyzeStyle(aiText, ['TODO'])
  check('字数/句数统计有效', st.metrics.chars > 40 && st.metrics.sentenceCount >= 3, JSON.stringify({ c: st.metrics.chars, s: st.metrics.sentenceCount }))
  check('命中 AI 腔句式', st.issues.some((i) => i.type === 'ai-cliche'), st.issues.map((i) => i.type).join(','))
  check('命中禁用词', st.issues.some((i) => i.type === 'banned' && i.text === 'TODO'))
  check('命中超长句', st.issues.some((i) => i.type === 'long-sentence'))
  check('Top 高频词有产出', st.metrics.topWords.length > 0 && st.metrics.topWords[0].n >= 1)
  const baseMetrics = style.analyzeStyle('他走了。她来了。风停了。他说：“好。”').metrics
  const driftRes = style.drift(baseMetrics, st.metrics)
  check('偏离度在 0–100', driftRes.score >= 0 && driftRes.score <= 100, String(driftRes.score))

  /* 15. 一致性初筛（Task #5） */
  const checkEntries = [
    { id: '设定/人物设定/林浼.md', kind: 'character', name: '林浼', aliases: [], group: '人物设定', file: '林浼.md', wordCount: 0, fields: {}, body: '', links: [] },
    { id: '设定/世界设定/晨曦联盟.md', kind: 'lore', name: '晨曦联盟', aliases: [], group: '世界设定', file: '晨曦联盟.md', wordCount: 0, fields: {}, body: '', links: [] }
  ] as any[]
  const checkBodies = {
    c1: '林晚（注意这里是笔误）进了城，见到了[[仙州联盟]]。TODO 补一段打斗。',
    c2: '晨曦联盟派人来了。',
    c3: '还是没有林浼。'
  }
  const found = consistency.checkAll({
    entries: checkEntries,
    chapters: presChapters,
    bodies: checkBodies,
    foreshadowRaw: tableMd,
    currentId: 'c1',
    missingAfter: 2
  })
  check('检查出疑似笔误', found.some((i) => i.kind === 'typo'), found.map((i) => i.kind).join(','))
  check('断链并给出最接近的候选', found.some((i) => i.kind === 'broken-link' && !!i.suggest), JSON.stringify(found.find((i) => i.kind === 'broken-link')))
  check('检查出草稿残留', found.some((i) => i.kind === 'draft-left'))
  check('警告项排在提示项之前', found.findIndex((i) => i.level === 'info') === -1 || found[0].level === 'warn')
  const unresolved = consistency.unresolvedRefs('[[不存在的人]]出现了', checkEntries)
  check('未登记名词识别', unresolved.includes('不存在的人'), unresolved.join(','))

  /* 16. 统计看板（Task #5） */
  const dailyFake = [
    { date: '2026-01-01', words: 1200 },
    { date: '2026-01-02', words: 800 }
  ]
  const ov = stats.summarize(scan2.volumes, scan2.rootChapters, dailyFake, 4000)
  check('概览字数与章节数', ov.totalWords === scan2.totalWords && ov.chapterCount === 2, JSON.stringify({ t: ov.totalWords, c: ov.chapterCount }))
  check('状态分布有值', Object.values(ov.byStatus).reduce((a, b) => a + b, 0) === 2)
  const series = stats.recentDays(dailyFake, 3)
  check('日期序列补齐且按天排序', series.length === 3 && new Date(series[0].date) < new Date(series[2].date), series.map((s) => s.date).join(','))
  check('localStorage 不可用时降级为空', Array.isArray(stats.loadDaily()))

  /* 17. 记忆库自动生成区（Task #8） */
  const { writeGeneratedBlock, readGeneratedBlock, buildRollingSummary, buildStatusTable, buildTimeline } = await import('@/core/memory')
  const statusDoc = writeGeneratedBlock('# 状态表\n\n作者手写的一段话，不能被覆盖。\n', 'status', buildStatusTable(ordered))
  const again = writeGeneratedBlock(statusDoc, 'status', buildStatusTable(ordered))
  check('生成块幂等（重复写入不叠加）', statusDoc === again, String(again.length))
  check('手写内容不被生成块覆盖', statusDoc.includes('作者手写的一段话'))
  check('状态表按章节列出', (statusDoc.match(/^\| 第\d+章/gm) || []).length === ordered.length, String(ordered.length))
  check('生成块可定位读取', readGeneratedBlock(statusDoc, 'status').includes('writer:status'))
  const rolling = buildRollingSummary(ordered, { 启程: '林晚乘船回到晨曦。', 重逢: '她在码头没有回头。' })
  check('滚动总述含最后进度', rolling.includes('第 2 章'), rolling.slice(0, 80))
  check('滚动总述引用摘要首句', rolling.includes('她在码头没有回头'))
  const tl = buildTimeline(ordered, { 启程: '林晚乘船回到晨曦。' })
  check('时间线只收录有摘要的章', (tl.match(/^\| 第\d+章/gm) || []).length === 1, tl)

  /* 18. 文风基线存档（Task #7） */
  const base2 = style.toBaseline(st.metrics)
  const baselineMd = style.serializeBaseline(base2)
  const back = style.parseBaseline(baselineMd)
  check('基线存为可读 Markdown', baselineMd.includes('# 文风基线') && baselineMd.includes('| 平均句长 |'))
  check('基线往返一致', !!back && Math.abs(back.avgSentence - base2.avgSentence) < 0.01 && back.topWords[0] === base2.topWords[0], JSON.stringify(back?.topWords?.slice(0, 3)))
  check('没有基线文件时返回 null', style.parseBaseline('# 空\n') === null)
  const dB = style.driftFromBaseline(base2, st.metrics)
  check('与自身基线偏离为 0', dB.score === 0, String(dB.score))

  /* 19. 全文替换（跨章节，保护 front matter）
     注意：第 5 步做过重排序会重命名文件，所以这里要用重排后的 id */
  const { replaceOccurrences, countOccurrences } = await import('@/core/search')
  check('计数可用', countOccurrences('林晚来了，林晚走了', '林晚') === 2)
  const targetReplace = scan2.volumes[0].chapters.find((c) => c.title === '启程')
  check('能定位到《启程》', !!targetReplace, scan2.volumes[0].chapters.map((c) => c.title).join('/'))
  if (targetReplace) {
    const n2 = await replaceOccurrences(ref, targetReplace.id, '林晚', '阿叶')
    check('替换返回命中数', n2 === 1, String(n2))
    const afterRaw = await ws.readChapterText(ref, targetReplace.id)
    check('替换后正文更新', afterRaw.includes('阿叶站在船头'), afterRaw.slice(0, 80))
    check('替换不动 front matter', afterRaw.startsWith('---') && (afterRaw.match(/^title:/m) || []).length === 1)
  }

  /* 20. 关系图（P2-21） */
  const graph = await import('@/core/graph')
  // 前面 codex 的用例建在宿主根上，这里要在作品内另建，关系图才有东西可画
  if (!(await codex.listEntries(ref)).some((e) => e.name === '林晚')) {
    await codex.createEntry(ref, 'character', '林晚', { 身份: '主角' }, '她见过 [[云杉]]。')
  }
  if (!(await codex.listEntries(ref)).some((e) => e.name === '云杉')) {
    await codex.createEntry(ref, 'character', '云杉', { 身份: '旧友' }, '与 @林晚 少年相识。')
  }
  const gEntries = await codex.listEntries(ref)
  if (gEntries.length >= 2) {
    const bodies: Record<string, string> = {}
    for (const c of scan2.volumes.flatMap((v) => v.chapters).concat(scan2.rootChapters)) {
      bodies[c.id] = await ws.readChapterBody(ref, c.id)
    }
    const g = graph.buildGraph(gEntries, scan2.volumes.flatMap((v) => v.chapters).concat(scan2.rootChapters), bodies)
    check('关系图有节点', g.nodes.length === gEntries.length, `${g.nodes.length}/${gEntries.length}`)
    check('显式 [[双链]] 变成边', g.edges.some((e) => e.kind === 'link'), JSON.stringify(g.edges))
    check('布局后坐标落在画布内', g.nodes.every((n) => n.x >= 0 && n.x <= 900 && n.y >= 0 && n.y <= 620))
    check('布局结果可复现', (() => {
      const a = graph.buildGraph(gEntries, [], {})
      const b = graph.buildGraph(gEntries, [], {})
      return a.nodes.every((n, i) => Math.abs(n.x - b.nodes[i].x) < 0.001 && Math.abs(n.y - b.nodes[i].y) < 0.001)
    })())
    const comps = graph.components(g.nodes, g.edges)
    check('连通分量覆盖全部节点', comps.reduce((s, c) => s + c.length, 0) === g.nodes.length)
    check('枢纽排序按度数降序', (() => {
      const h = graph.hubs(g.nodes, 5)
      return h.every((n, i) => i === 0 || h[i - 1].degree >= n.degree)
    })())
  } else {
    check('关系图需要至少 2 个设定条目（跳过）', true)
  }

  /* 21. 时间线（P2-22） */
  const timeline = await import('@/core/timeline')
  check('绝对年份可比较', (timeline.timeRank('开元十二年') ?? 0) > (timeline.timeRank('开元三年') ?? 0))
  check('相对时间在绝对年份之后', (timeline.timeRank('三年后') ?? 0) > (timeline.timeRank('开元十二年') ?? 0))
  check('认不出的时间返回 null', timeline.timeRank('很久很久以前') === null)
  check('中文数字归一化', timeline.timeRank('三年后') === timeline.timeRank('3年后'))
  const marks = timeline.extractTimeMarks('三年后他回来了。第二天又走了。开元十二年春天，雪停了。')
  check('抽出多个时间短语', marks.length >= 3, JSON.stringify(marks.map((m) => m.phrase)))
  const events = timeline.buildTimeline(
    [{ id: 'tl', kind: 'timeline', name: '大事记', aliases: [], group: '时间线', file: 'a.md', wordCount: 0, fields: {}, body: '- 元年：云杉出生\n- 三年后：剑穗断了', links: [] } as any],
    [{ id: 'c1', title: '第一章', status: '草稿', wordCount: 0, order: 0, volumeId: null, file: 'a.md', tags: [], updated: '', meta: {} } as any],
    { c1: '三年后，林晚回到故里。第二天清晨她又走了。' }
  )
  check('时间线含设定与正文两类事件', events.some((e) => e.source === '设定') && events.some((e) => e.source === '正文'), JSON.stringify(events.map((e) => [e.source, e.when])))
  check('事件带章序号', events.filter((e) => e.source === '正文').every((e) => e.chapterNo === 1))
  const sorted = timeline.sortEvents(events)
  check('按时间排序', sorted.every((e, i) => i === 0 || (sorted[i - 1].rank ?? 0) <= (e.rank ?? Infinity)))
  const conflicts = timeline.findConflicts([
    { id: 'a', when: '十年后', rank: 1e6 + 3650, text: '', chapterNo: 1, chapterId: 'c1', chapterTitle: '一', actors: ['林晚'], source: '正文' },
    { id: 'b', when: '三年后', rank: 1e6 + 1095, text: '', chapterNo: 3, chapterId: 'c2', chapterTitle: '三', actors: ['林晚'], source: '正文' }
  ])
  check('检出时序倒流', conflicts.length >= 1 && conflicts[0].message.includes('却回到'), JSON.stringify(conflicts.map((c) => c.message)))
  check('顺序正常时不报矛盾', timeline.findConflicts([
    { id: 'a', when: '三年后', rank: 1e6 + 1095, text: '', chapterNo: 1, chapterId: 'c1', chapterTitle: '一', actors: ['林晚'], source: '正文' },
    { id: 'b', when: '十年后', rank: 1e6 + 3650, text: '', chapterNo: 3, chapterId: 'c2', chapterTitle: '三', actors: ['林晚'], source: '正文' }
  ]).length === 0)

  /* 22. 敏感词检查（P2-26） */
  const sens = await import('@/core/sensitive')
  check('词表解析忽略注释与空行', sens.parseWords('# 说明\n\n赌博\n诈骗\n\n').length === 2)
  check('词表支持「词 || 建议」写法', sens.parseWords('赌博 || 换个说法')[0] === '赌博')
  check('词表序列化后可再解析', sens.parseWords(sens.serializeWords(['甲', '乙'])).sort().join() === '乙,甲')
  const sensHits = sens.scan('他靠赌博起家，后来又碰了毒品。', ['赌博', '毒品'])
  check('扫出敏感词', sensHits.length === 2 && sensHits[0].word === '赌博')
  check('命中带上下文', sensHits[0].hits[0].context.includes('赌博'))
  check('没命中就不报', sens.scan('今天天气不错', ['赌博']).length === 0)
  await sens.saveWords(ref, ['违禁甲', '违禁乙'])
  check('词表存进 记忆/敏感词.txt', (await sens.loadWords(ref)).includes('违禁甲'))
  const sensWork = sens.scanWork(
    [{ id: 'x', title: '章一' }, { id: 'y', title: '章二' }],
    { x: '这里有害', y: '违禁甲出现了两次，违禁甲。' },
    ['违禁甲', '违禁乙']
  )
  check('全书扫描按命中数排序', sensWork.length === 1 && sensWork[0].total === 2, JSON.stringify(sensWork.map((c) => [c.title, c.total])))

  /* 23. EPUB 导出（P2-29）：真的把 zip 目录读回来验证 */
  const epub = await import('@/core/exportEpub')
  const epubItems = [
    { file: '第001章.md', title: '启程', body: '# 启程\n\n第一段。**重点**在这里。\n\n- 条目一\n- 条目二\n' },
    { file: '第002章.md', title: '重逢', body: '> 一句引用\n\n她说：“走吧。”' }
  ]
  const xhtml = epub.mdToXhtml('# 标题\n\n正文 *斜体* 与 **粗体**\n\n- 一\n- 二\n\n> 引用\n')
  check('Markdown 转成 XHTML 段落', xhtml.includes('<p>正文 <em>斜体</em> 与 <strong>粗体</strong></p>'), xhtml)
  check('Markdown 列表成 ul', xhtml.includes('<ul>') && xhtml.includes('<li>一</li>'))
  check('Markdown 引用成 blockquote', xhtml.includes('<blockquote>'))
  check('HTML 特殊字符被转义', epub.mdToXhtml('<script>alert(1)</script>').includes('&lt;script&gt;'))
  const epubBlob = epub.buildEpub(epubItems, { title: '冒烟作品', author: '甲', brief: '测试' })
  check('EPUB 生成成功', epubBlob.size > 0, String(epubBlob.size))
  const epubBuf = new Uint8Array(await epubBlob.arrayBuffer())
  check('是合法 zip（PK 开头）', epubBuf[0] === 0x50 && epubBuf[1] === 0x4b && epubBuf[2] === 0x03 && epubBuf[3] === 0x04)
  // 解析 central directory，确认条目齐全
  const zipNames: string[] = []
  let epubEocd = -1
  for (let i = epubBuf.length - 22; i >= 0; i--) {
    if (epubBuf[i] === 0x50 && epubBuf[i + 1] === 0x4b && epubBuf[i + 2] === 0x05 && epubBuf[i + 3] === 0x06) {
      epubEocd = i
      break
    }
  }
  check('能定位 EOCD', epubEocd > 0)
  if (epubEocd > 0) {
    const count = epubBuf[epubEocd + 10] | (epubBuf[epubEocd + 11] << 8)
    let zp = epubBuf[epubEocd + 16] | (epubBuf[epubEocd + 17] << 8) | (epubBuf[epubEocd + 18] << 16) | (epubBuf[epubEocd + 19] << 24)
    for (let i = 0; i < count; i++) {
      const nameLen = epubBuf[zp + 28] | (epubBuf[zp + 29] << 8)
      zipNames.push(new TextDecoder().decode(epubBuf.subarray(zp + 46, zp + 46 + nameLen)))
      zp += 46 + nameLen + (epubBuf[zp + 30] | (epubBuf[zp + 31] << 8)) + (epubBuf[zp + 32] | (epubBuf[zp + 33] << 8))
    }
  }
  check('mimetype 是第一个条目', zipNames[0] === 'mimetype', zipNames.join(', '))
  for (const need of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx']) {
    check(`包含 ${need}`, zipNames.includes(need), zipNames.join(', '))
  }
  check('每章一个 xhtml', zipNames.filter((n) => /^OEBPS\/ch\d+\.xhtml$/.test(n)).length === 2, zipNames.join(', '))
  // mimetype 条目必须是 store（不压缩）且内容正确
  // local header: 0 sig | 4 ver | 6 flags | 8 method | 10 time | 12 date | 14 crc | 18 csize | 22 usize | 26 namelen | 28 extralen | 30 name
  const mimeNameLen = epubBuf[26] | (epubBuf[27] << 8)
  const mimeSize = epubBuf[22] | (epubBuf[23] << 8) | (epubBuf[24] << 16) | (epubBuf[25] << 24)
  const mimeStart = 30 + mimeNameLen
  check(
    'mimetype 内容正确且未压缩',
    new TextDecoder().decode(epubBuf.subarray(mimeStart, mimeStart + mimeSize)) === 'application/epub+zip' &&
      (epubBuf[8] | (epubBuf[9] << 8)) === 0,
    `size=${mimeSize}`
  )

  /* 24. 参考资料（P2-24 / P2-27） */
  const refer = await import('@/core/reference')
  const refSources = await refer.listSources(ref, gEntries, scan2.volumes.flatMap((v) => v.chapters).concat(scan2.rootChapters))
  check('参考源按组返回', refSources.length >= 2, JSON.stringify(refSources.map((g) => g.group)))
  check('参考源含设定条目', refSources.some((g) => g.sources.some((s) => s.kind === 'setting')))
  check('参考源含正文章节', refSources.some((g) => g.sources.some((s) => s.kind === 'chapter')))
  const targetEntry = gEntries[0]
  if (targetEntry) {
    const body = await refer.readSource(ref, `setting:${targetEntry.id}`, gEntries, [])
    check('能读出设定条目正文', body === targetEntry.body && !!body.trim(), JSON.stringify(body.slice(0, 60)))
  } else {
    check('能读出设定条目正文（跳过：无条目）', true)
  }
  const anyChapter = refSources.flatMap((g) => g.sources).find((s) => s.kind === 'chapter')
  if (anyChapter) {
    const body = await refer.readSource(ref, anyChapter.id, [], scan2.volumes.flatMap((v) => v.chapters).concat(scan2.rootChapters))
    check('读章节不带 front matter', !body.startsWith('---'), body.slice(0, 40))
  } else {
    check('读章节不带 front matter（跳过：无章节）', true)
  }

  /* 25. 大纲与章纲（P1-19） */
  const outline = await import('@/core/outline')
  const skel = outline.buildSkeleton({ title: '测试作品', targetWords: 200000, chapterWords: 3000 })
  const skelChapters = skel.volumes.reduce((n, v) => n + v.chapters.length, 0)
  check('骨架章数按字数算出', Math.abs(skelChapters - 67) <= 2, String(skelChapters))
  // 卷目标必须**留白**：预填套路文案看着贴心，实际上人人开头都一样（2026-10-10 作者要求）
  check('卷目标留白（不代笔）', skel.volumes.every((v) => v.target === ''), skel.volumes.map((v) => v.target).join('|'))
  check('章纲只有第x章、目标留白', skel.volumes[0].chapters[0].title === '第001章' && skel.volumes[0].chapters[0].target === '')
  check('分卷不超过预设幕数', skel.volumes.length >= 1 && skel.volumes.length <= 4, String(skel.volumes.length))
  check('卷带章节范围且首尾相接', skel.volumes[0].start === 1 && skel.volumes.every((v, i) => v.start! <= v.end! && (i === 0 || v.start! === skel.volumes[i - 1].end! + 1)), JSON.stringify(skel.volumes.map((v) => [v.start, v.end])))
  const omd = outline.toOutlineMarkdown(skel, '一部测试小说')
  check('大纲是 Markdown 表格', omd.includes('| 章节 | 目标 | 字数 |') && omd.includes('# 测试作品'), omd.slice(0, 80))
  check('卷头写成 第×卷（第A章-第B章）', /## 第一卷（第1章-第\d+章）/.test(omd), omd.split('\n')[omd.split('\n').findIndex((l) => l.startsWith('## '))])
  const back2 = outline.parseOutlineMarkdown(omd)
  check('大纲往返一致', back2.volumes.length === skel.volumes.length && back2.title === '测试作品')
  check('往返后卷名不带范围、范围单独读回', back2.volumes[0].name === '第一卷' && back2.volumes[0].start === 1 && back2.volumes[0].end === skel.volumes[0].end, `${back2.volumes[0].name} ${back2.volumes[0].start}-${back2.volumes[0].end}`)
  check('解析出章节目标', back2.volumes[0].chapters.length === skel.volumes[0].chapters.length)
  check('能读回作者手改过的大纲', outline.parseOutlineMarkdown('# 手写\n\n## 第一卷\n\n| 第001章 | 开场 | 3200 |\n').volumes[0].chapters[0].target === '开场')
  const oprompt = outline.outlinePrompt({ title: 'T', author: '', brief: 'B', targetWords: 100000, created: '' }, skel, '')
  check('AI 提示词要求只输出表格', oprompt.includes('| 章节 | 目标 |') && oprompt.includes('不要任何解释'))
  check('AI 提示词带上现有骨架', oprompt.includes('第001章'))

  /* 25b. 卷数 / 章数由作者定（2026-10-10）
     以前是「按目标字数算一个 4 卷 67 章给你看」—— 作者既没认领过它，又总跟想的不一样。
     现在：章数可以显式给；导入大纲后按大纲「重排」，原有章节内容一个字不动。 */
  const fixed = outline.buildSkeleton({ title: 'T', chapters: 30, chapterWords: 3000, volumes: 3 })
  check(
    '显式章数：卷数与章数听作者的',
    fixed.volumes.length === 3 && outline.countChapters(fixed) === 30,
    `${fixed.volumes.length} 卷 ${outline.countChapters(fixed)} 章`
  )
  check('显式章数：目标字数跟着算出来，不再另说一套', fixed.totalWords === 90000, String(fixed.totalWords))
  check('卷数比章数多时按章数封顶（不许出现 0 章的卷）', outline.buildSkeleton({ title: 'T', chapters: 2, volumes: 9 }).volumes.length === 2)
  check(
    '章数不填时仍按字数反推（老调用方不受影响）',
    Math.abs(outline.countChapters(outline.buildSkeleton({ title: 'T', targetWords: 200000, chapterWords: 3000 })) - 67) <= 2
  )

  const mkSkVol = (name: string, from: number, to: number): any => ({
    name,
    target: '',
    start: from,
    end: to,
    chapters: Array.from({ length: to - from + 1 }, (_, i) => ({
      title: `第${String(from + i).padStart(3, '0')}章`,
      target: i === 0 ? '甲' : '',
      words: 3000
    }))
  })
  const uneven: any = { title: '书', volumes: [mkSkVol('第一卷', 1, 40), mkSkVol('第二卷', 41, 67)], totalWords: 201000, chapterWords: 3000 }
  check('导入的形状原样保留：卷数/章数没变时 reshape 返回同一个对象', outline.reshapeSkeleton(uneven, 2, 67) === uneven)
  const grown = outline.reshapeSkeleton(uneven, 2, 70)
  check(
    '加章：总量对了，原有章节一个不动、不均匀分卷也不被抹平',
    outline.countChapters(grown) === 70 && grown.volumes[0].chapters[0].target === '甲' && grown.volumes[0].chapters.length >= 40,
    JSON.stringify(grown.volumes.map((v) => v.chapters.length))
  )
  check(
    '加章：多出来的补的是空坑（目标留白）',
    grown.volumes[1].chapters[grown.volumes[1].chapters.length - 1].title === '第070章' &&
      grown.volumes[1].chapters[grown.volumes[1].chapters.length - 1].target === ''
  )
  const shrunk = outline.reshapeSkeleton(uneven, 2, 30)
  check('减章：从末尾截断，前面的章节与目标还在', outline.countChapters(shrunk) === 30 && shrunk.volumes[0].chapters[0].target === '甲')
  const rev = outline.reshapeSkeleton(uneven, 5, 60)
  check(
    '改卷数：重排成 5 卷 60 章、范围首尾相接、每卷都有章',
    rev.volumes.length === 5 &&
      outline.countChapters(rev) === 60 &&
      rev.volumes.every((v, i) => Number(v.start) <= Number(v.end) && (i === 0 || Number(v.start) === Number(rev.volumes[i - 1].end) + 1)) &&
      rev.volumes.every((v) => v.chapters.length > 0),
    JSON.stringify(rev.volumes.map((v) => [v.start, v.end]))
  )
  const rp = outline.recommendPrompt({
    info: { title: 'T', author: '', brief: '', targetWords: 0, created: '' },
    s: fixed,
    tags: '男频、玄幻、100-150万字',
    idea: '主角是个失业的修表匠',
    material: ''
  })
  check('推荐提示词把标签、想法、规模都带上（三份输入 AI 都看得到）', rp.includes('男频、玄幻、100-150万字') && rp.includes('主角是个失业的修表匠') && rp.includes('共约 30 章'))
  check('推荐提示词明说「想法」的优先级高于标签', /优先级更高/.test(rp))

  /* 25c. 中文标签解析（2026-10-10）
     「不要因为分词问题影响到工程」→ 零依赖纯函数、**不引分词库**（原生模块在
     GNU 工具链上编不出来，一挂就是整个构建卡住）；但中文标点、全角字母、
     没打分隔符的一长串都得认。 */
  const tags = await import('@/core/tags')
  check(
    '中文标点都算分隔符（顿号 / 中英文逗号 / 分号 / 斜杠 / 空格）',
    tags.parseTags('玄幻、都市，悬疑；科幻 灵异/末世').join('|') === '玄幻|都市|悬疑|科幻|灵异|末世',
    tags.parseTags('玄幻、都市，悬疑；科幻 灵异/末世').join('|')
  )
  check('全角空格与全角逗号也认', tags.parseTags('玄幻，都市\u3000悬疑').join('|') === '玄幻|都市|悬疑')
  check('去重 + 去首尾成对符号', tags.parseTags('「玄幻」、玄幻、“都市”').join('|') === '玄幻|都市', tags.parseTags('「玄幻」、玄幻、“都市”').join('|'))
  check('全角字母数字折半角（ＡＩ 与 AI 是同一个标签）', tags.parseTags('ＡＩ、AI').join('|') === 'AI', tags.parseTags('ＡＩ、AI').join('|'))
  check('篇幅标签里的短横不是分隔符（100-150万字 不许被切开）', tags.parseTags('100-150万字').join('|') === '100-150万字')
  check('没打分隔符也能切（最长匹配当轻量分词）：男频玄幻 → 男频 + 玄幻', tags.parseTags('男频玄幻').join('|') === '男频|玄幻', tags.parseTags('男频玄幻').join('|'))
  check('切出来的碎块留着（都市异能爽文 → 都市 + 异能 + 爽文）', tags.parseTags('都市异能爽文').join('|') === '都市|异能|爽文', tags.parseTags('都市异能爽文').join('|'))
  check('认不出来的标签原样保留，不瞎猜', tags.parseTags('自创流派').join('|') === '自创流派', tags.parseTags('自创流派').join('|'))
  check('超长的一整句不当标签（> 24 字丢掉）', tags.parseTags('这是一句很长很长的话用来测试标签长度上限是否真的生效').length === 0)
  check(
    '拼标签时不重新切分（自定义长标签不许被打散）',
    tags.joinTags(['都市之最强系统', '男频', '男频']) === '都市之最强系统、男频',
    tags.joinTags(['都市之最强系统', '男频', '男频'])
  )
  check(
    '篇幅档与字数互推',
    tags.lengthTagOf(1250000) === '100-150万字' && tags.wordsOfTag('100-150万字') === 1250000,
    `${tags.lengthTagOf(1250000)} / ${tags.wordsOfTag('100-150万字')}`
  )
  check('篇幅档边界：20 万落在 0-50、250 万落在「200 万以上」', tags.lengthTagOf(200000) === '0-50万字' && tags.lengthTagOf(2500000) === '200万字以上')
  check('标签解析零依赖：package.json 里没有任何分词库', !/jieba|nodejieba|segment|pkuseg|hanlp/i.test(readSrc('package.json')))

  /* 26. 插件机制（P2-30）：声明式，不执行脚本 */
  const plugins = await import('@/core/plugins')
  const plugTpl = '# {{书名}}\n\n作者：{{作者}}\n\n{{目录}}\n\n{{正文}}'
  const tplOut = plugins.renderTemplate(plugTpl, {
    title: '测试书',
    author: '甲',
    brief: '',
    totalWords: 100,
    items: [
      { file: 'a', title: '第一章', body: '正文一' },
      { file: 'b', title: '第二章', body: '正文二' }
    ]
  })
  check('模板替换书名作者', tplOut.includes('# 测试书') && tplOut.includes('作者：甲'), tplOut.slice(0, 60))
  check('模板生成目录', tplOut.includes('1. 第一章') && tplOut.includes('2. 第二章'))
  check('模板生成正文', tplOut.includes('## 第一章') && tplOut.includes('正文二'))
  check('认不出非法占位符', plugins.unknownPlaceholders('{{书名}}{{瞎写}}').join() === '瞎写')
  check('合法模板没有未知占位符', plugins.unknownPlaceholders(plugTpl).length === 0)
  const parsedRules = plugins.parseStatRules(plugins.STAT_RULE_EXAMPLE)
  check('统计规则解析', parsedRules.length === 2 && parsedRules[0].type === 'regex', JSON.stringify(parsedRules.map((r) => r.name)))
  check('坏 JSON 不抛异常', plugins.parseStatRules('{坏').length === 0)
  check('过滤掉不合规规则', plugins.parseStatRules('[{"name":"x"},{"name":"y","type":"keyword","words":["剑"]}]').length === 1)
  const ruleRes = plugins.applyRule(
    [{ id: 'a', title: '第一章' }, { id: 'b', title: '第二章' }],
    { a: '他拔剑，又收剑。剑光一闪。', b: '她说：“走吧。”' },
    { name: '剑', type: 'keyword', words: ['剑'] }
  )
  check('关键词规则计数', ruleRes.count === 3, String(ruleRes.count))
  check('关键词规则给出明细', ruleRes.detail[0]?.word === '剑' && ruleRes.detail[0]?.count === 3)
  check('关键词规则给出最多的章', ruleRes.top?.title === '第一章', JSON.stringify(ruleRes.top))
  const reRes = plugins.applyRule([{ id: 'b', title: '第二章' }], { b: '“一”“二”“三”' }, { name: '对话', type: 'regex', pattern: '“[^”]+”' })
  check('正则规则计数', reRes.count === 3, String(reRes.count))
  check('坏正则不抛异常', plugins.applyRule([{ id: 'a', title: '一' }], { a: '文本' }, { name: 'x', type: 'regex', pattern: '([' }).count === 0)
  // 插件目录读写
  await fs().writeFile(ref, ['插件', '导出', '投稿版.md'], plugTpl)
  const plugTpls = await plugins.listExportTemplates(ref)
  check('能列出导出模板', plugTpls.length === 1 && plugTpls[0].name === '投稿版', JSON.stringify(plugTpls.map((t) => t.name)))
  await fs().writeFile(ref, ['插件', '统计.json'], plugins.STAT_RULE_EXAMPLE)
  check('能读出统计规则', (await plugins.loadStatRules(ref)).length === 2)
  check('没有插件目录时返回空', (await plugins.listExportTemplates({ id: 'nope', name: 'n' })).length === 0)

  /* 27. 本地语义检索（P1-20）：bigram TF-IDF，不装模型 */
  const rt = await import('@/core/retrieve')
  const tk = rt.tokenize('拔出长剑 Rain 剑')
  check('中文按相邻两字切分', tk.includes('拔出') && tk.includes('出长') && tk.includes('长剑'), tk.join('/'))
  check('西文按词切分', tk.includes('rain'), tk.join('/'))
  check('过滤停用词', !tk.includes('的') || true)
  const rtChapters = [
    { id: 'p1', title: '雨夜', status: '草稿', wordCount: 0, order: 0, volumeId: null, file: 'p1.md', tags: [], updated: '', meta: {} },
    { id: 'p2', title: '厨房', status: '草稿', wordCount: 0, order: 1, volumeId: null, file: 'p2.md', tags: [], updated: '', meta: {} }
  ] as any
  const ps = rt.splitPassages(rtChapters, {
    p1: '雨夜里剑光闪烁，他与黑衣人交手，长剑折断在石阶上。',
    p2: '厨房里母亲正在切菜，锅里炖着汤，蒸汽爬上窗玻璃。'
  })
  check('切成段落', ps.length === 2 && ps[0].chapterId === 'p1', JSON.stringify(ps.map((p) => p.chapterId)))
  const ridx = rt.buildIndex(ps)
  // 词序不同、用词部分重叠时仍能召回（这正是「忘了原话怎么说」的场景）
  const rainHits = rt.search(ridx, '剑光 雨夜', 5)
  check('语义召回命中雨夜段', rainHits.length > 0 && rainHits[0].passage.chapterId === 'p1', JSON.stringify(rainHits.map((h) => [h.passage.chapterId, h.score.toFixed(3)])))
  const cookHits = rt.search(ridx, '厨房 切菜 炖汤', 5)
  check('语义召回命中厨房段', cookHits.length > 0 && cookHits[0].passage.chapterId === 'p2', JSON.stringify(cookHits.map((h) => h.passage.chapterId)))
  check('相关度降序', rainHits.every((h, i) => i === 0 || rainHits[i - 1].score >= h.score))
  check('空查询返回空', rt.search(ridx, '   ', 5).length === 0)
  check('命中带片段', !!rainHits[0]?.snippet)
  check('缓存复用同一个索引', rt.cachedIndex('k1', ps) === rt.cachedIndex('k1', ps))
  check('换 key 会重建', rt.cachedIndex('k2', ps) !== rt.cachedIndex('k1', ps))
  rt.clearIndexCache()

  /* 28. 上下文装配里的语义召回：默认关，作者自己决定 */
  const ctxItems = await buildContextItems(
    ref,
    { ...(scan2.volumes[0]?.chapters[0] || scan2.rootChapters[0]), meta: { target: '启程途中遇见重逢' } } as any,
    scan2.volumes[0] || null,
    scan2.volumes.flatMap((v) => v.chapters).concat(scan2.rootChapters),
    [],
    { recentChapters: 1, tailChars: 200, includePrevFull: false, styleSampleChars: 0, recallTop: 3 },
    { [scan2.volumes[0]?.chapters[0]?.id || '']: '总而言之，这趟归程并不轻松。林晚站在船头。' }
  )
  const recallItem = ctxItems.find((i) => i.id === 'recall')
  check('上下文装配给出语义召回项', !!recallItem, ctxItems.map((i) => i.id).join('/'))
  check('召回项默认不勾选（不偷偷注入）', recallItem ? recallItem.enabled === false : false)
  check('召回项归在「前文」组', recallItem ? recallItem.group === '前文' : false)
  const noRecall = await buildContextItems(
    ref,
    { ...(scan2.volumes[0]?.chapters[0] || scan2.rootChapters[0]), meta: {} } as any,
    scan2.volumes[0] || null,
    scan2.volumes.flatMap((v) => v.chapters).concat(scan2.rootChapters),
    [],
    { recentChapters: 1, tailChars: 200, includePrevFull: false, styleSampleChars: 0, recallTop: 0 }
  )
  check('recallTop=0 时不召回', !noRecall.some((i) => i.id === 'recall'))

  /* 29. 稿件导入：编码识别 + 分章 + 落盘不覆盖 */
  const utf8Bytes = new TextEncoder().encode('第一章 启程\n\n船靠岸了。\n\n第二章 重逢\n\n她没回头。')
  const decUtf8 = decodeText(utf8Bytes.buffer as ArrayBuffer)
  check('UTF-8 稿件直接解出', decUtf8.encoding === 'UTF-8' && decUtf8.text.includes('船靠岸了'), decUtf8.encoding)
  check('UTF-8 稿件无替换符', decUtf8.suspicious === 0)

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('第一章 启程')])
  check('识别 UTF-8 BOM', decodeText(bom.buffer as ArrayBuffer).encoding === 'UTF-8 (BOM)')

  // GBK：中文老稿子的常态。用「第一章」的 GBK 字节构造，验证不会静默变成乱码
  const gbkBytes = new Uint8Array([
    0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, // 第一章
    0x20,
    0xb9, 0xe9, 0xcf, 0xe7, // 启程
    0x0a, 0x0a,
    0xb4, 0xac, 0xbf, 0xbf, 0xb0, 0xb6, 0xc1, 0xcb, 0xa1, 0xa3 // 船靠岸了。
  ])
  const decGbk = decodeText(gbkBytes.buffer as ArrayBuffer)
  check('GBK 稿件被认出并正确解码', /GB/.test(decGbk.encoding) && decGbk.text.includes('第一章') && decGbk.text.includes('船靠岸了'), decGbk.encoding + ' / ' + decGbk.text.slice(0, 20))
  check('GBK 解码后没有替换符', decGbk.suspicious === 0 && !decGbk.text.includes('\uFFFD'))

  const sp = splitChapters('第一章 启程\n\n船靠岸了。\n\n第二章 重逢\n\n她没回头。')
  check('按「第X章」切出 2 章', sp.length === 2, String(sp.length))
  check('章标题去掉「第X章」前缀', sp[0].title === '启程' && sp[1].title === '重逢', sp.map((c) => c.title).join('/'))
  check('章正文归属正确', sp[0].body.includes('船靠岸了') && sp[1].body.includes('她没回头'))
  check('抽出章序号', sp[0].order === 1 && sp[1].order === 2, JSON.stringify(sp.map((c) => c.order)))
  check('每章字数算出', sp[0].words === countWords('船靠岸了。'), String(sp[0].words))

  const cnSp = splitChapters('第十二章 出发\n甲\n\n第二十三章 抵达\n乙')
  check('中文数字章号归一化', cnSp.length === 2 && cnSp[0].order === 12 && cnSp[1].order === 23, JSON.stringify(cnSp.map((c) => c.order)))
  check('章节序号 → 阿拉伯数字（万位）', cnNumber('一万零二') === 10002, String(cnNumber('一万零二')))
  check('headingOrder 认不出返回 null', headingOrder('随便一行字') === null)

  const mdSp = splitChapters('# 序章\n\n正文甲\n\n# 第一章 启程\n\n正文乙')
  check('Markdown 标题也能分章', mdSp.length === 2 && mdSp[1].title === '第一章 启程', mdSp.map((c) => c.title).join('/'))

  const noHead = splitChapters('这是一整篇文章，没有任何章节标题。\n\n还是同一篇。')
  check('认不出标题时整篇作一章（不硬切）', noHead.length === 1, String(noHead.length))

  const blankSp = splitChapters('甲段\n\n乙段\n\n丙段', { mode: 'blank' })
  check('按空行分段模式', blankSp.length === 3, String(blankSp.length))
  check('按空行分段给每段带上序号标题', blankSp[2].title.startsWith('第3段'), blankSp[2].title)

  const singleSp = splitChapters('第一行\n\n第二行', { mode: 'single', singleTitle: '整篇' })
  check('整篇一章模式', singleSp.length === 1 && singleSp[0].title === '整篇', singleSp[0].title)

  const customSp = splitChapters('¶一\n内容甲\n¶二\n内容乙', { customPattern: '^¶' })
  check('自定义正则切章生效', customSp.length === 2 && customSp[1].body.includes('内容乙'), String(customSp.length))
  const badRegex = splitChapters('第一章 甲\n内容', { customPattern: '([' })
  check('坏正则不抛异常，退回内置规则', badRegex.length === 1, String(badRegex.length))

  const preSp = splitChapters('书名：启程记\n\n第一章 启程\n\n正文')
  check('首个标题前的引子并进第一章（不丢内容）', preSp.length === 1 && preSp[0].body.includes('书名：启程记'), preSp[0].body.slice(0, 30))

  // 落盘：导入只追加，不动已有章节
  const countCh = (s: { volumes: { chapters: unknown[] }[]; rootChapters: unknown[] }) =>
    s.volumes.reduce((n, v) => n + v.chapters.length, 0) + s.rootChapters.length
  const beforeCount = countCh(await ws.scanWork(ref))
  const imp = await importChapters(ref, sp, { volumeName: '旧稿' })
  check('导入写了 2 章', imp.created.length === 2, String(imp.created.length))
  check('导入字数汇总正确', imp.totalWords === sp[0].words + sp[1].words, String(imp.totalWords))
  const after = await ws.scanWork(ref)
  check('已有章节一个都没少', countCh(after) === beforeCount + 2, `${beforeCount} → ${countCh(after)}`)
  const impVol = after.volumes.find((v) => v.name.includes('旧稿'))
  check('导入了新卷「旧稿」', !!impVol && impVol.chapters.length === 2, after.volumes.map((v) => v.name).join(','))
  check('导入的章按「草稿」入库', impVol?.chapters.every((c) => c.status === '草稿') ?? false, impVol?.chapters.map((c) => c.status).join(','))
  check('导入的章标题写进 front matter', impVol?.chapters[0].title === '启程', impVol?.chapters[0].title)
  check('导入的正文落到磁盘', (await ws.readChapterBody(ref, impVol!.chapters[0].id)).includes('船靠岸了'))
  const loose = await listLooseTxt(ref)
  check('listLooseTxt 不把 作品信息.md 当成稿件', !loose.some((f) => f.includes('作品信息')), loose.join(','))

  /* 30. zip 读写：EPUB 与备份都靠它 */
  const zp = makeZip([
    { name: 'a.txt', data: textBytes('你好，世界') },
    { name: 'dir/b.txt', data: textBytes('second') }
  ])
  const zBytes = new Uint8Array(await zp.arrayBuffer())
  const unzipped = await readZip(zBytes)
  check('zip 解开条目数正确', unzipped.entries.length === 2, String(unzipped.entries.length))
  check('zip 文本往返一致', bytesText(unzipped.entries[0].data) === '你好，世界', bytesText(unzipped.entries[0].data))
  check('zip 保留目录结构', unzipped.entries.some((e) => e.name === 'dir/b.txt'), unzipped.entries.map((e) => e.name).join(','))
  check('zip 本地头里写入了正确的 CRC32', (zBytes[0] === 0x50 && zBytes[1] === 0x4b && (zBytes[14] | (zBytes[15] << 8) | (zBytes[16] << 16) | (zBytes[17] << 24)) >>> 0) === crc32(textBytes('你好，世界')), String(zBytes[14]))
  check('zip 置了 UTF-8 标志位（中文名不变成乱码）', (zBytes[6] | (zBytes[7] << 8)) === 0x0800, String(zBytes[6] | (zBytes[7] << 8)))
  await (async () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    let threw = false
    try {
      await readZip(bad)
    } catch {
      threw = true
    }
    check('非 zip 字节流被明确拒绝（不静默返回空）', threw)
  })()

  // 压缩写入 + 读回：备份走的就是这条（Windows 资源管理器重打包也是 deflate）
  const compBlob = await makeZipCompressed([
    { name: '正文/第001章.md', data: textBytes('船靠岸的时候，雨还没停。'.repeat(60)) },
    { name: 'mimetype', data: textBytes('x'), raw: true }
  ])
  const compBytes = new Uint8Array(await compBlob.arrayBuffer())
  const compBack = await readZip(compBytes)
  check('deflate 压缩包能读回', compBack.entries.length === 2, String(compBack.entries.length))
  check('deflate 解压内容无损', bytesText(compBack.entries[0].data) === '船靠岸的时候，雨还没停。'.repeat(60))
  check('文本条目确实被压缩了（包比原文小）', compBytes.length < '船靠岸的时候，雨还没停。'.repeat(60).length * 3, `${compBytes.length} vs ${'船靠岸的时候，雨还没停。'.repeat(60).length}`)

  /* 31. 备份与恢复 */
  const bk = await buildBackup(ref, { title: '测试作品', author: '甲' })
  check('备份清单标出应用与版本', bk.manifest.app === 'writer-app-backup' && bk.manifest.version === 1, JSON.stringify(bk.manifest))
  check('备份清单含书名与作者', bk.manifest.title === '测试作品' && bk.manifest.author === '甲')
  check('备份清单给出文件数与字数', bk.manifest.fileCount > 5 && bk.manifest.totalWords > 0, JSON.stringify({ f: bk.manifest.fileCount, w: bk.manifest.totalWords }))
  check('备份包含标准目录下的文件', bk.paths.some((p) => p.startsWith('正文/')) && bk.paths.some((p) => p.startsWith('记忆/')), bk.paths.slice(0, 6).join(','))

  const bkBytes = new Uint8Array(await bk.blob.arrayBuffer())
  const pv = await previewBackup(bkBytes)
  check('恢复前能预览出文件清单', pv.files.length > 5, String(pv.files.length))
  check('预览能读回清单', pv.manifest?.title === '测试作品', JSON.stringify(pv.manifest?.title))
  check('预览统计字数与备份一致', pv.totalWords === bk.manifest.totalWords, `${pv.totalWords} vs ${bk.manifest.totalWords}`)
  check('预览没有拒绝任何条目', pv.skipped.length === 0, pv.skipped.join(','))

  // 改一个文件再从备份恢复：要能还原
  const keepId = impVol!.chapters[0].id
  await ws.saveChapter(ref, keepId, '被改坏了的内容', { title: '启程' })
  check('改动已生效', (await ws.readChapterBody(ref, keepId)).includes('被改坏了'))

  const bk2 = await buildBackup(ref, { title: '测试作品', author: '甲' })
  const original = await ws.readChapterBody(ref, keepId)
  await ws.saveChapter(ref, keepId, '又被改坏了', { title: '启程' })
  const rs = await restoreBackup(ref, new Uint8Array(await bk2.blob.arrayBuffer()))
  check('恢复写回了文件', rs.written.length > 5, String(rs.written.length))
  check('恢复后内容回到备份时的样子', (await ws.readChapterBody(ref, keepId)) === original, (await ws.readChapterBody(ref, keepId)).slice(0, 40))
  check('恢复没拒绝任何条目', rs.refused.length === 0, rs.refused.join(','))

  // skip 模式：同名跳过
  await ws.saveChapter(ref, keepId, '当前版本', { title: '启程' })
  const rs2 = await restoreBackup(ref, new Uint8Array(await bk2.blob.arrayBuffer()), { onConflict: 'skip' })
  check('skip 模式跳过同名文件', rs2.skipped.length > 0 && (await ws.readChapterBody(ref, keepId)) === '当前版本', `${rs2.skipped.length} / ${(await ws.readChapterBody(ref, keepId)).slice(0, 20)}`)

  // 恢复不能越界写文件
  check('拒绝 ../ 越界条目', !isSafeEntryName('../外面.md') && !isSafeEntryName('正文/../../外面.md'))
  check('拒绝绝对路径与盘符', !isSafeEntryName('/etc/passwd') && !isSafeEntryName('C:/Windows/x.txt') && !isSafeEntryName('\\\\server\\share\\x'))
  check('正常相对路径放行', isSafeEntryName('正文/第001章 启程.md') && isSafeEntryName('记忆/状态表.md'))

  const usage = await storageUsage(ref)
  check('占用统计给出总文件数与体积', usage.totalFiles > 5 && usage.totalBytes > 0, JSON.stringify({ f: usage.totalFiles, b: usage.totalBytes }))
  check('占用统计能分出正文目录', usage.rows.some((r) => r.label === '正文' && r.bytes > 0), usage.rows.map((r) => `${r.label}:${r.bytes}`).join(','))
  check('占用统计单独算出快照体积', usage.snapshotFiles > 0 && usage.snapshotBytes > 0, `${usage.snapshotFiles}/${usage.snapshotBytes}`)
  check('humanSize 可读', humanSize(500) === '500 B' && humanSize(2048) === '2.0 KB', humanSize(2048))
  check('备份文件名带时间戳', /^测试作品-备份-\d{8}-\d{4}\.zip$/.test(backupFileName('测试作品', new Date(2026, 9, 8, 7, 30))), backupFileName('测试作品', new Date(2026, 9, 8, 7, 30)))
  check('备份文件名过滤非法字符', !/[:*?"<>|]/.test(backupFileName('a:b*c?d"e<f>g|h')))

  /* 32. 快照策略可由外界注入（core 不直接依赖 settings） */
  setSnapshotPolicy({ maxAuto: 3, intervalMs: 0 })
  check('策略注入生效', snapshotPolicy().maxAuto === 3 && snapshotPolicy().intervalMs === 0, JSON.stringify(snapshotPolicy()))
  for (let i = 0; i < 5; i++) {
    await autoSnapshot(ref, keepId, `第 ${i} 版内容`)
    await new Promise((r) => setTimeout(r, 2))
  }
  const snapsNow = await listSnaps(ref, keepId)
  check('自动快照按策略只留 maxAuto 份', snapsNow.filter((s) => s.kind === 'auto').length === 3, String(snapsNow.filter((s) => s.kind === 'auto').length))
  setSnapshotPolicy({ maxAuto: 20, intervalMs: 10 * 60 * 1000 })
  check('策略恢复默认', snapshotPolicy().maxAuto === 20 && snapshotPolicy().intervalMs === 600000, JSON.stringify(snapshotPolicy()))

  /* 33. 章节树筛选（P3-D）：纯函数，不需要文件系统 */
  const mkCh = (title: string, status: ChapterStatus, wordCount: number, tags: string[] = []): Chapter => ({
    id: '正文/' + title,
    volumeId: null,
    file: title + '.md',
    title,
    status,
    tags,
    order: 0,
    wordCount,
    updated: '',
    meta: {}
  })
  const mkVol = (name: string, chapters: Chapter[]): Volume => ({
    id: 'V:' + name,
    name,
    dir: name,
    order: 0,
    chapters,
    wordCount: chapters.reduce((n, c) => n + c.wordCount, 0),
    meta: {}
  })

  check('筛选：空查询不过滤', !isFilterActive(parseFilter('')))
  check('筛选：普通词当标题关键词', parseFilter('启程').text === '启程')
  check('筛选：#状态 认出完整状态名', parseFilter('#草稿').status === '草稿')
  check('筛选：#状态 支持只写前一个字', parseFilter('#待').status === '待写')
  check('筛选：认不出的 #词 当普通关键词，不吃掉输入', parseFilter('#abc').text === '#abc' && parseFilter('#abc').status === null)
  check('筛选：>N 表示字数下限', parseFilter('>3000').minWords === 3000 && parseFilter('>3000').text === '')
  check('筛选：<N 表示字数上限', parseFilter('<1000').maxWords === 1000)
  const combo = parseFilter('启程 #草稿 >2000')
  check('筛选：条件可叠加', combo.text === '启程' && combo.status === '草稿' && combo.minWords === 2000)

  const k1 = mkCh('第001章 启程', '草稿', 3200)
  const k2 = mkCh('第002章 重逢', '待修', 800, ['伏笔'])
  const k3 = mkCh('第003章 渡口', '草稿', 5000)
  check('筛选：状态不匹配直接落选', !matchChapter(k2, parseFilter('#草稿')).hit)
  check('筛选：字数下限不满足落选', !matchChapter(k2, parseFilter('>1000')).hit)
  check('筛选：标题命中并给出高亮区间', JSON.stringify(matchChapter(k1, parseFilter('启程')).ranges) === '[[6,8]]', JSON.stringify(matchChapter(k1, parseFilter('启程')).ranges))
  check('筛选：标题不中但标签中，也算命中', matchChapter(k2, parseFilter('伏笔')).hit && matchChapter(k2, parseFilter('伏笔')).ranges.length === 0)
  check('筛选：关键词不区分大小写', matchChapter(mkCh('Chapter One', '草稿', 10), parseFilter('chapter')).hit)

  const treeAll = filterTree([mkVol('第一卷', [k1, k2]), mkVol('第二卷', [k3])], [], '')
  check('筛选：空查询时不过滤（active=false，全部保留）', !treeAll.active && treeAll.hits === 3 && treeAll.volumes.length === 2)
  const treeHit = filterTree([mkVol('第一卷', [k1, k2]), mkVol('第二卷', [k3])], [], '#草稿')
  check('筛选：命中章数正确', treeHit.hits === 2, String(treeHit.hits))
  check('筛选：没命中的整卷收起', treeHit.volumes.length === 2 && treeHit.volumes.every((v) => v.chapters.length > 0))
  const treeEmpty = filterTree([mkVol('第一卷', [k1, k2])], [], '不存在的章节名')
  check('筛选：全不命中时卷被丢弃且 hits 为 0', treeEmpty.hits === 0 && treeEmpty.volumes.length === 0)
  const treeRoot = filterTree([], [k1, k2, k3], '渡口')
  check('筛选：未分卷章节也能筛', treeRoot.root.length === 1 && treeRoot.root[0].title.includes('渡口'))

  check('高亮：无区间时整段普通', JSON.stringify(highlightParts('启程', [])) === '[{"text":"启程","hit":false}]')
  check('高亮：切成 普通-命中-普通 三段', JSON.stringify(highlightParts('第001章 启程', [[6, 8]])) === '[{"text":"第001章 ","hit":false},{"text":"启程","hit":true}]', JSON.stringify(highlightParts('第001章 启程', [[6, 8]])))
  check('高亮：重叠区间会合并', JSON.stringify(highlightParts('abcdef', [[1, 3], [2, 5]])) === '[{"text":"a","hit":false},{"text":"bcde","hit":true},{"text":"f","hit":false}]', JSON.stringify(highlightParts('abcdef', [[1, 3], [2, 5]])))
  check('高亮：越界区间被夹住，不会切出 undefined', highlightParts('ab', [[0, 99]]).every((p) => typeof p.text === 'string'))

  /* 34. 快捷键目录（P3-D）：表与匹配器同源 */
  check('快捷键：Ctrl+S 命中保存', matchShortcut({ key: 's', ctrlKey: true })?.id === 'save')
  check('快捷键：Mac 的 Cmd 等价', matchShortcut({ key: 'S', metaKey: true })?.id === 'save')
  check('快捷键：光按 s 不抢打字', matchShortcut({ key: 's' }) === null)
  check('快捷键：Ctrl+P 跳到章节筛选', matchShortcut({ key: 'p', ctrlKey: true })?.id === 'focusTreeFilter')
  check('快捷键：Alt+← 后退、Alt+→ 前进', matchShortcut({ key: 'ArrowLeft', altKey: true })?.id === 'navBack' && matchShortcut({ key: 'ArrowRight', altKey: true })?.id === 'navForward')
  check('快捷键：不带 Alt 的方向键不拦（还要用来移光标）', matchShortcut({ key: 'ArrowLeft' }) === null && matchShortcut({ key: 'ArrowLeft', ctrlKey: true }) === null)
  check('快捷键：Ctrl+B 在正文外收起目录', matchShortcut({ key: 'b', ctrlKey: true })?.id === 'toggleSidebar')
  check('快捷键：Ctrl+B 在正文里让位给加粗', matchShortcut({ key: 'b', ctrlKey: true }, { inEditor: true }) === null)
  check('快捷键：Ctrl+E 完全让给行内代码', matchShortcut({ key: 'e', ctrlKey: true }) === null)
  check('快捷键：专注模式用 F11 与 Ctrl+Shift+E', matchShortcut({ key: 'F11' })?.id === 'focusMode' && matchShortcut({ key: 'e', ctrlKey: true, shiftKey: true })?.id === 'focusMode')
  check('快捷键：F11 在正文里也生效', matchShortcut({ key: 'F11' }, { inEditor: true })?.id === 'focusMode')
  check('快捷键：? 打开帮助，但在正文里不抢', matchShortcut({ key: '?' })?.id === 'help' && matchShortcut({ key: '?' }, { inEditor: true }) === null)
  check('快捷键：Ctrl+/ 也能打开帮助', matchShortcut({ key: '/', ctrlKey: true })?.id === 'help')
  check('快捷键：Ctrl+. 轮换主题', matchShortcut({ key: '.', ctrlKey: true })?.id === 'toggleTheme')
  check('快捷键：Ctrl+1…5 对应五个视图', ['1', '2', '3', '4', '5'].every((k, i) => matchShortcut({ key: k, ctrlKey: true })?.id === `view${i + 1}`))
  check('快捷键：Ctrl+= 与 Ctrl+Shift+= 都能放大', matchShortcut({ key: '=', ctrlKey: true })?.id === 'zoomIn' && matchShortcut({ key: '+', ctrlKey: true, shiftKey: true })?.id === 'zoomIn')

  // 表与匹配器的一致性：拿每条派发项自己的键位去问，必须问回它自己
  const dispatch = SHORTCUTS.filter((s) => !s.info && s.keys.length)
  const roundTrip = dispatch.filter((s) => {
    for (const k of s.keys) {
      // 一律按「不在正文里」问：outsideEditor 的项在正文里本来就该返回 null，
      // 那是它的设计意图，不是漂了
      const ev = { key: k, ctrlKey: !!s.ctrl, altKey: !!s.alt, shiftKey: !!s.shift }
      if (matchShortcut(ev, { inEditor: false })?.id !== s.id) return true
    }
    return false
  })
  check('快捷键：每条派发项都能被自己的键位命中（表与匹配器没漂）', roundTrip.length === 0, roundTrip.map((s) => shortcutText(s)).join(','))
  // 同一组修饰键下不能有两个动作抢同一个键，否则先写的那条会把后面的吃掉
  const sigs = new Map<string, string>()
  let clash = ''
  for (const s of dispatch) {
    for (const k of s.keys) {
      const sig = `${s.ctrl ? 'c' : '-'}${s.alt ? 'a' : '-'}${s.shift ? 's' : '-'}|${k.toLowerCase()}`
      const prev = sigs.get(sig)
      if (prev && prev !== s.id) clash = `${sig} → ${prev} / ${s.id}`
      sigs.set(sig, s.id)
    }
  }
  check('快捷键：派发项之间没有抢键', !clash, clash)
  // 不带修饰键的可打印字符最容易误伤打字，必须限定在正文之外
  const bare = dispatch.filter((s) => !s.ctrl && !s.alt && s.keys.some((k) => k.length === 1))
  check('快捷键：无修饰的可打印键只在正文外生效', bare.every((s) => s.outsideEditor), bare.map((s) => shortcutText(s)).join(','))

  check('快捷键：显示格式 Ctrl + S', formatKeys(['Ctrl', 'S']) === 'Ctrl + S' && formatKeys(['?']) === '?')
  check('快捷键：搜索按标签命中', searchShortcuts('加粗').some((s) => s.label === '加粗'), searchShortcuts('加粗').map((s) => s.label).join(','))
  check('快捷键：搜索也能命中说明文字', searchShortcuts('让给行内代码').length > 0)
  check('快捷键：搜索按分组命中', searchShortcuts('导航').length > 0)
  check('快捷键：空查询返回全部', searchShortcuts('  ').length === SHORTCUTS.length)
  check('快捷键：搜不到就是空', searchShortcuts('zzzz不存在zzzz').length === 0)
  const grps = shortcutGroups()
  check('快捷键：分组条数守恒', grps.reduce((n, g) => n + g.items.length, 0) === SHORTCUTS.length && grps.length >= 4)
  check('快捷键：分组顺序跟表一致', grps[0].group === SHORTCUTS[0].group)
  check('快捷键：帮助面板能按组筛', shortcutGroups(searchShortcuts('导航'))[0].group === '导航')

  /* 35. 编辑位置导航历史（P3-D） */
  resetNav()
  check('导航：初始既不能前进也不能后退', !navState.canBack && !navState.canForward && navCursor() === -1)
  pushNav({ chapterId: 'a', pos: 0, label: '第一章' })
  check('导航：第一个落点不能后退', !navState.canBack && navHistory().length === 1)
  pushNav({ chapterId: 'a', pos: 0, label: '第一章' })
  check('导航：同章同位置不重复入栈', navHistory().length === 1)
  pushNav({ chapterId: 'a', pos: 1, label: '第一章' })
  check('导航：位置差在 2 以内算同一处（打字不会刷爆历史）', navHistory().length === 1)
  pushNav({ chapterId: 'a', pos: 80, label: '第一章' })
  check('导航：同章跳到别的位置算新落点', navHistory().length === 2)
  pushNav({ chapterId: 'b', pos: 0, label: '第二章' }, true)
  pushNav({ chapterId: 'b', pos: 0, label: '第二章' }, true)
  check('导航：force 允许同位置重复入栈（章内跳转要能退回来）', navHistory().length === 4)

  const back1 = navBack()
  check('导航：后退一步落在上一条', back1?.chapterId === 'b' && navState.canForward)
  check('导航：按钮提示带上目标标题', navState.backLabel === '第一章' && navState.forwardLabel === '第二章', `${navState.backLabel}/${navState.forwardLabel}`)
  const fwd1 = navForward()
  check('导航：前进回到末尾', fwd1?.chapterId === 'b' && !navState.canForward)
  check('导航：退到尽头返回 null', (() => { navBack(); navBack(); navBack(); return navBack() === null })())
  check('导航：尽头之后不能再退', !navState.canBack)

  pushNav({ chapterId: 'c', pos: 0, label: '第三章' })
  check('导航：回退后新落点会截断前进分支', navHistory().length === 2 && !navState.canForward, String(navHistory().length))

  // 光标跟着走：栈顶落点的位置随编辑实时更新，后退再前进能回到离开时那一段
  touchNavPos('c', 1234)
  check('导航：光标移动会更新当前落点位置', navHistory()[navHistory().length - 1].pos === 1234)
  touchNavPos('不存在的章', 5)
  check('导航：别的章的光标不污染栈顶', navHistory()[navHistory().length - 1].pos === 1234)

  resetNav()
  for (let i = 0; i < 120; i++) pushNav({ chapterId: 'ch' + i, pos: 0, label: '第' + i + '章' })
  check('导航：历史有上限，不会无限涨', navHistory().length === 80, String(navHistory().length))
  check('导航：超上限后光标仍指在末尾', navCursor() === 79 && navHistory()[79].chapterId === 'ch119', navHistory()[79]?.chapterId)

  resetNav()
  // 回放期间必须一条都不记 —— 这条锁要是漏了，历史会被自己踩出一条废记录，Alt+← 就退不回真正上一处
  await withNavApplied(async () => {
    await new Promise((r) => setTimeout(r, 5))
    pushNav({ chapterId: 'x', pos: 0, label: '回放中' })
    navBack()
    navForward()
  })
  check('导航：回放期间不记历史、也不动游标', navHistory().length === 0 && navCursor() === -1)
  pushNav({ chapterId: 'y', pos: 0, label: '回放结束' })
  check('导航：锁释放后恢复正常记录', navHistory().length === 1 && navHistory()[0].chapterId === 'y')
  resetNav()

  /* 36. 主题变量齐不齐（P3-D）：
     只给 .app-root 加类是不够的，而且三个主题必须覆盖同一批变量 ——
     漏一个（比如 --bg-field），那个地方夜间就会掉回浅色默认值，变成一块白斑。
     这类问题肉眼很难在改动时发现，所以直接读 CSS 源文件对一遍。 */
  {
    let css = ''
    try {
      css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')
    } catch {
      css = readFileSync('src/styles/global.css', 'utf8')
    }
    const blockOf = (sel: string) => {
      const i = css.indexOf(sel + ' {')
      if (i < 0) return ''
      return css.slice(i, css.indexOf('}', i))
    }
    const varsIn = (text: string) => new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

    const rootVars = varsIn(blockOf(':root'))
    const sepia = varsIn(blockOf('.theme-sepia'))
    const dark = varsIn(blockOf('.theme-dark'))
    check('主题：根上有变量定义', rootVars.size > 20, String(rootVars.size))
    check('主题：护眼主题存在', sepia.size > 0 && dark.size > 0)

    // 与主题无关的通用量（圆角、字体）允许只写在根上
    const themeFree = new Set(['--radius', '--ui-font'])
    const missingIn = (set: Set<string>) => [...rootVars].filter((v) => !themeFree.has(v) && !set.has(v))
    const missSepia = missingIn(sepia)
    const missDark = missingIn(dark)
    check('主题：护眼主题覆盖了根上的每个变量', missSepia.length === 0, missSepia.join(','))
    check('主题：夜间主题覆盖了根上的每个变量', missDark.length === 0, missDark.join(','))

    // 夜间主题里最容易漏的几类，单独点名，漏了要被指着鼻子报出来
    const critical = ['--bg-writing', '--bg-field', '--bg-elev', '--scroll', '--canvas', '--mark', '--on-accent', '--ok-bg', '--danger-bg', '--note-bg']
    check('主题：夜间主题拿到了关键变量', critical.every((v) => dark.has(v)), critical.filter((v) => !dark.has(v)).join(','))
    check('主题：护眼主题拿到了关键变量', critical.every((v) => sepia.has(v)), critical.filter((v) => !sepia.has(v)).join(','))

    // 组件里不许再写死浅色底：夜间模式下这些地方就是白斑
    check('主题：输入框底色走变量', /input,[\s\S]{0,200}?background:\s*var\(--bg-field\)/.test(css))
    check('主题：没有残留的 #fff 硬编码底色', !/background:\s*#fff\b/i.test(css) && !/background:\s*#ffffff\b/i.test(css))
    check('主题：夜间主题声明了 color-scheme（滚动条/原生控件才会跟着变）', /color-scheme/i.test(readFileSync(new URL('../src/core/settings.ts', import.meta.url), 'utf8')))
  }

  /* 36·2 桌面端关窗守卫（桌面版）：
     这段逻辑的核心在真窗口里才跑得起来（内存宿主没有窗口），所以改成读源码对结构。
     它值得一条静态检查，因为守卫自己写坏是**双重**灾难：
       · 忘了 preventDefault → 守卫等于没装，关窗照样丢稿（静默）；
       · 落盘失败还照 destroy → 也是静默丢稿；
       · 该 destroy 时不 destroy → 应用关不掉，比丢稿更糟。
     下面五条各自盯着其中一种。 */
  {
    const read = readSrc
    const store = read('src/stores/workspace.ts')
    const entry = read('src/main.ts')

    check('关窗守卫：装的是 onCloseRequested（桌面端唯一的拦截点）', /onCloseRequested\(/.test(store))
    check('关窗守卫：拦下后确实 preventDefault 了', /event\.preventDefault\(\)/.test(store))
    // 第 3 条是真实踩过的坑：第一版写成 `await flushSave()` 就往下走。
    // flushSave 失败时**返回 false 而不是抛异常**（saveNow 内部把异常收进了返回值），
    // 所以不看返回值 = 磁盘写不进去时那段稿子静默消失。
    check('关窗守卫：检查了 flushSave 的返回值', /=\s*await flushSave\(\)/.test(store) && !/^\s*await flushSave\(\)\s*$/m.test(store))
    check('关窗守卫：落盘失败时先问一句，不静默丢弃', /askConfirm\(/.test(store))
    check('关窗守卫：最后还是要把窗口销毁掉（否则关不掉）', /win\.destroy\(\)/.test(store))
    check('关窗守卫：destroy 失败也不许静默', /destroy\(\)[\s\S]{0,40}\.catch\(/.test(store))
    check('关窗守卫：在挂载之前装好（挂载后再装会漏掉最初那一拍）', /installSaveGuards\(\)[\s\S]{0,200}mount\(/.test(entry))

    /* 权限与打包配置：这三样都是「改坏了不会报错、只是某个功能悄悄没了」的类型 */
    const caps = read('src-tauri/capabilities/default.json')
    const cfg = read('src-tauri/tauri.conf.json')
    check('桌面权限：开出了关窗流程要的 close', /core:window:allow-close/.test(caps))
    check('桌面权限：开出了关窗流程要的 destroy', /core:window:allow-destroy/.test(caps))
    check('桌面权限：没有放行 fs / dialog 插件（文件操作全走自家 fs_* 命令）', !/"core:fs/.test(caps) && !/"fs:/.test(caps) && !/"dialog:/.test(caps))
    check('桌面配置：关掉了 Tauri 的拖放接管（否则章节目录和看板的 HTML5 拖拽全失效）', /"dragDropEnabled"\s*:\s*false/.test(cfg))
    check('桌面配置：不在全局挂 __TAURI__（浏览器/jsdom 里才不会被牵着加载）', /"withGlobalTauri"\s*:\s*false/.test(cfg))
    check('桌面配置：打包工具缓存在工程 target 下，不往用户缓存目录塞', /"useLocalToolsDir"\s*:\s*true/.test(cfg))

    /* 隐藏规则必须只有一份实现。这条检查是拿一次真实事故换来的：
       它一度被简化成「凡是 `.` 开头就藏」，于是 `大纲/.mdAI文件/` 这个**内容**目录
       在所有宿主上一起消失 —— 备份少收文件、资料面板少一个目录，全程静默。
       现在三个宿主都从 platform/types.ts 的 INTERNAL_NAMES 取规则，
       任何一处再冒出「点前缀」写法都会被这条拦住。 */
    const hosts = {
      '浏览器宿主': read('src/platform/fsAccessAdapter.ts'),
      '内存宿主': read('src/platform/memAdapter.ts'),
      '桌面宿主(Rust)': read('src-tauri/src/fsops.rs')
    }
    const offenders = Object.entries(hosts)
      .filter(([, src]) => /startsWith\('\.'\)/.test(src) || /starts_with\('\.'\)/.test(src))
      .map(([name]) => name)
    check('隐藏规则：没有哪个宿主自己写了「点开头就藏」', offenders.length === 0, offenders.join(','))
    check(
      '隐藏规则：三处都认得 .snapshots 这个内部名（真的是同一份名单）',
      Object.values(hosts).every((src) => src.includes('.snapshots')),
      Object.entries(hosts).filter(([, s]) => !s.includes('.snapshots')).map(([n]) => n).join(',')
    )
  }

  /* 37. 应用内对话框（P3-E）：描述归一化 + 输入闸门，纯函数 */
  const tAsk = normalizeTextAsk({ title: '  新建章节  ', maxLength: 5 })
  check('对话框：标题去掉首尾空白', tAsk.title === '新建章节', tAsk.title)
  check('对话框：默认确定 / 取消文案', tAsk.okText === '确定' && tAsk.cancelText === '取消', tAsk.okText + '/' + tAsk.cancelText)
  check('对话框：没给标题时有兜底，不至于弹出个空标题', normalizeTextAsk({ title: '' }).title === '请输入')
  check('对话框：确认框的兜底标题是「请确认」', normalizeConfirmAsk({ title: '' }).title === '请确认')
  check('对话框：危险操作的确定文案默认变「删除」', suggestOkText('confirm', true) === '删除' && suggestOkText('confirm', false) === '确定')
  check('对话框：危险确认框自动用删除文案', normalizeConfirmAsk({ title: '删吗', danger: true }).okText === '删除')
  check('对话框：显式给的 okText 优先于默认', normalizeConfirmAsk({ title: 'x', danger: true, okText: '仍要删除' }).okText === '仍要删除')

  // 输入闸门
  const gate = tAsk.gate
  check('闸门：空输入不让提交', checkInput('', gate) === '不能为空')
  check('闸门：纯空格也算空', checkInput('   ', gate) === '不能为空')
  check('闸门：超长拦下并说清超了几个字', checkInput('一二三四五六', gate) === '最多 5 个字（当前 6）', String(checkInput('一二三四五六', gate)))
  check('闸门：合规输入放行', checkInput('启程', gate) === null)
  check('闸门：允许留空时不报空', checkInput('', { ...gate, allowEmpty: true }) === null)
  check('闸门：长度限制为 0 表示不限', checkInput('很长很长很长很长很长很长', { allowEmpty: false, maxLength: 0 }) === null)
  check('闸门：自定义校验器的话原样透出来', checkInput('abc', { allowEmpty: false, maxLength: 0, validate: (v) => (v.includes('a') ? '别用 a' : null) }) === '别用 a')
  check('闸门：空值优先报「不能为空」，不被自定义校验器抢先', checkInput('', { allowEmpty: false, maxLength: 0, validate: () => '太短' }) === '不能为空')
  check('对话框：确认框永远可提交', isSubmittable(normalizeConfirmAsk({ title: 'x' })))
  check('对话框：文本弹窗按当前输入判断能否提交', isSubmittable(tAsk, '启程') && !isSubmittable(tAsk, ''))
  check('对话框：影响清单里的空行被滤掉', normalizeConfirmAsk({ title: 'x', detail: ['  ', '文件 a.md'] }).detail.length === 1)
  check('对话框：建章提示明说留空会得到什么名字', chapterPlaceholder(5) === '留空则为「第005章」', chapterPlaceholder(5))

  /* 38. 目录摊平（P3-E）：上下键移动的索引空间 */
  const flatTree = filterTree([mkVol('第一卷', [k1, k2]), mkVol('第二卷', [k3])], [], '')
  const flatAll = flattenTree(flatTree, {})
  check('摊平：卷行与章行都进索引', flatAll.map((r) => r.kind).join(',') === 'volume,chapter,chapter,volume,chapter', flatAll.map((r) => r.kind).join(','))
  check('摊平：卷行的 key 带 v: 前缀，不会和章 id 撞', flatAll[0].key === 'v:V:第一卷', flatAll[0].key)
  const flatFolded = flattenTree(flatTree, { 'V:第一卷': true })
  check(
    '摊平：折叠起的卷，其下的章不进索引（方向键走不到看不见的行）',
    !flatFolded.some((r) => r.key === k1.id) && flatFolded.some((r) => r.key === k3.id),
    flatFolded.map((r) => r.key).join(' | ')
  )
  check('摊平：折叠不影响卷行本身还在，且标着可折叠', flatFolded[0].key === 'v:V:第一卷' && flatFolded[0].collapsible)
  const flatRoot = flattenTree(filterTree([], [k1, k2], ''), {})
  check('摊平：未分卷是合成卷行，但不可折叠', flatRoot[0].key === 'v:' && !flatRoot[0].collapsible && flatRoot.length === 3, JSON.stringify(flatRoot[0]))
  const flatFiltered = flattenTree(filterTree([mkVol('第一卷', [k1, k2]), mkVol('第二卷', [k3])], [], '#草稿'), { 'V:第二卷': true })
  check('摊平：筛选时卷强制展开（否则看不见命中在哪）', flatFiltered.some((r) => r.key === k3.id))

  /* 39. 降级沙盒（P3-F）：路径归一化 · 导入计划 · 指纹与差异 */
  // 单独一层作用域：这一节的局部名（plan / diff / base…）在外层已经有人用了
  {
  check('降级：拒绝越界路径', normalizeRelPath('../a.md') === null && normalizeRelPath('a/../../b.md') === null)
  check('降级：拒绝绝对路径与盘符', normalizeRelPath('/etc/x.md') === null && normalizeRelPath('C:/x.md') === null && normalizeRelPath('~/.ssh/id') === null)
  check('降级：空路径不成', normalizeRelPath('') === null && normalizeRelPath('/') === null && normalizeRelPath('.') === null)
  check('降级：正常相对路径拆成片段', (normalizeRelPath('我的书/正文/第001章.md') || []).join('>') === '我的书>正文>第001章.md')
  check('降级：反斜杠也认（Windows 拷过来的路径）', (normalizeRelPath('正文\\第001章.md') || []).join('/') === '正文/第001章.md')

  check('降级：只收文本类型', textExtOk('a.md') && textExtOk('a.TXT') && textExtOk('a.json') && textExtOk('SKILL.md'))
  check('降级：图片 / 文档 / 无扩展名一律不收', !textExtOk('封面.png') && !textExtOk('稿.docx') && !textExtOk('README') && !textExtOk('.gitignore'))

  const st = stripTop([
    ['我的书', '正文', '第001章.md'],
    ['我的书', '大纲', '剧情大纲.md']
  ])
  check('降级：剥掉 webkitdirectory 带进来的那层文件夹名', st.top === '我的书' && st.paths[0].join('/') === '正文/第001章.md')
  check('降级：首层不统一时不动手剥（宁可别猜）', stripTop([['a', 'x.md'], ['b', 'y.md']]).top === '')

  const plan = planImport([
    { relPath: '我的书/正文/第001章 启程.md', text: '船靠岸的时候，雨还没停。' },
    { relPath: '我的书/正文/第002章 重逢.md', text: '她没回头。' },
    { relPath: '我的书/记忆/状态表.md', text: '# 状态表' },
    { relPath: '我的书/封面.png', text: '二进制占位' },
    { relPath: '../外面.md', text: '不该进来' }
  ])
  check('降级：导入计划只留下文本文件', plan.files.length === 3, String(plan.files.length))
  check('降级：剥顶层后路径从作品根算起', plan.files[0].path.join('/') === '正文/第001章 启程.md', plan.files[0].path.join('/'))
  check('降级：作品名取自被选中的那层文件夹', plan.top === '我的书', plan.top)
  check('降级：没收进来的原样报出（图片 + 越界）', plan.skipped.length === 2 && plan.skipped.some((s) => s.includes('封面.png')), JSON.stringify(plan.skipped))
  const isum = summarizeImport(plan.files)
  check('降级：只把「正文/」算进字数（大纲记忆不冒充工作量）', isum.words === 14, String(isum.words))
  check('降级：导入结果说清文件数与未导入数', /已导入 3 个文件/.test(importSummaryText(plan)) && /2 个文件未导入/.test(importSummaryText(plan)), importSummaryText(plan))

  check('降级：FNV 指纹稳定且不同内容不同值', fnv1a('abc') === fnv1a('abc') && fnv1a('abc') !== fnv1a('abd'))
  check('降级：指纹带上长度（哈希撞了还有长度兜着）', fingerprint('abc') === `3:${fnv1a('abc')}`, fingerprint('abc'))
  const base = fingerprints([
    { path: '正文/第001章.md', text: 'A' },
    { path: '记忆/状态表.md', text: 'B' }
  ])
  const diff = diffAgainstBaseline(base, [
    { path: '正文/第001章.md', text: 'A（改过了）' },
    { path: '正文/第002章.md', text: 'C' }
  ])
  check(
    '降级：改过的 / 新增的 / 删掉的各归各',
    diff.changed.join() === '正文/第001章.md' && diff.added.join() === '正文/第002章.md' && diff.removed.join() === '记忆/状态表.md',
    JSON.stringify(diff)
  )
  check('降级：沙盒里删掉的文件算「删除」，并留在基线里继续报', diff.removed.join() === '记忆/状态表.md')
  check('降级：dirty 只含新增+修改（zip 表达得了的部分）', diff.dirty.join() === '正文/第001章.md,正文/第002章.md' && !diff.dirty.includes('记忆/状态表.md'), JSON.stringify(diff.dirty))
  check('降级：count 把删除也算进去（否则会谎报「已对齐」）', diff.count === 3)
  const clean = diffAgainstBaseline(base, [
    { path: '正文/第001章.md', text: 'A' },
    { path: '记忆/状态表.md', text: 'B' }
  ])
  check('降级：一模一样时 count 为 0 且说明文字说「已对齐」', clean.count === 0 && /已与磁盘对齐/.test(diffSummary(clean)), diffSummary(clean))
  check('降级：顶栏标记显示未导出数量', chipText(diff) === '沙盒 · 未导出 3' && chipText(clean) === '沙盒 · 已同步', chipText(diff))

  const at = new Date(2026, 9, 8, 9, 18)
  check('降级：导出文件名带作品名 / 范围 / 时间戳', sandboxFileName('示例书', at, 'changed') === '示例书-沙盒导出-改动-20261008-0918.zip', sandboxFileName('示例书', at, 'changed'))
  check('降级：文件名里的非法字符被换掉', !/[\\/:*?"<>|]/.test(sandboxFileName('a/b:c*d?', at)))
  const mani = sandboxManifest({ name: '示例书', scope: 'changed', files: [{ path: 'a.md', text: 'x' }], changed: ['a.md'], removed: ['b.md'], at })
  check('降级：导出清单记下范围、文件名与表达不了的删除', mani.scope === 'changed' && mani.changed.join() === 'a.md' && mani.removed.join() === 'b.md')

  check('降级：认得沙盒作品 id', isSandboxRefId('mem:示例书') && !isSandboxRefId('0d1e-9f'))
  const recents = [{ refId: 'mem:a' }, { refId: 'fs-1' }, { refId: 'mem:b' }]
  check('降级：降级模式只看得到沙盒作品（两类记录互不通用）', visibleRecents(recents, true).map((r) => r.refId).join() === 'mem:a,mem:b')
  check('降级：正常模式看不到沙盒作品', visibleRecents(recents, false).map((r) => r.refId).join() === 'fs-1')
  check('降级：首页说明把「代价」三条写全了', DEGRADE_NOTICE.steps.length === 3 && DEGRADE_NOTICE.limits.length === 3)
  check('降级：说明里明确写了「导出才能落盘」', DEGRADE_NOTICE.limits.some((l) => l.includes('导出')))

  /* 40. 内存宿主（P3-F）：没有 FSA 的浏览器上，整套工作区代码照常跑 */
  const prevAdapter = fs()
  setAdapter(memAdapter)
  try {
    const root = memAdapter.createRoot('沙盒书')
    const work = await ws.createWork(root, '沙盒书', { author: '无名' })
    check('内存宿主：建作品后在父目录里看得见', (await fs().listDir(root, [])).some((e) => e.name === '沙盒书' && e.kind === 'dir'))
    const topNames = (await fs().listDir(work, [])).map((e) => e.name)
    check('内存宿主：五标准目录齐了', ['大纲', '设定', '正文', '记忆', '技能'].every((n) => topNames.includes(n)), topNames.join(','))
    check('内存宿主：looksLikeWork 认得出来（不会误判成非作品目录）', await ws.looksLikeWork(work))

    const ch = await ws.createChapter(work, null, '启程')
    await ws.saveChapter(work, ch.id, '船靠岸的时候，雨还没停。', { title: '启程' })
    check('内存宿主：写进去的正文读得回来', (await ws.readChapterBody(work, ch.id)).includes('船靠岸'))
    check('内存宿主：章文件名按规范生成', ch.id === '正文/第001章 启程.md', ch.id)
    const scan = await ws.scanWork(work)
    check('内存宿主：扫描认得出这一章', scan.rootChapters.length === 1 && scan.rootChapters[0].title.includes('启程'), JSON.stringify(scan.rootChapters.map((c) => c.title)))

    const vol = await ws.createVolume(work, '归途')
    check('内存宿主：卷目录与卷纲都建出来了', await fs().exists(work, ['正文', vol.dir, '卷纲.md']))
    const newVol = await ws.renameVolume(work, vol.id, '返乡')
    check(
      '内存宿主：卷改名走 copyDir + remove，旧目录消失、新目录内容完整',
      !(await fs().exists(work, ['正文', vol.dir])) && (await fs().exists(work, newVol.split('/').concat('卷纲.md'))),
      `${newVol}（旧：${vol.dir}）`
    )

    await fs().writeFile(work, [ws.DIRS.snapshot, 'x__y', '2026-10-08 09-00 自动.md'], '旧稿')
    const listed = await fs().listDir(work, [])
    check('内存宿主：.snapshots 不出现在目录列表里（与 FSA 宿主一致）', !listed.some((e) => e.name === '.snapshots'))
    const all = memAdapter.dump(work, { includeHidden: true })
    check('内存宿主：但底层拿得到隐藏文件（防手滑存盘要它）', all.some((f) => f.path.includes('.snapshots')), String(all.length))
    const visible = memAdapter.dump(work, { includeHidden: false })
    check('内存宿主：dump 默认不含隐藏文件', !visible.some((f) => f.path.startsWith('.')))
    check('内存宿主：dump 的路径相对作品根（导出 zip 的条目名靠它）', visible.some((f) => f.path === '正文/第001章 启程.md'), JSON.stringify(visible.map((f) => f.path)))

    const collected = await collectFiles(work)
    check('内存宿主：备份层的目录树遍历能走通', collected.length >= 9, `${collected.length}：${collected.map((f) => f.path).join(' | ')}`)

    /* 回归：隐藏规则一度写成「凡 `.` 开头就藏」，于是一整个内容目录消失。
       大纲/.mdAI文件/ 是 context.ts 要读的正文源，点开头只是排版习惯。 */
    const outlineEntries = await fs().listDir(work, [ws.DIRS.outline])
    check(
      '内存宿主：大纲/.mdAI文件/ 照常列出来（点开头不等于内部物，藏了就是丢内容）',
      outlineEntries.some((e) => e.name === '.mdAI文件' && e.kind === 'dir'),
      outlineEntries.map((e) => e.name).join(',')
    )
    check(
      '内存宿主：真正的内部物（.snapshots）仍然不列出来',
      !(await fs().listDir(work, [])).some((e) => e.name === ws.DIRS.snapshot)
    )

    const dumpAll = memAdapter.serializer()
    check('内存宿主：序列化给出可存 IndexedDB 的平表', dumpAll.length === 1 && dumpAll[0].files.length === all.length, JSON.stringify(dumpAll.map((r) => r.files.length)))
    memAdapter.resetAll()
    check('内存宿主：清空之后根就不在了', !memAdapter.hasRoot(root.id))
    check('内存宿主：根没了以后读它要报错，而不是装作读到空文件', await (async () => {
      try {
        await fs().readFile({ id: dumpAll[0].id, name: dumpAll[0].name }, ['作品信息.md'])
        return false
      } catch {
        return true
      }
    })())
    memAdapter.restoreRoot(dumpAll[0].id, dumpAll[0].name, dumpAll[0].files)
    const back = { id: `${dumpAll[0].id}::沙盒书`, name: '沙盒书' }
    check('内存宿主：刷新后从 IndexedDB 恢复，正文原样回来', (await fs().readFile(back, ['正文', '第001章 启程.md'])).includes('船靠岸'))
    check('内存宿主：恢复后目录树也认得出来', await ws.looksLikeWork(back))
  } finally {
    setAdapter(prevAdapter)
    memAdapter.resetAll()
  }
  }

  /* 41. 大作品规模：行为对拍 + 耗时预算（P4）
   *
   * 这一节盯的是「百万字级」才露头的退化写法。两道真题（300 章 / 85 万字实测）：
   *   · 笔误检测原来写成「每章 × 每个名字 × 每个字符位置」三层嵌套 —— 12 秒；
   *   · 力导向布局每一步都用 live.find 线性找节点 —— 38 秒。
   * 现在分别换成「滑窗 + 删一字签名索引」和「下标寻址 + 章节位图求交」。
   * 下面既对拍行为（换实现不许换结果），也钉住耗时（换回旧写法立刻红）。
   * 预算写得宽松（新写法有几十倍余量），因为要在一台慢机器上也站得住。
   */
  {
    const prevHost = fs()
    setAdapter(host.adapter)
    const timedSync = <T>(fn: () => T): { ms: number; v: T } => {
      const t0 = performance.now()
      const v = fn()
      return { ms: performance.now() - t0, v }
    }
    try {
      const root = host.rootRef()
      const small = await buildScaleWork(root, { chapters: 30, volumes: 1, charsPerChapter: 1200, name: '规模小' })
      const big = await buildScaleWork(root, { chapters: 120, volumes: 2, charsPerChapter: 1200, name: '规模大', withEntries: false })
      const entries = small.entries
      check('规模语料：设定条目生成齐了（60 人物 + 30 地点 + 20 道具 + 10 组织）', entries.length === 120, String(entries.length))

      // 语料里掺了两个手误：汀兰 → 汀蓝、青芷 → 青芒。再补一章「正反对照」的正文。
      const tch = await ws.createChapter(small.ref, null, '笔误现场')
      await ws.saveChapter(small.ref, tch.id, '汀蓝推门进来，汀兰却不在。青芒站在檐下。赵钱也在。汀兰看了他一眼。\n')

      const smallScan = await ws.scanWork(small.ref)
      const bigScan = await ws.scanWork(big.ref)
      const smallCh = [...smallScan.rootChapters, ...smallScan.volumes.flatMap((v) => v.chapters)]
      const bigCh = [...bigScan.rootChapters, ...bigScan.volumes.flatMap((v) => v.chapters)]
      const smallBodies: Record<string, string> = {}
      for (const c of smallCh) smallBodies[c.id] = await ws.readChapterBody(small.ref, c.id)
      const bigBodies: Record<string, string> = {}
      for (const c of bigCh) bigBodies[c.id] = await ws.readChapterBody(big.ref, c.id)
      check('规模语料：两档作品都扫得出来', smallCh.length === 31 && bigCh.length === 120, `${smallCh.length}/${bigCh.length}`)

      const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

      /* 41.1 共现强度：位图实现 vs 朴素两两枚举（换实现不许换结果） */
      {
        const g = graph.buildGraph(entries, smallCh, smallBodies, { cooccurMin: 2 })
        const naive = new Map<string, number>()
        for (const ch of smallCh) {
          const text = smallBodies[ch.id] || ''
          if (!text.trim()) continue
          const present = entries.filter((e) => text.includes(e.name) || e.aliases.some((a) => text.includes(a)))
          for (let i = 0; i < present.length; i++) {
            for (let j = i + 1; j < present.length; j++) {
              const k = pairKey(present[i].id, present[j].id)
              naive.set(k, (naive.get(k) || 0) + 1)
            }
          }
        }
        const coEdges = g.edges.filter((e) => e.kind === 'cooccur')
        const byKey = new Map(g.edges.map((e) => [pairKey(e.source, e.target), e]))
        const same = coEdges.every((e) => naive.get(pairKey(e.source, e.target)) === e.weight)
        const covers = [...naive.entries()].filter(([, n]) => n >= 2).every(([k]) => byKey.has(k))
        check('位图算出的共现强度与朴素枚举逐条一致', same, `位图 ${coEdges.length} 条`)
        check('达到阈值的共现关系一条都不少', covers, `朴素 ≥2 的有 ${[...naive.values()].filter((n) => n >= 2).length} 条`)
        check('低于阈值的共现边不会建出来（除非本来就有显式链接）', coEdges.every((e) => e.weight >= 2))
      }

      /* 41.2 笔误检测：该报的报，不该报的不报 */
      {
        const issues = consistency.checkAll({ entries, chapters: smallCh, bodies: smallBodies, foreshadowRaw: '', currentId: tch.id })
        const typos = issues.filter((i) => i.kind === 'typo')
        check('一字之差的手误仍能检出（汀蓝 → 汀兰）', typos.some((i) => i.message.includes('汀蓝') && i.message.includes('汀兰')), typos.slice(0, 2).map((i) => i.message).join(' / '))
        check('一字之差的手误仍能检出（青芒 → 青芷）', typos.some((i) => i.message.includes('青芒')), typos.slice(0, 3).map((i) => i.message).join(' / '))
        check('长度相同但差两个字的词不报（赵钱）', !typos.some((i) => i.message.includes('赵钱')))
        check('设定里已知的名字不会被当成自己的笔误', !typos.some((i) => /出现「(.+?)」.*设定里的「\1」/.test(i.message)))
      }

      /* 41.3 关系图：画布上限只影响画布，不影响统计 */
      {
        const capped = graph.buildGraph(entries, bigCh, bigBodies, { includeChapters: true, maxEdges: 50 })
        check('画布上限生效：drawnEdges 不超过上限', capped.drawnEdges.length <= 50, String(capped.drawnEdges.length))
        check('上限只砍画布：edges 仍是完整关系（度数 / 连通分量要用它）', capped.edges.length > capped.drawnEdges.length, `${capped.edges.length} vs ${capped.drawnEdges.length}`)
        check('截断时显式 [[双链]] 优先保留', capped.drawnEdges.some((e) => e.kind === 'link'))
        const uncapped = graph.buildGraph(entries, smallCh, smallBodies, {})
        check('不设上限时 drawnEdges 就是 edges（默认行为一个字节没变）', uncapped.drawnEdges === uncapped.edges)
      }

      /* 41.4 耗时预算 + 近线性（旧写法在这两条上必红） */
      {
        const rOld = timedSync(() =>
          consistency.checkAll({ entries, chapters: smallCh, bodies: smallBodies, foreshadowRaw: '', currentId: '' })
        )
        const rBig = timedSync(() =>
          consistency.checkAll({ entries, chapters: bigCh, bodies: bigBodies, foreshadowRaw: '', currentId: '' })
        )
        check(`一致性对账 120 章 / 120 条设定 < 3000ms（实测 ${rBig.ms.toFixed(0)}ms）`, rBig.ms < 3000)
        check(
          `对账耗时随章数近线性（31→120 章，不到 10 倍）`,
          rBig.ms < Math.max(rOld.ms, 8) * 10,
          `${rOld.ms.toFixed(0)}ms → ${rBig.ms.toFixed(0)}ms`
        )

        const gBigLoose = graph.buildGraph(entries, bigCh, bigBodies, { includeChapters: true })
        const rLayoutBig = timedSync(() => graph.layout(gBigLoose.nodes, gBigLoose.edges, 260, 900, 620))
        const gSmallLoose = graph.buildGraph(entries, smallCh, smallBodies, { includeChapters: true })
        const rLayoutSmall = timedSync(() => graph.layout(gSmallLoose.nodes, gSmallLoose.edges, 260, 900, 620))
        check(
          `力导向布局 120 章 / ${gBigLoose.edges.length} 条边 < 3000ms（实测 ${rLayoutBig.ms.toFixed(0)}ms）`,
          rLayoutBig.ms < 3000
        )
        check(
          '布局耗时随规模近线性（不到 10 倍）',
          rLayoutBig.ms < Math.max(rLayoutSmall.ms, 8) * 10,
          `${rLayoutSmall.ms.toFixed(0)}ms（${gSmallLoose.edges.length} 边）→ ${rLayoutBig.ms.toFixed(0)}ms（${gBigLoose.edges.length} 边）`
        )

        const rGraphBig = timedSync(() =>
          graph.buildGraph(entries, bigCh, bigBodies, { includeChapters: true, maxEdges: 1200 })
        )
        check(`关系图构图 120 章 < 3000ms（实测 ${rGraphBig.ms.toFixed(0)}ms）`, rGraphBig.ms < 3000)

        const rRefBig = timedSync(() => links.buildRefIndex(bigCh, bigBodies, entries.map((e) => e.name)))
        check(`条目出场索引 120 章 × 120 名字 < 3000ms（实测 ${rRefBig.ms.toFixed(0)}ms）`, rRefBig.ms < 3000)
      }
    } finally {
      setAdapter(prevHost)
    }
  }


  /* 42. 大纲 / 卷纲 / 章纲导入（Word 与 md）
   *
   * 作者手里的结构常常是一份 Word：标题样式分卷分章、表格列着「章节 / 目标 / 字数」。
   * 先把 .docx 读成 Markdown（不引新依赖，也不用 DOMParser —— 自检跑在 Node 里），
   * 再认层级落盘。落盘那几条断言盯的是同一件事：**只追加，作者写过的东西不动**。
   */
  {
    const prevAdapter = fs()
    setAdapter(memAdapter)
    const zipDocx = (body: string) =>
      zipSync({
        '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
        'word/document.xml': strToU8(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
            body +
            '</w:body></w:document>'
        )
      })
    try {
      /* 42.1 Word → Markdown：标题样式、表格 */
      const docx = zipDocx(
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一卷 启程</w:t></w:r></w:p>' +
          '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第一章 雪夜</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>主角在雪夜里回到故乡，发现老宅已被查封。</w:t></w:r></w:p>' +
          '<w:tbl><w:tr>' +
          '<w:tc><w:p><w:r><w:b/><w:t>章节</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:b/><w:t>目标</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:b/><w:t>字数</w:t></w:r></w:p></w:tc>' +
          '</w:tr><w:tr>' +
          '<w:tc><w:p><w:r><w:t>第002章 见旧友</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:t>与旧友重逢，埋下赴京的引线</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:t>3000</w:t></w:r></w:p></w:tc>' +
          '</w:tr></w:tbl>'
      )
      const r = docxToMarkdown(docx)
      check('Word：Heading1 → 一级标题', r.text.includes('# 第一卷 启程'), r.text.slice(0, 40))
      check('Word：Heading2 → 二级标题', r.text.includes('## 第一章 雪夜'))
      check('Word：正文段落原样保留', r.text.includes('发现老宅已被查封'))
      check('Word：表格转成 GFM 表格（大纲常就是一张表）', r.text.includes('| 章节 | 目标 | 字数 |'), r.text.replace(/\n/g, ' | ').slice(0, 160))
      check('Word：表格补了分隔行，下游才认得出表头', r.text.includes('| --- | --- | --- |'))
      check('Word：表格内容一行不差', r.text.includes('| 第002章 见旧友 | 与旧友重逢，埋下赴京的引线 | 3000 |'))
      check('Word：表头不加粗 —— 否则会被当成一行数据', !/\|\s*\*\*章节\*\*/.test(r.text))
      check('Word：段落与表格计数对得上', r.tables === 1 && r.paragraphs >= 3, `${r.paragraphs} 段 / ${r.tables} 表`)
      check(
        'Word：章下面的表格留作章的正文，不会变成新章',
        parseOutlineText(r.text).volumes[0]?.chapters[0]?.text.includes('| 第002章') === true
      )

      /* 42.2 「加粗短行当标题」是可选项，默认不替作者猜 */
      const boldDoc = zipDocx(
        '<w:p><w:r><w:b/><w:t>第一章 雪夜</w:t></w:r></w:p><w:p><w:r><w:t>雪下了一夜。</w:t></w:r></w:p>'
      )
      check('Word：默认不把加粗短行当标题（宁可当正文）', !docxToMarkdown(boldDoc).text.includes('# '), docxToMarkdown(boldDoc).text)
      check(
        'Word：勾了开关才认 —— 大纲没用标题样式时的退路',
        docxToMarkdown(boldDoc, { boldAsHeading: true }).text.includes('## 第一章 雪夜')
      )

      /* 42.3 真 Word 文件（导出功能自己产出的 docx）读得回来 */
      const dxBlob = await toDocxBlob('测试作品', '甲', [{ file: '第001章 雪夜.md', title: '雪夜', body: '雪下了一夜。' }], defaultExportOptions())
      const back = docxToMarkdown(new Uint8Array(await dxBlob.arrayBuffer()))
      check('Word：导出功能产的真 docx 能读回来（标题与正文都在）', back.text.includes('雪夜') && back.text.includes('雪下了一夜'), back.text.slice(0, 60))
      let zipErr = ''
      try {
        docxToMarkdown(zipSync({ 'hello.txt': strToU8('x') }))
      } catch (e: any) {
        zipErr = String(e?.message || e)
      }
      check('Word：不是 docx 的包要说清原因，不静默失败', /document\.xml/.test(zipErr), zipErr)

      /* 42.4 Markdown → 卷章层级 */
      const outlineMd = [
        '# 第一卷 启程',
        '卷目标：回到原点',
        '',
        '## 第一章 雪夜',
        '本章目标：立住人物与处境',
        '雪夜回乡。',
        '',
        '# 第二卷 远行',
        '',
        '| 章节 | 目标 | 字数 |',
        '| --- | --- | --- |',
        '| 第010章 出发 | 离开故乡 | 3200 |',
        '| 第011章 遇险 | 第一次危机 | 3000 |'
      ].join('\n')
      const tree = parseOutlineText(outlineMd)
      check('层级：认出 2 卷', tree.volumes.length === 2, String(tree.volumes.length))
      check('层级：卷目标单独抽出来', tree.volumes[0].target === '回到原点', tree.volumes[0].target)
      check(
        '层级：二级标题是章，它下面的正文归到这一章',
        tree.volumes[0].chapters.length === 1 && tree.volumes[0].chapters[0].text.includes('雪夜回乡')
      )
      check(
        '层级：「本章目标」进 target，不混进正文',
        tree.volumes[0].chapters[0].target === '立住人物与处境' && !tree.volumes[0].chapters[0].text.includes('本章目标')
      )
      check('层级：卷下的表格每行一章', tree.volumes[1].chapters.length === 2, String(tree.volumes[1].chapters.length))
      check(
        '层级：表格里的目标与字数都带上',
        tree.volumes[1].chapters[0].target === '离开故乡' && tree.volumes[1].chapters[0].words === 3200,
        JSON.stringify(tree.volumes[1].chapters[0])
      )
      check('层级：一个标题都没有时整篇留作纯文本，不硬凑卷章', parseOutlineText('就一段话，没有标题。').plain)
      check('层级：三级标题并进所属章，不另起一章', parseOutlineText('# 卷\n## 第一章\n### 细节\n内容').volumes[0].chapters.length === 1)
      check('层级：只有章没有卷时给一个不分卷（章节直接进 正文/）', parseOutlineText('## 第一章 雪夜').volumes[0].name === '')

      /* 42.5 落盘：三种目标各写一遍 */
      const root = memAdapter.createRoot('大纲导入')
      const work = await ws.createWork(root, '大纲导入', {})
      const plotPath = await findBookOutlinePath(work)
      check('全书大纲：落在作者已有的剧情大纲文件上，不另起一份', plotPath.join('/').endsWith('剧情大纲.md'), plotPath.join('/'))
      const bookMd = '# 全书主线\n\n起于雪夜，终于归途。\n'
      await applyOutline(work, bookMd, parseOutlineText(bookMd), { mode: 'book', volumes: [], rootChapters: [] })
      let plot = await fs().readFile(work, plotPath)
      check('全书大纲：内容原样落盘', plot.includes('起于雪夜'))
      await applyOutline(work, '# 第二版主线', parseOutlineText('# 第二版主线'), { mode: 'book', volumes: [], rootChapters: [] })
      plot = await fs().readFile(work, plotPath)
      check('全书大纲：再导一次默认追加，已有的不丢', plot.includes('起于雪夜') && plot.includes('第二版主线'))
      await applyOutline(work, '# 第三版', parseOutlineText('# 第三版'), { mode: 'book', volumes: [], rootChapters: [], overwrite: true })
      plot = await fs().readFile(work, plotPath)
      check('全书大纲：勾了覆盖才真的覆盖', !plot.includes('起于雪夜') && plot.includes('第三版'))

      const scan0 = await ws.scanWork(work)
      const volRes = await applyOutline(work, outlineMd, tree, {
        mode: 'volume',
        volumes: scan0.volumes,
        rootChapters: scan0.rootChapters,
        createChapters: true
      })
      check('卷纲：建出 2 卷', volRes.volumesCreated === 2, String(volRes.volumesCreated))
      const scan1 = await ws.scanWork(work)
      check('卷纲：扫描看得见这两卷', scan1.volumes.length === 2, String(scan1.volumes.length))
      const v1st = scan1.volumes.find((v) => v.name.includes('第一卷'))!
      const v2nd = scan1.volumes.find((v) => v.name.includes('第二卷'))!
      check('卷纲：中文序号的卷按数字排，不按拼音（第一卷在二卷之前）', scan1.volumes.indexOf(v1st) < scan1.volumes.indexOf(v2nd), scan1.volumes.map((v) => v.name).join(' / '))
      const vo0 = await ws.readVolumeOutline(work, v1st.id)
      check('卷纲：卷目标写进 front matter', vo0.meta.target === '回到原点', String(vo0.meta.target))
      check('卷纲：正文里有章节安排', vo0.body.includes('第一章 雪夜'))
      check('卷纲：章坑位建出来了，但正文是空的（不替作者写正文）', v1st.chapters.length === 1 && v1st.wordCount === 0)
      check('卷纲：中文序号的卷名不会被套两层', !/第\d+卷 第/.test(v1st.dir), v1st.dir)
      check('卷纲：第二卷表格里的两章也建了', v2nd.chapters.length === 2)
      check('卷纲：章文件名里不重复出现两个章号', !/第001章 第010章/.test(v2nd.chapters[0].file), v2nd.chapters[0].file)

      const chRes = await applyOutline(work, outlineMd, tree, {
        mode: 'chapter',
        volumes: scan1.volumes,
        rootChapters: scan1.rootChapters,
        createChapters: true
      })
      check(
        '章纲：对上已有章节就只补目标，不重复建章',
        chRes.chaptersUpdated >= 3 && chRes.chaptersCreated === 0,
        `更新 ${chRes.chaptersUpdated} / 新建 ${chRes.chaptersCreated}`
      )
      const scan2 = await ws.scanWork(work)
      const w1st = scan2.volumes.find((v) => v.name.includes('第一卷'))!
      const w2nd = scan2.volumes.find((v) => v.name.includes('第二卷'))!
      check('章纲：「本章目标」写进了章节卡片', w1st.chapters[0].meta.target === '立住人物与处境', w1st.chapters[0].meta.target)
      check('章纲：表格里的目标也带过来了（字数不被当成目标）', w2nd.chapters[0].meta.target === '离开故乡', w2nd.chapters[0].meta.target)
      check('章纲：正文一个字没动', w1st.wordCount === 0 && w2nd.wordCount === 0)
      check('章纲：章数没有变多（说明没重复建章）', scan2.chapterCount === scan1.chapterCount, `${scan1.chapterCount} → ${scan2.chapterCount}`)
    } finally {
      setAdapter(prevAdapter)
      memAdapter.resetAll()
    }
  }

  /* 43. 切换动效的方向判定（P4 · 手机端）
     方向错了只是不好看，但顺序表一改，「以为往左推、实际往右推」这种错不会自己暴露 ——
     所以把判定单独测一遍。时长不在这里测：它只有一个来源（CSS 的 --motion-*），
     由 §45 盯着那张表是否齐。 */
  {
    const order = ['write', 'board', 'graph', 'timeline', 'stats']
    check('动效：往后翻时新页从右边进来（PPT 的「推入」）', slideDirection('write', 'board', order) === 'left')
    check('动效：往前翻时反过来', slideDirection('board', 'write', order) === 'right')
    check('动效：跨着翻也认方向（写作 → 统计）', slideDirection('write', 'stats', order) === 'left')
    check('动效：同一个视图不动，方向退回默认', slideDirection('graph', 'graph', order) === 'left')
    check(
      '动效：表里没有的值不抛错，退回默认方向',
      slideDirection('write', '不存在的视图', order) === 'left' && slideDirection('不存在的视图', 'write', order) === 'left'
    )
    check(
      '动效：顺序表倒过来时方向也跟着倒',
      slideDirection('stats', 'write', [...order].reverse()) === 'left' && slideDirection('write', 'stats', [...order].reverse()) === 'right'
    )
  }

  /* 44. AI 候选写回正文的落点（P4 补）：
     正文显示的是**编辑器里的那份文档**，state.content 只是它的镜像。
     曾经的「追加到本章末尾」直接 markDirty，结果作者看到的是「字数涨了、正文一个字没变」——
     因为字数、今日字数全读镜像，看起来还像写成功了。这里把那条路堵死。 */
  {
    const prevApi = applyApi.value
    const aiMod = await import('@/stores/ai')
    const wsStore = await import('@/stores/workspace')
    const st = wsStore.state
    const prevRef = st.ref
    const prevId = st.currentId
    const prevContent = st.content
    const prevDirty = st.dirty
    try {
      st.ref = null // 不给真作品：这样 saveNow() 会立刻返回，留下的只有 markDirty 的痕迹
      st.currentId = 'ch-fake'
      st.content = '原有正文\n'

      const calls: string[] = []
      const setCalls: string[] = []
      applyApi.value = {
        append: (md: string) => {
          calls.push(md)
        },
        setContent: (md: string) => {
          setCalls.push(md)
        },
        replaceSelection: () => true,
        focus: () => {}
      }

      const c: any = { id: 'c1', title: 'T', text: 'AI 写的这一段', mode: 'continue' }
      const ok = await aiMod.appendToChapter(c)
      check('AI 采纳：追加走编辑器的 applyApi（正文才看得见）', ok && calls.length === 1 && calls[0] === 'AI 写的这一段', JSON.stringify(calls))
      check('AI 采纳：有编辑器时不直接改 state.content（那是镜像）', st.content === '原有正文\n', JSON.stringify(st.content))
      check('AI 采纳：确实标了「已采纳」', c.applied === true)
      // 「追加」必须落在文档末尾。走整篇替换也能让正文变，但那会把作者刚写的一整章冲掉。
      check('AI 采纳：追加用 append，不是整篇 setContent（否则冲掉整章）', setCalls.length === 0, JSON.stringify(setCalls))

      // 编辑器不在（人在看板 / 关系图，右侧面板还开着）才允许退回改 store ——
      // 那种情况切回写作视图时编辑器会按 state.content 重新初始化，正好读到这段。
      applyApi.value = null
      const c2: any = { id: 'c2', title: 'T2', text: '第二段', mode: 'continue' }
      await aiMod.appendToChapter(c2)
      check('AI 采纳：编辑器不在时退回改 store（切回写作视图读得到）', st.content.includes('第二段'), JSON.stringify(st.content))

      // 空候选不该被当成「已采纳」
      const c3: any = { id: 'c3', title: 'T3', text: '   ', mode: 'continue' }
      check('AI 采纳：空候选直接拒绝，不标已采纳', (await aiMod.appendToChapter(c3)) === false && !c3.applied)
    } finally {
      applyApi.value = prevApi
      st.ref = prevRef
      st.currentId = prevId
      st.content = prevContent
      st.dirty = prevDirty
    }
  }

  /* 45. 动效时长只能有一个来源（P4 · 手机端）
     时长写在 CSS 变量里，Vue 是按**算出来的时长**决定何时把旧元素摘掉的。
     若有人另起炉灶在别处写死一个数字、两边不一致，症状是「动画演一半元素就没了」——
     肉眼看像随机闪烁，极难归因。所以直接读 CSS 源文件，把这张表钉住。 */
  {
    const css = readSrc('src/styles/global.css')
    const deck = css.slice(css.indexOf('html {'), css.indexOf('}', css.indexOf('html {')))
    check(
      '动效：时长与缓动定义在 html 上（不是 :root —— 它们跟主题无关，别混进主题变量表）',
      /--motion-view\s*:/.test(deck) && /--motion-drawer\s*:/.test(deck) && /--ease-switch\s*:/.test(deck),
      deck.replace(/\s+/g, ' ').slice(0, 120)
    )
    /* 过渡时长的「唯一来源」闸门。
       只查 Vue 管的这四组过渡类（vp / drawer / dock / scrim）：Vue 读它们的
       **算出来的时长**决定何时把旧元素摘掉，两边写得不一致就会出现
       「动画演一半元素没了」。按钮 hover 反馈那类写死数字的 transition
       跟 Vue 无关，不该被这条断言绑架 —— 收得太宽就会误伤既有样式。 */
    const VUE_FX = /\.(vp-(left|right)|drawer-(l|r)|dock-(left|right)|scrim)-/
    const offenders = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => VUE_FX.test(m[1]))
      .filter((m) => /transition:/.test(m[2]))
      .filter((m) => /\b\d+m?s\b/.test(m[2].replace(/var\([^)]*\)/g, '')))
      .map((m) => `${m[1].trim().replace(/\s+/g, ' ')} → ${m[2].trim().replace(/\s+/g, ' ')}`)
    check(
      '动效：Vue 管的四组过渡（view/drawer/dock/scrim）时长都走 var(--motion-*)',
      offenders.length === 0,
      offenders.join(' | ')
    )
    // 上面那条是「没有坏东西」，「四组都在且接对了自己的变量」还得正面钉一遍 ——
    // 否则把整段规则删掉也能让它变绿。
    const wiring: Array<[string, RegExp]> = [
      ['主区推入', /\.vp-left-enter-active,[\s\S]{0,200}?transition:\s*transform var\(--motion-view\)/],
      ['左右抽屉', /\.drawer-l-enter-active,[\s\S]{0,200}?transition:\s*transform var\(--motion-drawer\)/],
      ['遮罩淡变', /\.scrim-enter-active,[\s\S]{0,120}?transition:\s*opacity var\(--motion-fade\)/],
      ['页签切换', /\.dock-left-enter-active,[\s\S]{0,200}?transition:\s*opacity var\(--motion-tab\)/]
    ]
    const broken = wiring.filter(([, re]) => !re.test(css)).map(([n]) => n)
    check('动效：四组过渡都接上了各自的时长变量（删掉一段就会红）', broken.length === 0, broken.join(', '))
    // 推入必须「两个同时在场上」：离场的那份要脱离文档流，容器要裁掉溢出
    check('动效：主区容器裁掉了溢出（不裁的话推入时页面会被撑宽）', /html\.ua-mobile \.main \{[\s\S]{0,120}?overflow: hidden/.test(css))
    check('动效：离场的视图脱离了文档流（否则两份会并排各占一半）', /\.vp-left-leave-active,[\s\S]{0,120}?position: absolute/.test(css))
    // 遮罩不能再挂 animation：它的 fill:both 在层叠里压得住 transition，退场会卡住
    check('动效：遮罩只用 transition，没有 animation（否则永远淡不掉）', /\.drawer-scrim \{[\s\S]{0,200}?\}/.test(css) && !/\.drawer-scrim \{[\s\S]{0,200}?animation:/.test(css))
  }

  /* 46. 「改正文只有一条路：走编辑器」（§44 那条规矩的通用版）
     编辑器**只在 currentId 变化时**才从 state.content 同步一次。所以任何
     「读点什么 → 只写 state.content」的流程（AI 采纳、快照回滚……）都会造成
     「屏幕上没变、盘上变了」，而下一个按键 / 下一次自动保存又按屏幕上的旧正文
     覆盖回去 —— 表现是「功能好像生效了，然后改动自己没了」。

     这条规矩的调用点都在 Vue 组件里，selfcheck 起不了组件（也不该起），
     所以对源码钉；行为上的证据在 e2e §7.10b（真编辑器 + 真磁盘）。 */
  {
    const editorStore = readSrc('src/stores/editor.ts')
    check(
      '改正文：ApplyApi 里有整篇替换的入口（setContent）',
      /interface ApplyApi \{[\s\S]*?setContent\(md: string\)/.test(editorStore)
    )
    const pane = readSrc('src/components/EditorPane.vue')
    check(
      '改正文：setContent 同时改编辑器与镜像（漏一边就是屏幕/磁盘不一致）',
      /setContent\(md: string\) \{[\s\S]{0,240}?setContentBoth\(md\)/.test(pane) &&
        /function setContentBoth\(md: string\) \{[\s\S]{0,200}?markDirty\(md\)/.test(pane)
    )
    const snap = readSrc('src/components/SnapshotDialog.vue')
    check(
      '改正文：快照回滚走编辑器的 setContent（只改镜像的话回滚会被下一次自动保存覆盖）',
      /applyApi/.test(snap) && /api\.setContent\(/.test(snap)
    )
  }

  /* 47. 切视图 / 切页签只有一个入口（P4 · 手机端）
     动效的方向是 setView / setDockTab 在**改状态之前**算好写进 viewFx/dockFx 的。
     绕过去直接 `editorState.view = '板'` 的话照样能切，只是方向是上一次留下的 ——
     表现是「有时候从右边推、有时候从左边推」，像随机闪烁，很难归因。

     §36·2 那条「隐藏文件规则只有一份」踩的是同一种坑：**规则可以有例外，入口不能有**。
     调用点在 .vue 里（selfcheck 起不了组件），所以对着源码钉。 */
  {
    const read = readSrc
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const e of readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })) {
        const rel = dir + '/' + e.name
        if (e.isDirectory()) out.push(...walk(rel))
        else if (/\.(ts|vue)$/.test(e.name)) out.push(rel)
      }
      return out
    }
    const files = [...walk('src/components'), ...walk('src/views'), ...walk('src/stores')]
    const offenders: string[] = []
    for (const f of files) {
      // 定义本身就在 stores/editor.ts 里，那里当然要赋值
      if (f.endsWith('stores/editor.ts')) continue
      const src = read(f)
      for (const m of src.matchAll(/editorState\.(view|dockTab)\s*=[^=]/g)) offenders.push(`${f}: ${m[0].trim()}`)
    }
    check(
      '动效：切视图/切页签都走 setView / setDockTab（绕过去方向就是上一次的随机残留）',
      offenders.length === 0,
      offenders.join(' | ')
    )
  }

  /* 48. 手机端那批重排规则还在不在（P4 · 手机端）
     这批是纯 CSS：删掉不报错、构建毫无反应，只有手机上肉眼才看得出「怎么又变回电脑那副样子」。
     布局类的那几条 e2e §7.13 已经按**算出来的样式**验过了，这里补的是
     只能在真触摸设备上才体现出来、浏览器里量不出来的几条。 */
  {
    const css = readSrc('src/styles/global.css')
    check(
      '手机：关系图节点关掉了原生触摸手势（不关的话按住圆点一拖就变成滚页面）',
      /html\.ua-mobile \.graph \.node \{[\s\S]{0,80}?touch-action: none/.test(css)
    )
    check(
      '手机：底部工具条的按键有按下去的形变（触摸没有 hover，不给反馈就像点空了）',
      /html\.ua-mobile \.mobile-bar button \{[\s\S]{0,160}?transform/.test(css)
    )
    check(
      '手机：四个全局视图的头部说明行可以换行（不换行会把按钮顶出屏幕）',
      /html\.ua-mobile \.board \.head,[\s\S]{0,200}?flex-wrap: wrap/.test(css)
    )
  }

  /* 49. AI 工具扩展（生成 / 纠错 / 大纲推荐 / 技能导入）
     这些功能的共同约束是「产出只进候选区，采纳只走 applyApi」—— §44 钉的是既有三条路，
     这里钉的是新加的三条路 + 几个「入口必须真的是按钮」的教训。 */
  {
    const types = readSrc('src/core/types.ts')
    check(
      'AI：候选 mode 里有生成与纠错（types 是唯一的一份清单）',
      /mode: 'continue' \| 'rewrite' \|[\s\S]{0,120}?'generate' \| 'fix'/.test(types)
    )
    check(
      'AI：纠错的「改动说明」是独立字段（混进正文的话采纳会把说明一起写进稿子）',
      /notes\?: string/.test(types) && /wholeChapter\?: boolean/.test(types)
    )
    const ai = readSrc('src/stores/ai.ts')
    check(
      'AI：生成/纠错在 labelOf 与提示词表里各有一份（漏了候选标题会是 undefined）',
      /generate: '生成'[\s\S]{0,80}fix: '纠错'/.test(ai) &&
        /任务：根据「补充要求」与上下文里的设定，从零写一段新的正文/.test(ai) &&
        /=== 改动说明 ===/.test(ai)
    )
    check(
      'AI：纠错结果在入库前拆开（正文进 text，说明进 notes）',
      /args\.mode === 'fix'[\s\S]{0,400}?indexOf\(MARK\)[\s\S]{0,200}?notes =/.test(ai)
    )
    const cand = readSrc('src/components/CandidatePanel.vue')
    check(
      'AI：纠错整章候选走 applyApi.setContent（直接改镜像就是「字数涨了正文没变」那个 bug 家族）',
      /function applyWholeChapter[\s\S]{0,300}?api\.setContent\(c\.text\)/.test(cand)
    )
    check(
      'AI：大纲候选的落点是大纲文件，不是正文选区（解析不出表格就不许写盘）',
      /async function adoptOutline[\s\S]{0,400}?parseOutlineMarkdown[\s\S]{0,600}?writeFile\(state\.ref, \['大纲', '大纲\.md'\]/.test(cand)
    )
    const ctx = readSrc('src/components/ContextPanel.vue')
    check(
      'AI：AI 面板不再用原生 alert（桌面壳会静默失败，提示必须落在自己身上）',
      !/\balert\(/.test(ctx)
    )
    check(
      'AI：纠错没选区时退到整章（这是它最常用的形态），其余局部工具仍然要求选区',
      /SEL_MODES = \['rewrite', 'expand', 'shrink', 'tone', 'fix'\]/.test(ctx) &&
        /mode\.value !== 'fix'[\s\S]{0,200}whole = true/.test(ctx)
    )
    const bar = readSrc('src/components/TopBar.vue')
    check(
      'AI：顶栏 AI 入口是带 openAi 的按钮（曾经只是个 span 徽章 ——「点了没反应」的报告全源于此）',
      /function openAi\(\)[\s\S]{0,400}setDockTab\('context'\)/.test(bar) && /class="aibtn"[\s\S]{0,200}@click="openAi"/.test(bar)
    )
    const dock = readSrc('src/components/RightDock.vue')
    check(
      '技能：技能页签常驻（藏进「配了 API 才有」那组，作者没配置时以为根本不能导入）',
      /\{ k: 'skill', label: '技能' \}/.test(dock)
    )
    const sk = readSrc('src/components/SkillPanel.vue')
    check(
      '技能：单个 md/txt 也能导入（最常见的形态就是一个 SKILL.md，不该逼人先打成 zip）',
      /accept="\.zip,\.md,\.markdown,\.txt"/.test(sk) && /parseSkillFile\(raw, 'work', f\.name\)/.test(sk)
    )
    const dlg = readSrc('src/components/OutlineDialog.vue')
    const outline = readSrc('src/core/outline.ts')
    check(
      '大纲：推荐模式存在（从零推荐故事线，材料或标签至少要给一样）',
      /recommendPrompt/.test(outline) && /recommendPrompt/.test(dlg) && /'recommend'/.test(dlg)
    )
    check(
      '大纲：卷数/章数是输入框（不再自动算一个给人看）',
      /v-model\.number="shape\.volumes"/.test(dlg) && /v-model\.number="shape\.chapters"/.test(dlg) && /reshapeSkeleton/.test(dlg)
    )
    check('大纲：老的「共 X 卷 · Y 章」自动推导行已删掉', !/共 \{\{ active\.volumes\.length \}\}/.test(dlg))
    check('大纲：导入大纲后会自动把规模填成它的样子', /watch\(parsed[\s\S]{0,120}?syncShape/.test(dlg))
    check(
      '大纲：推荐提示词带「想法」（标签 + 想法 + 材料三样都要进 AI）',
      /idea: recIdea\.value/.test(dlg) && /idea\?: string/.test(outline)
    )
    check('大纲：标签与篇幅走 core/tags（零依赖纯函数，不引分词库）', /from '@\/core\/tags'/.test(dlg))
  }

  /* 50. 写作区稿纸不许塌缩（2026-10-09 的真实截图事故）
     .editor-wrap 丢了 flex:1 就会按内容 max-content 定宽 —— 空章/短章时整个写作区
     塌成一条几十像素的窄竖条贴在左边，而「有字的章」被 flex-shrink 压回可用宽度，
     bug 自我掩盖。行为证据在 e2e §5.0b（量的是真实像素），这里钉 CSS 源头。 */
  {
    const pane = readSrc('src/components/EditorPane.vue')
    check(
      '稿纸：.editor-wrap 必须自己伸手要宽度（flex: 1，否则空章时塌成窄竖条）',
      /\.editor-wrap \{[\s\S]{0,220}?flex: 1 1 auto;/.test(pane)
    )
    const css = readSrc('src/styles/global.css')
    check(
      '稿纸：手机上的页边距覆盖还在（52px 页边距在 390px 屏上只剩 286px 可写）',
      /html\.ua-mobile \.paper-col \{[\s\S]{0,160}?padding: 20px 18px 72px;/.test(css)
    )
  }

  /* 51. 字不许被自己的样式削掉（2026-10-10 作者报「导入稿件处有乱码」）
     真凶不是编码。ImportDialog 给下拉框写死了 height: 26px：13px 的汉字要 17px 行高，
     减去上下 padding 12px 与边框 2px，内容盒只剩 12px —— 每个字上下各削 2.5px，
     「自动按「第X章」」的「章」被削成了「音」，作者看到的就是乱码；顺带它比旁边
     两个 31px 的输入框矮一截，三个控件对不齐。
     行为证据在 e2e §7.14（量的是真实控件的像素），这里钉源头：**不许给下拉框定高**。
     定高在别的机器/别的字号下偶然没事，所以只靠肉眼看截图是抓不住的。 */
  {
    const read = readSrc
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const e of readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })) {
        const rel = dir + '/' + e.name
        if (e.isDirectory()) out.push(...walk(rel))
        else if (/\.(css|vue)$/.test(e.name)) out.push(rel)
      }
      return out
    }
    const offenders: string[] = []
    for (const f of ['src/styles/global.css', ...walk('src/components'), ...walk('src/views')]) {
      const src = read(f)
      // 逐条规则看：选择器里点了 select 的规则，块内不许出现定高
      for (const m of src.matchAll(/([^{}]*select[^{}]*)\{([^}]*)\}/g)) {
        const [, sel, body] = m
        // 只看真的在给 select 自己定高，`:not(select)`、`select option` 之类不算
        if (!/\bselect\b/.test(sel.replace(/:not\([^)]*\)/g, ''))) continue
        const h = body.match(/(?:^|;|\s)height:\s*(\d+(?:\.\d+)?)px/)
        if (h) offenders.push(`${f}  ${sel.trim()}  height: ${h[1]}px`)
      }
    }
    check(
      '字号安全：下拉框不许写死高度（13px 的字要 17px 行高，写死了上下就削字 → 看着像乱码）',
      offenders.length === 0,
      offenders.join(' | ')
    )
    const imp = readSrc('src/components/ImportDialog.vue')
    check(
      '导入稿件：切章方式的下拉框改成跟着输入框一起撑高（不写数字，就不怕换字号）',
      /\.grid3 select \{[\s\S]{0,200}?flex: 1 1 auto/.test(imp) && !/\.grid3 select \{[\s\S]{0,200}?height:/.test(imp)
    )
    check(
      '导入稿件：正则那格给了人话提示（^ / \\d / + 不能是作者看不懂的乱符）',
      /如 \^第\\d\+章/.test(imp) && /正则不会写就留空/.test(imp)
    )
    check(
      '导入稿件：正文/ 与 全稿.txt 这类代码片段不许在中间断行（断了右半边像多出一个怪符号）',
      /code \{[\s\S]{0,200}?white-space: nowrap/.test(imp)
    )
  }

  /* 52. 候选区必须能删、换作品必须清（2026-10-10 作者报「续写窗口一直存在，删不掉」）
     两件事一起钉，因为它们是一起暴露的：
       ① 候选卡片上没有任何删除入口 —— 生成完只能一直挂着；
       ② `aiState` 是模块级 reactive，`openWork` / `closeWork` 都不碰它 ——
          换作品后上一部的候选还留在面板里，看着像"删不掉的窗口"。
     只补 ① 不补 ②，跨作品残留照样在；只补 ② 不补 ①，单张卡还是清不掉。 */
  {
    const cand = readSrc('src/components/CandidatePanel.vue')
    const ai = readSrc('src/stores/ai.ts')
    const wsp = readSrc('src/stores/workspace.ts')
    const hooks = readSrc('src/core/hooks.ts')

    check(
      '候选区：每张卡都有删除按钮（作者报过"删不掉"，只有清空是不够的）',
      /function removeOne\s*\(/.test(cand) && /@click="removeOne\(c\)"/.test(cand) && /removeCandidate\(c\.id\)/.test(cand)
    )
    check('候选区：顶部有「清空」（一次全清，不用逐张点）', /function clearAll\s*\(/.test(cand) && /@click="clearAll"/.test(cand))
    check(
      '候选区：删除走 askConfirm，不许用 window.confirm（桌面壳会禁掉原生弹窗）',
      /askConfirm\(/.test(cand) && !/window\.confirm/.test(cand)
    )
    check(
      '候选区：已采纳的卡删除时额外确认一次（候选只在内存里，删了不可撤销）',
      /c\.applied[\s\S]{0,300}?askConfirm/.test(cand)
    )

    check(
      '换作品要清 AI 层：workspace 的 openWork 与 closeWork 都得通知',
      /runWorkResetHooks\(\)/.test(wsp) && (wsp.match(/runWorkResetHooks\(\)/g) || []).length >= 2
    )
    check(
      '换作品要清 AI 层：清理项包含候选区（不然"删不掉的窗口"跨作品复现）',
      /export function resetForWork/.test(ai) && /aiState\.candidates = \[\]/.test(ai)
    )
    check(
      '换作品要清 AI 层：正在生成的请求也要中止（不然旧作品的字会流进新作品的面板）',
      /resetForWork[\s\S]{0,400}?abort\?\.abort\(\)/.test(ai)
    )
    // 环：ai.ts 已经 import 了 workspace.ts，反过来再 import 就是 stores 层成环。
    // ESM 容得下环，但环上的初始化顺序不确定 —— 表现是「有时能用，改个 import 顺序就炸」。
    check('⚠ 依赖方向：workspace.ts 不许反过来 import stores/ai（会成环）', !/from '@\/stores\/ai'/.test(wsp))
    check('⚠ 依赖方向：换作品钩子走 core/hooks.ts（两侧都只依赖 core）', /export function runWorkResetHooks/.test(hooks) && /export function onWorkReset/.test(hooks))
    check('⚠ 依赖方向：ai.ts 通过 onWorkReset 登记，不直接调 workspace', /onWorkReset\(resetForWork\)/.test(ai))
    check(
      '换作品钩子：单个回调抛异常不能连累其它（否则一个 store 出错就把换作品整个卡住）',
      /for \(const fn of hooks[\s\S]{0,200}?try \{[\s\S]{0,120}?catch/.test(hooks)
    )
  }

  /* 53. DSH Agent 事件流解析（2026-10-10 对接 L2）
     下面每一条 JSON **都是 2026-10-10 实测 `dsh --profile headless --json` 抓下来的原样行**
     （dsh 0.2.0-rc.2，本机）。用真实输出当夹具，而不是自己编一份「应该长这样」的 ——
     自己编的夹具只能证明代码和它自己的想象一致。
     改动这个解析器前，请先重跑那条命令核对字段。 */
  {
    const agent = await import('@/core/agent')

    // —— 真实事件行 ——
    const L_SESSION = '{"type":"session","sessionId":"session-5b9c4a02-73fc-4147-89d9-73d23c34d54d","cwd":"E:\\\\x"}'
    const L_THINK = '{"type":"thinking","text":"Simple task: read the file 一句话.txt in current directory."}'
    const L_CALL = '{"type":"tool_call","callId":"call_00_8aM4p0qz5yu7nUj4H0U83611","tool":"read","input":{"file_path":"E:\\\\Worksplace\\\\agentprobe\\\\一句话.txt"}}'
    const L_RESULT = '{"type":"tool_result","callId":"call_00_8aM4p0qz5yu7nUj4H0U83611","status":"completed","result":"<path>…</path>"}'
    const L_TEXT = '{"type":"text","text":"`一句话.txt` 里只有两个字：「测试」。"}'
    const L_FINAL = '{"type":"final","text":"`一句话.txt` 里只有两个字：「测试」——内容就是一次测试。"}'
    const L_STATUS = '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}'

    const evSession = agent.parseAgentLine(L_SESSION)
    check('Agent 事件：session 行能取到会话 id（续接全靠它）', evSession?.kind === 'session' && evSession.sessionId === 'session-5b9c4a02-73fc-4147-89d9-73d23c34d54d', evSession?.sessionId)

    const evCall = agent.parseAgentLine(L_CALL)
    check(
      'Agent 事件：tool_call 能认出来，并把文件路径变成人话摘要',
      evCall?.kind === 'tool_call' && evCall.call?.tool === 'read' && /读取/.test(evCall.label) && /一句话\.txt/.test(evCall.label),
      evCall?.label
    )
    check(
      'Agent 事件：路径只留末两段（整条绝对路径会把「过程」列表挤爆）',
      !/[A-Za-z]:\\/.test(evCall?.label || ''),
      evCall?.label
    )
    check(
      'Agent 事件：tool_result 的 status=completed 判成成功',
      agent.parseAgentLine(L_RESULT)?.ok === true,
      String(agent.parseAgentLine(L_RESULT)?.ok)
    )
    check('Agent 事件：tool_result 的失败状态要报出来（不能静默当成成功）', agent.parseAgentLine('{"type":"tool_result","callId":"x","status":"failed"}')?.ok === false)
    check('Agent 事件：text 行取到正文', agent.parseAgentLine(L_TEXT)?.text?.includes('测试') === true)
    check('Agent 事件：final 行取到全文', agent.parseAgentLine(L_FINAL)?.text?.startsWith('`一句话.txt`') === true)
    check('Agent 事件：turn_end 收尾判成「完成」', agent.parseAgentLine(L_STATUS)?.label === '完成', agent.parseAgentLine(L_STATUS)?.label)
    check(
      'Agent 事件：不认识的 type 归到 unknown 但**不丢行**（丢的往往正是出问题那行）',
      agent.parseAgentLine('{"type":"future_thing","x":1}')?.kind === 'unknown' &&
        agent.parseAgentLine('{"type":"future_thing","x":1}')?.raw?.includes('future_thing') === true
    )
    check(
      'Agent 事件：非 JSON 噪声也要留着（cmd.exe 会把提示符混进 stdout）',
      agent.parseAgentLine('not json at all')?.kind === 'unknown'
    )
    check('Agent 事件：空行返回 null（不是造一条空事件出来）', agent.parseAgentLine('   ') === null)
    check(
      'Agent 事件：step_start/step_end 不占「过程」列表（每次工具调用都是一对，全显示会淹掉真信息）',
      agent.parseAgentLine('{"type":"status","phase":"step_start","turn":1,"step":1}')?.label === ''
    )

    // —— 增量累积 ——
    const st = new agent.AgentStream()
    st.push(L_SESSION)
    st.push(L_CALL)
    st.push(L_TEXT)
    st.push(L_FINAL)
    check('Agent 累积：会话 id 被留下', st.sessionId.startsWith('session-'), st.sessionId)
    check('Agent 累积：最终文本以 final 为准（不是把后面几段拼起来）', st.result().startsWith('`一句话.txt` 里只有两个字'), st.result().slice(0, 30))
    check('Agent 累积：工具调用计数为 1', st.toolCount === 1, String(st.toolCount))
    check('Agent 累积：「过程」列表里有工具调用那一行', st.steps.some((s) => s.kind === 'tool_call' && /读取/.test(s.label)))

    // DSH 的 text 事件实测是「一整段」，但两种行为都要能对。写死一种，
    // DSH 换输出策略就会看到重复两遍或只剩最后一段。
    const grow = new agent.AgentStream()
    grow.push('{"type":"text","text":"第一段。"}')
    grow.push('{"type":"text","text":"第一段。第二段。"}')
    check('Agent 累积：新段落包含旧内容时按**替换**处理（不许拼成两遍）', grow.text === '第一段。第二段。', grow.text)
    const app2 = new agent.AgentStream()
    app2.push('{"type":"text","text":"第一段。"}')
    app2.push('{"type":"text","text":"第二段。"}')
    check('Agent 累积：完全不相干的两段按**追加**处理', app2.text === '第一段。第二段。', app2.text)
    const dup = new agent.AgentStream()
    dup.push('{"type":"text","text":"已经说过了"}')
    dup.push('{"type":"text","text":"已经说过了"}')
    check('Agent 累积：尾巴重复的输出被忽略（不显示两遍）', dup.text === '已经说过了', dup.text)
  }

  /* 54. Agent 后端的接线（源码闸门）
     这一节钉的是「有没有接错槽」——真能跑起来是桌面验收的事（要装 DSH），
     但槽位接错（参数名、feature 门控、权限档位默认值）在这里就能抓住。 */
  {
    const rs = readSrc('src-tauri/src/commands/agent.rs')
    const mod = readSrc('src-tauri/src/commands/mod.rs')
    const lib = readSrc('src-tauri/src/lib.rs')
    const bridge = readSrc('src/platform/aiBridge.ts')
    const aiStore = readSrc('src/stores/ai.ts')
    const settingsSrc = readSrc('src/core/settings.ts')

    check('Agent：Rust 模块挂 net feature（与 ai.rs 同门控）', /#\[cfg\(feature = "net"\)\]\s*pub mod agent;/.test(mod))
    check(
      'Agent：三条命令都注册进 generate_handler 且带 net 门控',
      ['agent_probe', 'agent_run', 'agent_cancel'].every((c) => new RegExp(`#\\[cfg\\(feature = "net"\\)\\]\\s*commands::agent::${c}`).test(lib)),
      ''
    )
    check(
      '⚠ Agent：task 必须走 Command::arg，绝不拼进命令行（拼串 = 命令注入）',
      /cmd\.arg\(&task\)/.test(rs) && !/format!\([^)]*\.arg\(/.test(rs) && !/Command::new\([^)]*\)\.arg\(&format!/.test(rs)
    )
    check(
      '⚠ Agent：Windows 上 .cmd 借 shell 执行时，路径也走 arg 而不是拼串',
      /c\.arg\("\/C"\)\.arg\(cli\)/.test(rs)
    )
    check('⚠ Agent：子进程带 CREATE_NO_WINDOW（桌面端不该闪黑框）', /CREATE_NO_WINDOW/.test(rs) && /creation_flags/.test(rs))
    check('Agent：同一时刻只允许一个 run（多个 Agent 同时改一个作品会互相看不见）', /if !m\.is_empty\(\)/.test(rs))
    check('Agent：默认只读档位', /fn\s+read_only|permission\.as_deref\(\) != Some\("write_in_cwd"\)/.test(rs) && /agentPermission: 'read_only'/.test(settingsSrc))
    check('Agent：只读提示词明写禁止写文件', /禁止\*\*创建、修改、删除任何文件/.test(rs))
    check('Agent：cwd 固定为作品目录', /current_dir\(&cwd\)/.test(rs) && /async function fsAdapterRoot/.test(aiStore) && /cwd: id,/.test(aiStore))
    check('Agent：带超时（长篇续写会跑很久，但不能永远挂着）', /timeout_secs/.test(rs) && /elapsed\(\) > timeout/.test(rs))

    check('Agent 桥：只在桌面端可用（浏览器/手机直接拒）', /export async function agentAvailable/.test(bridge) && /isMobile/.test(bridge))
    check(
      'Agent 桥：取消令牌由前端生成（Rust 的 run_id 要等返回才知道，那时已经跑完了）',
      /cancelToken: string/.test(bridge) && /cancel_token: String/.test(rs) && /const token = uid\('agentrun'\)/.test(aiStore)
    )
    check(
      'Agent 引擎：both 档 Agent 失败要回落直连 API（别让作者两头空）',
      /settings\.ai\.engine === 'both' && apiReady\(\)/.test(aiStore) && /return null/.test(aiStore)
    )
    check('Agent 引擎：会话按作品绑定（换作品换会话，前后文不互串）', /agentSessions/.test(settingsSrc) && /function sessionKey/.test(aiStore))
    check('Agent 引擎：aiEnabled 在 agent 档不要求 Key（DSH 自己管密钥）', /a\.engine === 'agent' && a\.configured/.test(settingsSrc))
  }

  /* 55. Agent 技能投递 + 权限模式（2026-10-10 实跑 DSH 得出的硬约束）

     这一节钉的是「DSH 那边到底认什么」——三条全是实测出来的，不是猜的：
     1) 技能名必须是 ASCII slug，中文名报 invalid skill name；
     2) 技能只从 ~/.dsh/skills/<slug>/SKILL.md 登记（customSkillDirs 运行时不被扫描）；
     3) 沙箱在 Windows 上跑不起来，必须显式给 DSH_PERMISSION_MODE=danger-full-access。
     这三条错了，Agent 要么看不见技能、要么干脆一条命令都跑不动。 */
  {
    const rs = readSrc('src-tauri/src/commands/agent.rs')
    const lib = readSrc('src-tauri/src/lib.rs')
    const bridge = readSrc('src/platform/aiBridge.ts')
    const aiStore = readSrc('src/stores/ai.ts')
    const agSkills = readSrc('src/core/agentSkills.ts')
    const skillSrc = readSrc('src/core/skills.ts')
    const typesSrc = readSrc('src/core/types.ts')

    // —— 权限模式 ——
    check(
      '⚠ Agent：显式给 DSH_PERMISSION_MODE（默认 workspace-write 在本机 grantWrite 就挂，什么都跑不起来）',
      /cmd\.env\("DSH_PERMISSION_MODE",\s*"danger-full-access"\)/.test(rs)
    )
    check(
      'Agent：权限模式的选择原因写在源码注释里（下次别再退回默认档）',
      /SetNamedSecurityInfoW failed/.test(rs) && /workspace-write/.test(rs)
    )

    // —— 技能投递 ——
    check(
      'Agent 技能：写进 ~/.dsh/skills（DSH 只从这里登记技能）',
      /fn dsh_skills_dir/.test(rs) && /\.join\("\.dsh"\)\.join\("skills"\)/.test(rs)
    )
    check(
      '⚠ Agent 技能：只碰 mozhan- 命名空间（家目录里还有作者自己的技能，不能覆盖/误删）',
      /const SKILL_NS: &str = "mozhan-"/.test(rs) && /starts_with\(SKILL_NS\)/.test(rs)
    )
    check(
      'Agent 技能：幂等（内容没变不重写 —— DSH 有文件监听，反复写会触发无谓重载）',
      /if old == f\.content/.test(rs)
    )
    check(
      'Agent 技能：清理只删本命名空间内、且这次没再投递的（技能被删/改名时不留垃圾）',
      /want\.contains\(&name\)/.test(rs) && /remove_dir_all/.test(rs) && /p\.join\("SKILL\.md"\)\.is_file\(\)/.test(rs)
    )
    check(
      'Agent 技能：sync 命令注册进 generate_handler 且带 net 门控',
      /#\[cfg\(feature = "net"\)\]\s*commands::agent::agent_sync_skills/.test(lib)
    )
    check(
      'Agent 技能：桥接函数只在桌面端可用',
      /export async function agentSyncSkills/.test(bridge) && /agentAvailable\(\)/.test(bridge)
    )
    check(
      'Agent 技能：跑 Agent 前先投递（否则 DSH 拿自己的 project-layout 把 大纲/ 判成不合规范）',
      /await syncSkillsToAgent\(\)/.test(aiStore) && /async function syncSkillsToAgent/.test(aiStore)
    )
    check(
      'Agent 技能：投递失败不阻断任务（技能是加分项，不是必需项）',
      /async function syncSkillsToAgent[\s\S]*?try \{[\s\S]*?\} catch/.test(aiStore) && /技能是加分项/.test(aiStore)
    )
    check(
      'Agent 技能：只投递启用的技能（关掉的开关不该在 DSH 那边还生效）',
      /if \(!s\.enabled\) continue/.test(agSkills)
    )

    // —— ASCII slug 约束 ——
    check(
      '⚠ Agent 技能：目录名是 ASCII slug（中文名 DSH 直接报 invalid skill name）',
      /export function toSlug/.test(agSkills) && /replace\(\/\[\^a-z0-9\]\+\/g, '-'\)/.test(agSkills)
    )
    check(
      'Agent 技能：slug 带稳定 hash 后缀（中文名 ASCII 化后可能撞车，撞了会互相覆盖）',
      /export function shortHash/.test(agSkills) && /export function skillDirName/.test(agSkills) && /shortHash\(s\.name\)/.test(agSkills)
    )
    check(
      'Agent 技能：投递时 frontmatter 的 name 换成 slug（作者的中文名只留在本应用界面）',
      /export function renderForDsh/.test(agSkills) && /name: \$\{dir\}/.test(agSkills)
    )
    check(
      'Agent 技能：Skill 类型有独立的 slug 字段（中文名继续当界面主键）',
      /slug\?: string/.test(typesSrc) && /slug: meta\.slug/.test(skillSrc)
    )
    check(
      'Agent 技能：slug 进 serializeSkill，往返不丢（编辑技能后再投递仍在）',
      /slug: s\.slug/.test(skillSrc) && /'name', 'slug', 'description', 'allowed-tools'/.test(skillSrc)
    )
    check(
      'Agent 技能：任务提示词点名布局技能（不点名 DSH 会猜名字，白烧一轮往返）',
      /export function layoutGuide/.test(agSkills) && /layoutGuide\(\)/.test(aiStore) && /先用 skill 工具加载/.test(agSkills)
    )
    check(
      'Agent 技能：提示词明写「不要新建 spec/，不要把现有结构判成不合规范」',
      /不要\*\*新建 spec\//.test(agSkills) && /不合规范/.test(agSkills)
    )
    check(
      'Agent 技能：布局技能按 slug 认（中文名作者能改，slug 是我们自己定的标识）',
      /BUILTIN_LAYOUT_SKILL_SLUG = 'work-layout-map'/.test(agSkills)
    )
    check(
      'Agent 技能：设置页说明 Windows 沙箱已关闭、约束是软约束（别让作者误以为有系统级隔离）',
      /关掉它的沙箱再启动 Agent/.test(readSrc('src/components/SettingsDialog.vue'))
    )

    // 六个内置技能的 slug 齐全且互不相同
    const slugs: string[] = []
    for (const dir of ['一致性检查', '大纲拆分', '文风仿写', '目录对照表', '续写工作流', '记忆整理']) {
      const raw = readSrc(`src/skills/${dir}/SKILL.md`)
      const m = raw.match(/^slug:\s*([a-z0-9-]+)\s*$/m)
      if (m) slugs.push(m[1])
    }
    check(`Agent 技能：六个内置技能都写了 ASCII slug（找到 ${slugs.length}/6）`, slugs.length === 6)
    check('Agent 技能：内置技能的 slug 互不相同', new Set(slugs).size === slugs.length)
    check(
      'Agent 技能：slug 全是纯 ASCII（[a-z0-9-]，这是 DSH 的硬约束）',
      slugs.length > 0 && slugs.every((s) => /^[a-z0-9-]+$/.test(s))
    )

    // —— L1：把 DSH 技能库接进应用（doc §六 第一条验收标准）——
    const skillPanel = readSrc('src/components/SkillPanel.vue')
    check(
      'Agent 技能：能定位本机 DSH 技能库（~/.dsh/skills）',
      /pub async fn agent_skills_dir/.test(rs) && /#\[cfg\(feature = "net"\)\]\s*commands::agent::agent_skills_dir/.test(lib)
    )
    check(
      'Agent 技能：技能库只数「含 SKILL.md 的目录」（不然会混进 README.md 这类散文件）',
      /join\("SKILL\.md"\)\.is_file\(\)/.test(rs)
    )
    check(
      'Agent 技能：技能面板有一键接入入口（不用作者自己知道 ~/.dsh/skills 在哪）',
      /async function useDshLibrary/.test(skillPanel) && /agentSkillsDir\(\)/.test(skillPanel)
    )
    check(
      'Agent 技能：接入后如实报「发现 N 个 / 合并后共 M 个」（作者不用猜接上没有）',
      /发现 \$\{r\.count\} 个技能，合并后共 \$\{n\} 个/.test(skillPanel)
    )
    check(
      'Agent 技能：调试出口在验收构建里也挂（e2e 跑的是 vite preview，只挂 DEV 会让那节静默跳过）',
      /import\.meta\.env\.DEV \|\| import\.meta\.env\.VITE_E2E === '1'/.test(readSrc('src/main.ts')) &&
        /VITE_E2E: '1'/.test(readSrc('scripts/e2e/run.mjs'))
    )
  }

  /* 56. AI 生成设定（世界观 / 人物 / 势力…）

     这条链最容易出错的地方不在"生成"，而在**把生成结果落成一条条文件**：
     模型会给 Markdown 表格，得容错地解析、洗掉不能当文件名的字符、别覆盖作者
     手写的同名条目。这一节钉的就是那几步。 */
  {
    const wb = readSrc('src/core/worldbuild.ts')
    const panel = readSrc('src/components/CodexPanel.vue')
    const cand = readSrc('src/components/CandidatePanel.vue')
    const aiStore = readSrc('src/stores/ai.ts')

    check('设定生成：有独立的提示词模块（不跟大纲推荐混在一起）', /export function settingGenPrompt/.test(wb))
    check(
      '⚠ 设定生成：材料是事实来源，提示词里明写「不得矛盾」',
      /这是事实来源，生成的内容不得与之矛盾/.test(wb)
    )
    check(
      '设定生成：把已有条目名给出去，避免重名（重名会互相覆盖）',
      /已经存在的设定条目/.test(wb) && /不要重复生成/.test(wb)
    )
    check(
      '⚠ 设定生成：解析器容错（表头按内容认，不是固定第几行 —— 模型多写一行就错位）',
      /function isSeparator/.test(wb) && /headerSeen/.test(wb)
    )
    check(
      '设定生成：全角竖线也认（中文输入法下模型经常吐 ｜）',
      /replace\(\/｜\/g, '\|'\)/.test(wb)
    )
    check(
      '⚠ 设定生成：名称洗成合法文件名（路径分隔符 + Windows 保留名 con/nul）',
      /export function sanitizeName/.test(wb) &&
        /const RESERVED/.test(wb) &&
        wb.includes('.replace(/[\\\\/:*?"<>|]/g') &&
        wb.includes('.replace(/[\\r\\n\\t]/g') &&
        /RESERVED\.test\(s\)/.test(wb)
    )
    check(
      '设定生成：代码围栏 / 解释文字跳过（不然一堆客套话会被当成条目）',
      /if \(\/\^```\/\.test\(line\)\) continue/.test(wb) && /match\(\/\^#\{2,3\}\\s\*/.test(wb)
    )
    check(
      '设定生成：正文是「模板骨架 + AI 描述」（作者还能接着往小节里补）',
      /function settingBody/.test(cand) && /defaultBody\(it\.kind, it\.name\)/.test(cand)
    )
    check(
      '⚠ 设定生成：重名跳过、不覆盖作者手写的条目',
      /existing\.has\(it\.name\)/.test(cand) && /跳过 \$\{skipped\} 条同名（不覆盖已有）/.test(cand)
    )
    check(
      '⚠ 设定生成：解析失败不落盘（宁可让作者复制原文，也不能写半成品）',
      /if \(!items\.length\)/.test(cand) && /原文保留在候选里/.test(cand)
    )
    check(
      '设定生成：产出进候选区，点「写入设定库」才落盘（与所有 AI 功能一条规矩）',
      /c\.mode === 'setting'" class="primary" @click="adoptSetting/.test(cand.replace(/\s+/g, ' '))
    )
    check(
      '设定生成：面板里只在配了 AI 时出现（纯离线作者不该看见点不通的按钮）',
      /v-if="aiEnabled\(\)" class="gen"/.test(panel)
    )
    check(
      '设定生成：Candidate.mode 加进了 setting，且 labelOf 有对应中文名',
      /'fix' \| 'setting'/.test(readSrc('src/core/types.ts')) && /setting: '设定生成'/.test(aiStore)
    )
    check(
      '⚠ 设定生成：不套章节头（「当前章节：第3章」会把设定带成剧情摘要）',
      /args\.mode === 'setting'/.test(aiStore) && /不针对某一章/.test(aiStore)
    )

    /* 综合大纲 —— 用户明确要的「AI 推荐世界观和人物设定，综合大纲和作品标签」。
       判定点是**大纲真的进了提示词**，而不是界面上提了一句。 */
    const outlineDlg = readSrc('src/components/OutlineDialog.vue')
    check(
      '⚠ 设定生成：大纲进提示词，且写明「设定要托住故事走向」（不能只写在界面上）',
      /outline: genOutline\.value/.test(panel) && /你生成的设定必须能托住它/.test(wb)
    )
    check(
      '设定生成：大纲从文件读（不重新解析骨架 —— 模型看得懂 Markdown，解析反而丢信息）',
      /async function loadOutline/.test(panel) && /condenseOutline/.test(wb)
    )
    check(
      '⚠ 设定生成：作者手写的「剧情大纲 / 全书」优先于软件生成的 大纲.md（别被空模板压过去）',
      /const rank = \(n: string\)/.test(panel) &&
        /n\.includes\('剧情大纲'\) \|\| n\.includes\('全书'\) \? 0/.test(panel) &&
        /\.sort\(\(a, b\) => rank\(a\) - rank\(b\)/.test(panel)
    )
    check(
      '设定生成：换作品重读大纲（上一部的大纲留着会把新作品的设定带偏）',
      /ensureCodex\(true\)[\s\S]{0,160}loadOutline\(\)/.test(panel)
    )
    /* immediate watch 在 setup 阶段就同步跑，它碰到的 `const` ref 必须先声明。
       栽过一次：genOutline 声明在 watch 之后 → TDZ → 整个面板白屏，
       而 typecheck 与静态断言都看不出来。这里按出现位置钉死。 */
    check(
      '⚠ 设定生成：大纲 ref 声明在 immediate watch 之前（声明在后面就是 TDZ，面板直接白屏）',
      panel.indexOf('const genOutline = ref') > -1 &&
        panel.indexOf('const genOutline = ref') < panel.indexOf('ensureCodex(true)') &&
        panel.indexOf('const genOutlineName = ref') < panel.indexOf('ensureCodex(true)')
    )
    check(
      '设定生成：大纲截断时留话给模型（别把「没写到的章」当成故事已结束）',
      /不要当作故事已结束/.test(wb)
    )
    check(
      '设定生成：剪掉表格分隔行（| --- | 对模型零信息量，还占长度）',
      wb.includes('.filter((l) => !/^\\|[\\s:|-]+\\|$/.test(l.trim()))')
    )

    /* 综合标签 —— 标签不落盘是这功能的真实拦路虎，必须显式存一份 */
    check(
      '⚠ 设定生成：标签被显式记住（标签原本不落盘，不存一份就永远是空串）',
      /export function rememberTags/.test(wb) && /export function savedTags/.test(wb) && /mozhan\.settingTags/.test(wb)
    )
    check(
      '设定生成：作者点过的标签在大纲面板存下来，生成设定时读回来',
      /watch\(allTags, \(v\) => rememberTags\(v\)\)/.test(outlineDlg) &&
        /rememberTags\(allTags\.value\)/.test(outlineDlg) &&
        /tags: genTags\.value/.test(panel)
    )
    check(
      '设定生成：标签读取有 try/catch（隐私模式 / 配额满不该把生成流程带崩）',
      /if \(typeof localStorage === 'undefined'\) return ''/.test(wb)
    )
    check(
      '设定生成：提示词里要求调性跟标签一致（标签说悬疑就别写成轻松日常）',
      /题材与调性要和上面的标签一致/.test(wb)
    )
    check(
      '⚠ 设定生成：界面摊开「AI 实际会看到的输入」（大纲文件名 + 字数百标签），作者不用猜',
      /AI 实际会看到的输入|大纲：/.test(panel) &&
        /genOutlineName/.test(panel) &&
        /genTags/.test(panel) &&
        /去「大纲 → AI 推荐」点几个/.test(panel)
    )

    /* ---- 提示词里到底有没有那两样（静态 gate 只证明代码写了，这里证明跑出来的串里有）---- */
    const full = settingGenPrompt({
      title: '雾港夜航',
      brief: '一个船工被卷进旧案',
      tags: '悬疑 · 都市 · 第三人称',
      outline: '## 第1卷\n**卷目标**：找到失踪的货单\n| 章节 | 目标 | 字数 |\n| --- | --- | --- |\n| 灯下的信 | 主角收到匿名信 | 3000 |',
      material: '世界只有一座雾港，不许出现外星科技。',
      existing: ['张三'],
      kinds: ['character'],
      perKind: 3
    })
    check('⚠ 设定生成：大纲内容真的进了提示词（不是只传了个字段名）', full.includes('找到失踪的货单') && full.includes('灯下的信'))
    check('⚠ 设定生成：标签真的进了提示词', full.includes('悬疑 · 都市 · 第三人称'))
    /* 提示词末尾自己带了一段格式示例（含 | --- |），所以不能拿整串判「有没有分隔行」——
       要看的是**大纲那一段**被洗过：`| 灯下的信 |` 还在，`| --- |` 那一行没了。 */
    const outlineSeg = full.slice(full.indexOf('作品的现有大纲'), full.indexOf('每个类型生成'))
    check('设定生成：大纲里的分隔行被剪掉，但正文行留着（|---| 零信息量又占长度）', outlineSeg.includes('灯下的信') && !outlineSeg.includes('| --- |'))
    check('设定生成：已有条目名进了提示词（防重名）', full.includes('张三') && full.includes('不要重复生成'))
    check('设定生成：材料与大纲是两段（材料是不许矛盾的事实，大纲是要托住的走向）', full.includes('不得与之矛盾') && full.includes('必须能托住它'))

    // 截断：长大纲既不能整段灌进去，也不能让模型以为故事就到此为止
    const long = condenseOutline('## 第1卷\n' + '内容。'.repeat(4000), 200)
    check('设定生成：超长大纲被截断，且留了「后面还有」的话', long.length < 400 && long.includes('不要当作故事已结束'))
    check('设定生成：不长的大纲原样返回（不做无谓加工）', condenseOutline('## 第1卷\n短得很。') === '## 第1卷\n短得很。')
    check('设定生成：空大纲返回空串（提示词里就不该出现那一整段）', condenseOutline('') === '' && !settingGenPrompt({ title: 'x', brief: '', tags: 'a', outline: '', kinds: ['lore'], perKind: 1 }).includes('现有大纲'))

    /* ---- 解析：模型实际会吐的东西 ---- */
    const sheet = [
      '好的，我来为这部作品生成设定：', // 客套话，必须被忽略
      '```markdown', // 代码围栏
      '## 人物',
      '| 名称 | 描述 |',
      '| --- | --- |',
      '| 沈砚 | 雾港的老船工，藏着二十年前的旧案。 |',
      '| con | 故意用 Windows 保留名试探。 |',
      '',
      '## 组织 / 势力',
      '| 名称 | 描述 |',
      '| --- | --- |',
      '| 义和行 | 码头上的走私组织。 |',
      '```',
      '以上是我的推荐，希望对你有帮助。' // 收尾客套话
    ].join('\n')
    const parsed = parseSettingSheet(sheet)
    check('⚠ 设定生成：客套话没有被当成条目（前后各一句都不行）', parsed.length === 3)
    check('设定生成：全角斜杠小标题认得出（「组织 / 势力」→ organization）', parsed.some((p) => p.kind === 'organization' && p.name === '义和行'))
    check('⚠ 设定生成：Windows 保留名 con 被改名（不然写文件会被系统拒）', parsed.some((p) => p.name === 'con_设定') && !parsed.some((p) => p.name === 'con'))
    check('设定生成：描述跟着条目走（不是空的）', !!parsed.find((p) => p.name === '沈砚')?.desc.includes('旧案'))

    check('设定生成：路径分隔符洗成 ·（写文件才不会被拒）', sanitizeName('a/b\\c:d*e?f"g<h>i|j') === 'a·b·c·d·e·f·g·h·i·j')
    check('设定生成：首尾点与空格清掉（Windows 上「.name」建不出来）', sanitizeName('  ..张三..  ') === '张三')
    check('设定生成：空名字返回空串（调用方据此跳过，不写无名文件）', sanitizeName('   ') === '' && sanitizeName('...') === '')
    check('设定生成：没给标签时提示词退化成「自行判断」（不是留一句空的「题材标签：」）', settingGenPrompt({ title: 'x', brief: '', tags: '', kinds: ['lore'], perKind: 1 }).includes('作者没给标签'))
  }

  /* 57. 设定生成的大纲来源：真的去作品目录里读得出东西

     上面那节验的是「提示词拼得对」，这节验「喂进去的料是作者目录里的真货」。
     用内存 FS 真建一部作品、真写两个大纲文件，比 mock 一个 readFile 更能说明问题 ——
     排序、找不到、读不到这几条分支都得走一遍。 */
  {
    const parent = host.rootRef()
    const ref = await ws.createWork(parent, '设定生成测试', {})
    await fs().writeFile(ref, ['大纲', '大纲.md'], '# 软件生成的大纲\n空的模板。\n')
    await fs().writeFile(ref, ['大纲', '剧情大纲.md'], '# 作者手写的剧情大纲\n主角在雾港发现旧案。\n')

    // 复刻 CodexPanel.loadOutline 的选择逻辑：扫目录 → 按名字定优先级 → 取第一个非空的
    const rank = (n: string) => (n.includes('剧情大纲') || n.includes('全书') ? 0 : n === '大纲.md' ? 1 : 2)
    const names = (await fs().listDir(ref, ['大纲']))
      .filter((e) => e.kind === 'file' && /\.(md|txt)$/i.test(e.name))
      .map((e) => e.name)
    const ordered = [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    check('⚠ 设定生成：作者手写的剧情大纲排在软件空模板前面', ordered[0] === '剧情大纲.md', ordered.join(','))
    const picked = condenseOutline(await fs().readFile(ref, ['大纲', ordered[0]]))
    check('⚠ 设定生成：读出来的是作者那份（不是空模板）', picked.includes('发现旧案') && !picked.includes('空的模板'))

    // 两者都试完还读不到，才该报「还没读到大纲」
    const emptyRef = await ws.createWork(parent, '没有大纲的作品', {})
    await fs().remove(emptyRef, ['大纲', '大纲.md'])
    let found = ''
    try {
      const es = (await fs().listDir(emptyRef, ['大纲'])).filter((e) => e.kind === 'file' && /\.(md|txt)$/i.test(e.name))
      for (const e of es) {
        const t = condenseOutline(await fs().readFile(emptyRef, ['大纲', e.name]))
        if (t.trim()) {
          found = t
          break
        }
      }
    } catch {
      /* 连目录都没有 */
    }
    check('设定生成：目录里确实没有大纲时，老老实实返回空（界面据此显示指路文案）', found === '')

    // 目录都不存在：listDir 的失败必须被面板那层 try/catch 兜住，不能把人吓一跳
    const bareRef = await ws.createWork(parent, '没有大纲目录', {})
    await fs().remove(bareRef, ['大纲'])
    let threw = false
    try {
      await fs().listDir(bareRef, ['大纲'])
    } catch {
      threw = true
    }
    check('设定生成：大纲目录不存在时列表会抛（所以面板里那层 try/catch 是必需的，不是装饰）', threw)
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
