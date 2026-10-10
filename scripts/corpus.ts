/**
 * 规模语料生成器：给「规模压测」(`scalecheck.ts`) 和核心层自检 (`selfcheck.ts`) 共用。
 *
 * 生成的作品不是随机字符串堆，而是尽量贴近真实长篇：
 *  - 6 卷 × 50 章 / 每章约 3200 字（全书近百万字，一部完本网文的体量）
 *  - 人名 / 地名 / 物件 / 组织共 120 条设定，条目正文里互相 [[双链]]
 *  - 正文里会出现这些名字（共现关系、出场统计、角色失踪才有数据）
 *  - 故意掺进「一字之差」的手误（汀兰 → 汀蓝、青芷 → 青芒），喂给笔误检测
 *
 * 一切确定性（固定种子的 LCG），同一份参数每次生成的内容完全一样，
 * 所以压测数字之间可比、预算断言也不会忽高忽低。
 */
import fs from '@/platform'
import type { DirRef } from '@/platform'
import * as ws from '@/core/workspace'
import * as codex from '@/core/codex'
import { serializeDoc } from '@/core/frontmatter'
import type { SettingEntry } from '@/core/types'

/* ------------------------------------------------------------------ 伪随机 */

/** 确定性伪随机（LCG）。不要用 Math.random：压测要能两次跑出同一份稿子。 */
export function lcg(seed: number) {
  let s = (seed >>> 0) || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length]
}

/* ------------------------------------------------------------------ 词表 */

const SURNAME = ['苏', '陆', '白', '沈', '顾', '江', '谢', '裴', '温', '商', '燕', '秦', '程', '卫', '段', '韩']
const GIVEN = ['合', '笛', '青', '沉', '芷', '河', '舟', '木', '雪', '珩', '昀', '决', '砚', '笙', '翎', '蹊']

const LOC_A = ['长庚', '落雁', '望火', '沉钟', '白鹭', '断云', '青石', '芦花', '忘川', '孤山', '铁门', '冷泉', '拾星', '半坡', '白霜', '野渡']
const LOC_B = ['渡', '关', '台', '巷', '洲', '岭', '口', '荡', '驿', '祠']

const ITEM_A = ['玄铁', '半张', '鎏金', '断刃', '青囊', '残页', '铜雀', '霜色', '旧年', '无名']
const ITEM_B = ['令', '舆图', '匕首', '枪杆', '药囊', '残卷', '铜灯', '披风', '铜钱', '玉佩']

const ORG_A = ['北衙', '南司', '铁衣', '白鹿', '沧浪', '青芜', '定远', '拾遗']
const ORG_B = ['卫', '司', '营', '盟', '会', '阁']

const VERB = ['走向', '看着', '握住', '推开', '想起', '低声说', '抬起头', '停下脚步', '握紧', '收好', '笑了一下', '没有回头']
const TAIL = ['，没有说话。', '，指节发白。', '，风从门缝里钻进来。', '。', '，像是想起了什么。', '，喉咙里发紧。', '，远处的灯火晃了晃。', '，把话咽了回去。']

export interface Corpus {
  characters: string[]
  locations: string[]
  items: string[]
  orgs: string[]
  /** 正文里当主语用的名词 */
  subjects: string[]
  /** 正文里当宾语用的名词 */
  objects: string[]
}

