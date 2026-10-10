/**
 * 规模压测（P4-A）
 *
 * 目的只有一个：**在大作品下把真实数字量出来**，而不是凭感觉说「应该够快」。
 *
 * 做法：用内存宿主（memfs）生成一部真实体量的作品 —— 默认 6 卷 × 50 章 = 300 章、
 * 每章约 3200 字（全书近百万字，等价于一部完本网文），120 条设定条目，
 * 然后对作者会真正触发的每个重活逐个计时。语料生成器在 `scripts/corpus.ts`，
 * 与核心层自检共用同一份，避免「一个脚本一套数据」。
 *
 * 两点必须说清楚，否则数字会骗人：
 *  1. 内存宿主没有真实 IO（读文件≈查 Map），所以这里测的是**纯 CPU + 解析**的量级；
 *     真实 FSA 宿主还要再加磁盘/OPFS 的读时间。也就是说，这里已经算**下界**。
 *  2. 这是观察工具，**不做断言**。断言在 selfcheck 的「规模预算」一节，
 *     那里用「规模 ×4 → 耗时不得 ×10」的相对口径，换台机器也不会飘。
 *
 * 用法：
 *   npm run scale                      # 默认 300 章
 *   SCALE_CHAPTERS=600 npm run scale
 *   SCALE_SKIP_HEAVY=1 npm run scale   # 跳过 DOCX / zip 这类导出（很慢）
 */
import fs, { setAdapter } from '@/platform'
import * as ws from '@/core/workspace'
import * as codex from '@/core/codex'
import * as links from '@/core/links'
import * as graph from '@/core/graph'
import * as retrieve from '@/core/retrieve'
import * as consistency from '@/core/consistency'
import * as stats from '@/core/stats'
import * as timeline from '@/core/timeline'
import * as style from '@/core/style'
import { collectChapters, defaultExportOptions, toDocxBlob, toMarkdown, toText } from '@/core/exportDoc'
import { buildEpub } from '@/core/exportEpub'
import { buildBackup, humanSize, storageUsage } from '@/core/backup'
import { DEFAULT_MEMORY_FILES } from '@/core/workspace'
import type { Chapter, SettingEntry } from '@/core/types'
import { installMemoryFs } from './memfs'
import { buildScaleWork } from './corpus'

/* ------------------------------------------------------------------ 参数 */

const CHAPTERS = Number(process.env.SCALE_CHAPTERS || 300)
const VOLUMES = Number(process.env.SCALE_VOLUMES || 6)
const CHARS_PER_CHAPTER = Number(process.env.SCALE_CHARS || 3200)
const SKIP_HEAVY = !!process.env.SCALE_SKIP_HEAVY
const BOOK = '规模测试书'

/* ------------------------------------------------------------------ 计时 */

interface Row {
  label: string
  ms: number
  note: string
}

const rows: Row[] = []

