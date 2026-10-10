/**
 * 设定生成（AI 辅助）—— 世界观 / 人物 / 势力 / 地点 / 道具 / 种族
 *
 * # 与「大纲推荐」的分工
 *
 * `outline.ts` 的 `recommendPrompt` 生成的是**故事线**（卷 + 章纲）。
 * 这里生成的是**世界与人物**：读起来是「设定条目」，不是「这个故事怎么走」。
 * 两者可以互相喂：先有世界观能倒推出大纲，先有大纲也能反推需要哪些设定。
 *
 * # 为什么输出成 Markdown 表格而不是 JSON
 *
 * 应用要把它解析成一条条**设定条目文件**（`设定/人物设定/张三.md`），
 * 所以需要结构化。但让模型直接吐 JSON 有两个老问题：
 *  - 中文长文本里的引号 / 换行会让 JSON 破格（模型经常忘记转义）；
 *  - 破格了就只能整段丢弃，作者白等一次。
 * Markdown 表格对模型更稳，且**半截产出也仍然可读** —— 作者至少能看见
 * 「人物名 + 一段描述」这层信息，不至于一片空白。
 *
 * 格式刻意做得极简（`## 类型` + 两列表），解析器在 `parseSettingSheet` 里，
 * 容错优先：多一列少一列、表头大小写、全角竖线都认。
 */

/** 一次要生成哪几类设定。空数组 = 全都要。 */
export type SettingGenKind = 'character' | 'location' | 'organization' | 'item' | 'race' | 'lore'

/** 类型 → 中文小标题（模型按这个分组输出，解析器按它对回去） */
export const GEN_KIND_LABEL: Record<SettingGenKind, string> = {
  character: '人物',
  location: '地点',
  organization: '组织 / 势力',
  item: '道具',
  race: '种族 / 生物',
  lore: '世界观规则'
}

export interface SettingGenInput {
  /** 作品名 */
  title: string
  /** 一句话简介 */
  brief: string
  /** 题材标签（频道/题材/风格/篇幅）*/
  tags: string
  /** 作者的想法（散句，优先级高于标签） */
  idea?: string
  /** 作品大纲（`大纲/大纲.md` 等，可为空）。故事已经定了走向，设定要能托住它 */
  outline?: string
  /** 世界观 / 已有设定材料（事实来源，不得矛盾） */
  material?: string
  /** 已有设定条目的名字，避免重名 */
  existing?: string[]
  /** 要生成的类型 */
  kinds: SettingGenKind[]
  /** 每类生成几条 */
  perKind: number
}

const MATERIAL_LIMIT = 8000

/**
 * 设定生成提示词。
 *
 * 三条硬约束写死在这里：
 *  1. **不跟材料矛盾**（材料是事实来源）；
 *  2. **不重名**（已有的名字列表给出去）；
 *  3. **只输出规定格式**（不然一堆客套话会混进解析器）。
 */
export function settingGenPrompt(opt: SettingGenInput): string {
  const kinds = opt.kinds.length ? opt.kinds : (Object.keys(GEN_KIND_LABEL) as SettingGenKind[])
  const sections = kinds.map((k) => `## ${GEN_KIND_LABEL[k]}`).join('\n（每条之间空一行）\n')
  const material = (opt.material || '').trim()
  const outline = (opt.outline || '').trim()
  const idea = (opt.idea || '').trim()
  const existing = (opt.existing || []).filter(Boolean)

  return `你是中文网络长篇小说的设定编辑。请为下面这部作品生成**设定条目**（人物 / 地点 / 势力 / 道具 / 种族 / 世界观规则）。

作品：${opt.title || '（未命名）'}
简介：${opt.brief || '（无）'}
题材标签：${opt.tags || '（作者没给标签，按下面的想法与材料自行判断题材与调性）'}
${idea ? `作者的想法（**比标签更具体，优先级更高**；可以补全细节，但不要改掉其中的设定，也不要写他明确说过不要的东西）：\n"""\n${idea}\n"""\n` : ''}${outline ? `\n作品的现有大纲（**故事已经定了这些走向，你生成的设定必须能托住它**；大纲里点到的人、地、势力要优先补齐，别另起一套跟它对不上的世界）：\n"""\n${condenseOutline(outline)}\n"""\n` : ''}${material ? `\n世界观 / 已有设定材料（**这是事实来源，生成的内容不得与之矛盾**；材料没写的东西不要当成本作的既定设定）：\n"""\n${material.slice(0, MATERIAL_LIMIT)}\n"""\n` : ''}${existing.length ? `\n**已经存在的设定条目**（这些名字不要重复生成，可以在描述里引用它们）：\n${existing.slice(0, 200).join('、')}\n` : ''}
每个类型生成 ${opt.perKind} 条。要求：
- 名字要具体、有辨识度，别用「神秘组织」「某个地方」这类占位名。
- 描述一栏是**一段话**（40–120 字），写清它是什么、有什么特点、和谁有关系；不要写「待补充」。
- 人物要给出身份与立场的钩子，不要只写外貌；这个世界观要能支撑长篇，别写一戳就破的设定。
- 题材与调性要和上面的标签一致；标签说「悬疑」就别写成轻松日常。

输出格式（**严格遵守**，不要输出任何解释、前言、总结）：

${sections}

每个标题下用一张两列的 Markdown 表格，表头固定为 | 名称 | 描述 |：

## ${GEN_KIND_LABEL[kinds[0]]}

| 名称 | 描述 |
| --- | --- |
| 条目的名字 | 一段话描述 |`
}

/** 解析出来的单条设定 */
export interface ParsedSetting {
  kind: SettingGenKind
  name: string
  desc: string
}