function makeCombo(a: string[], b: string[], n: number, seed: number): string[] {
  const rnd = lcg(seed)
  const seen = new Set<string>()
  const out: string[] = []
  let guard = 0
  while (out.length < n && guard++ < n * 200) {
    const s = pick(rnd, a) + pick(rnd, b)
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

export function makeCorpus(charCount = 60, locCount = 30, itemCount = 20, orgCount = 10): Corpus {
  const rnd = lcg(20261008)
  // 前两个名字固定：它们是「手误」的对照物（正文里会写错成 汀蓝 / 青芒），
  // 自检里要靠它们确定性地验证笔误检测，所以不能听凭随机数决定在不在。
  const seen = new Set<string>(['汀兰', '青芷'])
  const characters: string[] = ['汀兰', '青芷']
  let guard = 0
  while (characters.length < charCount && guard++ < charCount * 500) {
    const n = pick(rnd, SURNAME) + pick(rnd, GIVEN)
    if (seen.has(n)) continue
    seen.add(n)
    characters.push(n)
  }
  const locations = makeCombo(LOC_A, LOC_B, locCount, 11)
  const items = makeCombo(ITEM_A, ITEM_B, itemCount, 22)
  const orgs = makeCombo(ORG_A, ORG_B, orgCount, 33)
  return {
    characters,
    locations,
    items,
    orgs,
    subjects: [...characters, '他', '她', '那人', '老者', '少年', '众人', '帐下的传令'],
    objects: [...locations, ...items, ...orgs.map((o) => `${o}的令牌`), '那扇木门', '手里的信', '碗里的热汤']
  }
}

/** 一章正文。目标字数到了就停，所以每章长度会有小出入（跟人写的一样） */
export function makeChapterBody(corpus: Corpus, seed: number, target: number): string {
  const rnd = lcg(seed)
  const para: string[] = []
  let len = 0
  while (len < target) {
    const lines: string[] = []
    const n = 4 + Math.floor(rnd() * 3)
    for (let i = 0; i < n; i++) {
      // 掺手误：只在正文里写错，设定库仍然是正确写法
      let s = pick(rnd, corpus.subjects)
      if (s === '汀兰' && rnd() < 0.25) s = '汀蓝'
      if (s === '青芷' && rnd() < 0.25) s = '青芒'
      const line = s + pick(rnd, VERB) + pick(rnd, corpus.objects) + pick(rnd, TAIL)
      lines.push(line)
      len += line.length
    }
    para.push(lines.join(''))
  }
  return para.join('\n\n') + '\n'
}

/* ------------------------------------------------------------------ 组装 */

export interface ScaleWorkOptions {
  /** 总章数 */
  chapters: number
  /** 卷数（章会平均分进各卷） */
  volumes?: number
  /** 每章目标字数 */
  charsPerChapter?: number
  /** 作品名 */
  name?: string
  /** 要不要连设定条目一起造（只要正文的话传 false） */
  withEntries?: boolean
}

export interface ScaleWorkResult {
  ref: DirRef
  corpus: Corpus
  entries: SettingEntry[]
  totalWords: number
}

/**
 * 在 parent 下造一部「规模作品」。
 * 注意：这里写盘走的是当前宿主，所以调用方要先 setAdapter（自检里就是内存宿主）。
 */
export async function buildScaleWork(parent: DirRef, opts: ScaleWorkOptions): Promise<ScaleWorkResult> {
  const chapters = Math.max(1, opts.chapters)
  const nVol = Math.max(1, opts.volumes ?? 1)
  const perChapter = opts.charsPerChapter ?? 3200
  const withEntries = opts.withEntries ?? true
  const name = opts.name ?? '规模测试书'
  const corpus = makeCorpus()
  const perVol = Math.ceil(chapters / nVol)

  const ref = await ws.createWork(parent, name, { title: name, author: '规模语料' })

  const entries: SettingEntry[] = []
  if (withEntries) {
    const specs: Array<[codex.SettingKind, string[]]> = [
      ['character', corpus.characters],
      ['location', corpus.locations],
      ['item', corpus.items],
      ['organization', corpus.orgs]
    ]
    const seen: string[] = []
    for (const [kind, names] of specs) {
      for (const n of names) {
        seen.push(n)
        const rnd = lcg(n.length * 7919 + kind.length)
        const linkTo = seen.length > 3 ? pick(rnd, seen.slice(0, -1)) : ''
        const body = `# ${n}\n\n类型：${codex.KIND_LABEL[kind]}\n\n${linkTo && linkTo !== n ? `关联：[[${linkTo}]]\n` : ''}`
        entries.push(await codex.createEntry(ref, kind, n, kind === 'character' ? { 别名: '' } : {}, body))
      }
    }
  }

  let order = 0
  let totalWords = 0
  for (let v = 1; v <= nVol; v++) {
    const vol = await ws.createVolume(ref, `第${String(v).padStart(2, '0')}卷 测试卷`, v)
    const count = v === nVol ? chapters - order : perVol
    for (let i = 0; i < count; i++) {
      order++
      const title = `${corpus.locations[order % corpus.locations.length]}之变`
      const body = makeChapterBody(corpus, order * 104729 + 7, perChapter)
      totalWords += body.length
      const file = ws.chapterFileName(order, title)
      await fs().writeFile(ref, [ws.DIRS.body, vol.dir, file], serializeDoc({ title, status: order % 9 === 0 ? '待修' : '草稿' }, body))
    }
  }

  return { ref, corpus, entries, totalWords }
}