async function timed<T>(label: string, note: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  const t0 = performance.now()
  try {
    const v = await fn()
    rows.push({ label, ms: performance.now() - t0, note })
    return v
  } catch (e: any) {
    rows.push({ label: label + '（抛错）', ms: performance.now() - t0, note: String(e?.message || e) })
    return undefined
  }
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  // 自检跑在无 localStorage 的 Node 里；这里给个最小壳，让 indexCache / stats 那条路也能走。
  if (!(globalThis as any).localStorage) {
    const mem = new Map<string, string>()
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear()
    }
  }

  const host = installMemoryFs()
  setAdapter(host.adapter)
  const root = host.rootRef()

  process.stdout.write(`正在生成：${VOLUMES} 卷 × ${Math.ceil(CHAPTERS / VOLUMES)} 章 × ~${CHARS_PER_CHAPTER} 字 + 120 条设定…\n`)
  const tGen = performance.now()
  const built = await buildScaleWork(root, {
    chapters: CHAPTERS,
    volumes: VOLUMES,
    charsPerChapter: CHARS_PER_CHAPTER,
    name: BOOK
  })
  const work = built.ref
  const genMs = performance.now() - tGen

  /* ---------------- 正式开始量 ---------------- */

  const scan = (await timed('scanWork（索引全书）', `${CHAPTERS} 章`, () => ws.scanWork(work)))!
  const chapters: Chapter[] = [...scan.rootChapters, ...scan.volumes.flatMap((x) => x.chapters)]
  const totalWords = scan.totalWords

  const bodies: Record<string, string> = {}
  await timed('读完所有正文（ensureBodies 等价）', `${CHAPTERS} 章`, async () => {
    for (const c of chapters) bodies[c.id] = await ws.readChapterBody(work, c.id)
  })

  const entries = (await timed('listEntries（设定库解析）', `${built.entries.length} 条`, () => codex.listEntries(work))) as SettingEntry[]
  const names = entries.flatMap((e) => [e.name, ...e.aliases]).filter(Boolean)

  await timed('buildRefIndex（条目出场索引）', `${names.length} 个名字 × ${CHAPTERS} 章`, () => links.buildRefIndex(chapters, bodies, names))
  await timed('presenceStats（全书出场统计）', `${entries.length} 条 × ${CHAPTERS} 章`, () => links.presenceStats(entries, chapters, bodies))

  const gFull = await timed('buildGraph（含章节节点，最重）', `${entries.length} 条目 + ${CHAPTERS} 章`, () =>
    graph.buildGraph(entries, chapters, bodies, { includeChapters: true, maxEdges: 1200 })
  )
  await timed('buildGraph（默认：不含章节节点）', `${entries.length} 条目 + ${CHAPTERS} 章`, () =>
    graph.buildGraph(entries, chapters, bodies, { maxEdges: 1200 })
  )
  if (gFull) {
    rows.push({
      label: '  ↳ 图规模',
      ms: 0,
      note: `${gFull.nodes.length} 节点 / ${gFull.edges.length} 关系（画布上限内画 ${gFull.drawnEdges.length} 条）`
    })
  }
  const gAll = graph.buildGraph(entries, chapters, bodies, {})
  await timed('layout（力导向布局，不设画布上限）', `${gAll.nodes.length} 节点 / ${gAll.edges.length} 边`, () => graph.layout(gAll.nodes, gAll.edges))

  await timed('buildTimeline（时间线）', `${entries.length} 条 × ${CHAPTERS} 章`, () => timeline.buildTimeline(entries, chapters, bodies))

  const passages = (await timed('splitPassages（语义检索切段）', `${CHAPTERS} 章`, () => retrieve.splitPassages(chapters, bodies)))!
  const index = (await timed('buildIndex（bigram TF-IDF 建索引）', `${passages.length} 段`, () => retrieve.buildIndex(passages)))!
  await timed('search ×20（语义召回）', `索引 ${passages.length} 段`, () => {
    for (let i = 0; i < 20; i++) retrieve.search(index, '汀兰走向那扇木门', 8)
  })

  await timed('analyzeStyle（全书文风）', `${totalWords} 字`, () => style.analyzeStyle(chapters.map((c) => bodies[c.id] || '').join('\n\n')))

  // 最重的一条：CheckPanel 点「开始检查」时会走
  await timed('checkAll（一致性对账）', `${entries.length} 条 × ${CHAPTERS} 章`, () =>
    consistency.checkAll({
      entries,
      chapters,
      bodies,
      foreshadowRaw: DEFAULT_MEMORY_FILES['伏笔台账.md'],
      currentId: chapters[0]?.id || '',
      missingAfter: 8
    })
  )

  const daily = Array.from({ length: 120 }, (_, i) => {
    const d = new Date(2026, 5, 1 + i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { date: key, words: i % 3 === 0 ? 0 : 2000 + (i * 137) % 4000 }
  })
  await timed('summarize（统计报表）', `${chapters.length} 章`, () => stats.summarize(scan.volumes, scan.rootChapters, daily, 1_000_000))

  /* ---------------- 导出 ---------------- */

  const opt = { ...defaultExportOptions(), format: 'docx' as const }
  const items = collectChapters(scan.volumes, scan.rootChapters, bodies, opt)
  await timed('toText（TXT 拼接）', `${items.length} 章`, () => toText(items, opt))
  await timed('toMarkdown（Markdown 拼接）', `${items.length} 章`, () => toMarkdown(items, opt, BOOK))
  await timed('buildEpub（EPUB 打包）', `${items.length} 章`, () => buildEpub(items, { title: BOOK, author: '规模语料' }))

  if (!SKIP_HEAVY) {
    await timed('toDocxBlob（DOCX 生成）', `${totalWords} 字`, () => toDocxBlob(BOOK, '规模语料', items, opt))
    await timed('buildBackup（整库 zip）', `${CHAPTERS} 章`, () => buildBackup(work, { title: BOOK }))
  }

  const usage = await timed('storageUsage（占用统计）', `${CHAPTERS} 章`, () => storageUsage(work))
  if (usage) rows.push({ label: '  ↳ 磁盘占用', ms: 0, note: `${usage.totalFiles} 文件 / ${humanSize(usage.totalBytes)}` })

  /* ---------------- 报告 ---------------- */

  console.log('\n' + '='.repeat(72))
  console.log(`规模：${VOLUMES} 卷 / ${CHAPTERS} 章 / ${totalWords} 字（内存宿主，不含真实 IO）`)
  console.log(`生成用时：${fmt(genMs)}（不计入下面的数字）`)
  console.log('='.repeat(72))
  const width = Math.max(...rows.map((r) => r.label.length))
  rows.sort((a, b) => b.ms - a.ms)
  for (const r of rows) {
    const flag = r.ms >= 2000 ? ' ⚠' : r.ms >= 500 ? ' ·' : ''
    console.log(`${r.label.padEnd(width)}  ${fmt(r.ms).padStart(9)}  ${r.note}${flag}`)
  }
  console.log('='.repeat(72))
  console.log('标记：· ≥500ms　⚠ ≥2s（作者会明显感到卡顿）')
  console.log('注意：内存宿主读文件≈查 Map。真实浏览器里还要再加磁盘/OPFS 的读时间，所以这已是下界。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