/** 中文小标题 → 类型。容忍空格、全角斜杠、大小写。 */
function kindFromHeading(h: string): SettingGenKind | null {
  const s = h.replace(/[\s/／|｜]/g, '')
  const table: Array<[SettingGenKind, string[]]> = [
    ['character', ['人物', '角色', '人物设定']],
    ['location', ['地点', '地点设定', '场景']],
    ['organization', ['组织', '势力', '组织势力', '团体']],
    ['item', ['道具', '物品', '装备']],
    ['race', ['种族', '生物', '种族生物']],
    ['lore', ['世界观规则', '世界观', '规则', '设定']]
  ]
  for (const [kind, names] of table) {
    if (names.includes(s)) return kind
  }
  return null
}

/** 拆一行 Markdown 表格行成单元格。全角 `｜` 也认。支持 `\|` 转义。 */
function splitRow(line: string): string[] {
  const norm = line.replace(/｜/g, '|').trim()
  const inner = norm.replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') {
      cur += '|'
      i++
    } else if (inner[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += inner[i]
    }
  }
  cells.push(cur.trim())
  return cells
}

/** 是不是表头分隔行（`| --- | --- |`） */
function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

/**
 * 解析模型给出的设定表。
 *
 * 容错优先 —— 这是"半截产出也要能用"的落地：
 *  - 只认 `## 标题` 分组 + 两列表格，别的行（解释文字、代码围栏）直接跳过；
 *  - 表头行按内容识别（不是固定第几行），所以模型多写一行说明也不会错位；
 *  - 名称/描述都空的行丢掉；
 *  - 名称里带路径分隔符或 Windows 保留名的**改名**（应用侧写文件会被拒）。
 */
export function parseSettingSheet(text: string): ParsedSetting[] {
  const out: ParsedSetting[] = []
  const lines = String(text || '').split(/\r?\n/)
  let curKind: SettingGenKind | null = null
  let headerSeen = false

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // 代码围栏不参与
    if (/^```/.test(line)) continue

    // 分组标题
    const h = line.match(/^#{2,3}\s*(.+?)\s*$/)
    if (h) {
      curKind = kindFromHeading(h[1])
      headerSeen = false
      continue
    }
    if (!curKind) continue

    // 表格行
    if (line.startsWith('|') || line.includes('|')) {
      const cells = splitRow(line)
      if (cells.length < 2) continue
      if (isSeparator(cells)) {
        headerSeen = true
        continue
      }
      // 表头：第一格是「名称」
      if (!headerSeen && /^(名称|名字|name)$/i.test(cells[0])) {
        headerSeen = true
        continue
      }
      const name = sanitizeName(cells[0])
      const desc = (cells[1] || '').trim()
      if (!name) continue
      out.push({ kind: curKind, name, desc })
    }
  }
  return out
}

/* ------------------------------------------------------------------ 输入来源：大纲 / 标签
 *
 * 用户要的是「综合大纲和作品标签」—— 这两样都不能只靠作者手打。
 *
 * 标签的坑：**标签不落盘**。它是「大纲 → AI 推荐」那个页签里的临时选择，
 * 作者点完就没了；`作品信息.md` 里只有标题/作者/简介/目标字数。
 * 所以标签得专门存一份（`rememberTags` / `savedTags`），否则生成设定时
 * 永远拿不到 —— 那就成了「界面说要综合标签，实际传了个空串」。
 *
 * 大纲反而是**已经落盘**的：`大纲/大纲.md`（或作者自己的
 * `剧情大纲.md` / `全书*.md`）。直接把文件读出来交给模型，
 * 比再去解析一遍骨架可靠 —— 设定只需要「故事讲了什么」这层信息。
 */

const TAG_STORE_KEY = 'mozhan.settingTags'
/** 大纲喂给模型的长度上限：只要主线与卷目标，不必把 60 章章纲全塞进去 */
const OUTLINE_LIMIT = 6000

/** 记住作者在「大纲 → AI 推荐」里选过的标签，供生成设定时复用 */
export function rememberTags(tags: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const s = String(tags || '').trim()
    if (!s) return
    localStorage.setItem(TAG_STORE_KEY, s)
  } catch {
    /* 隐私模式 / 配额满：标签是锦上添花，读不到就算了，不能把生成流程带崩 */
  }
}

/** 取上次记住的标签（没有就空串） */
export function savedTags(): string {
  try {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(TAG_STORE_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * 把大纲文件压成「主线 + 卷目标 + 章纲骨架」。
 *
 * 不做花哨的解析：模型看得懂 Markdown。这里只做两件真正省 token 的事 ——
 * 砍掉表格的分隔行（`| --- | --- |` 对模型零信息量，而且很长），
 * 再把过长的章纲列表截断（设定生成不需要 60 章的细节）。
 */
export function condenseOutline(md: string, limit = OUTLINE_LIMIT): string {
  const lines = String(md || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => !/^\|[\s:|-]+\|$/.test(l.trim()))
  const text = lines.join('\n').trim()
  if (!text) return ''
  if (text.length <= limit) return text
  // 截断时留个话给模型：别把「没写到的章」当成「这本书就到这」
  return `${text.slice(0, limit)}\n……（大纲较长，此处截断；后面还有内容，不要当作故事已结束）`
}

/** Windows 保留名（写文件会被系统拒） */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 把模型给的名称洗成能当文件名的样子。
 * 只做**必要**的改动：替换非法字符、清掉首尾点与空格、避开保留名。
 */
export function sanitizeName(name: string): string {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
  if (!s) return ''
  if (RESERVED.test(s)) s = `${s}_设定`
  return s
}
