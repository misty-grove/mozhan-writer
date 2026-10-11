/**
 * 技能名的中文显示（纯函数 + 本机 settings 存译名）
 *
 * 为什么要这一层：
 * 技能库（尤其是 DSH 那 50 来个）里绝大多数技能名和 description 是英文的
 * —— `continuation`、`long-memory`、`style-imitation`……作者看着一堆英文，
 * 既不知道它能干什么，也不知道该不该启用。全靠作者自己猜，等于没这套技能。
 *
 * 三条边界（都是踩过的坑的形状）：
 * 1. **本来就写着中文的不翻**。技能名带汉字就原样显示 —— 翻它既浪费钱，
 *    还可能把作者自己起的名字改坏（「目录对照表」被译成「目录映射」这种）。
 * 2. **译名只是显示层**。写进 `settings.skillZh`，一个 SKILL.md 都不动 ——
 *    全局技能库是 DSH 自己的目录（`~/.dsh/skills`），应用没权利替作者改。
 * 3. **AI 出的译名必须人工确认**。翻译错了最多是名字怪，但**编造**的技能名
 *    （把名单里没有的技能也翻一遍）会让作者以为自己装了某个技能。
 *    所以解析时只认名单里有的名字，其余一律丢掉。
 */
import { settings } from './settings'

export interface SkillZh {
  /** 技能名的中文译名 */
  zh?: string
  /** description 的中文译述 */
  desc?: string
}

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/

/** 文本里已经有中日韩汉字 —— 不用翻 */
export function hasCJK(s: string): boolean {
  return !!s && CJK.test(s)
}

/**
 * 这条技能需要中文译名吗。
 *
 * 判据是「有拉丁字母且没有汉字」：纯英文要翻，`read_chapter` 这种工具名
 * 也算要翻（它会出现在 allowed-tools 里，但技能名本身一般不长这样）。
 */
export function needsZh(s: string): boolean {
  if (!s) return false
  return !hasCJK(s) && /[A-Za-z]/.test(s)
}

/**
 * 没译名时也让英文好读一点：`long-memory` → `long memory`。
 *
 * 这不是翻译（不编造任何含义），只是把连字符换成空格 ——
 * 作者至少能把它当一个词读出来，而不是当成一段代码。
 */
export function humanizeName(name: string): string {
  return name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 已存的译名（没有就空串，调用方自己决定显示原名还是 humanize） */
export function zhOf(name: string): string {
  return settings.skillZh?.[name]?.zh || ''
}

/** 已存的中文译述 */
export function descZhOf(name: string): string {
  return settings.skillZh?.[name]?.desc || ''
}

/** 界面上该显示的名字：有译名用译名，没有就把英文读顺一点（不编造） */
export function displayName(name: string): string {
  return zhOf(name) || (needsZh(name) ? humanizeName(name) : name)
}

/** 界面上该显示的说明：有译述用译述，没有就用原文 */
export function displayDesc(name: string, desc: string): string {
  return descZhOf(name) || desc
}

/** 这条技能已经翻过了吗（界面上用来决定「译」标记） */
export function translated(name: string): boolean {
  return !!settings.skillZh?.[name]?.zh
}

/** 写入译名（整体替换：AI 一次给一批，作者勾几条写几条） */
export function setSkillZh(pairs: Array<{ name: string; zh?: string; desc?: string }>) {
  const map: Record<string, SkillZh> = { ...(settings.skillZh || {}) }
  for (const p of pairs) {
    if (!p?.name) continue
    const next: SkillZh = {}
    if (p.zh) next.zh = p.zh
    if (p.desc) next.desc = p.desc
    map[p.name] = next
  }
  settings.skillZh = map
}

/** 撤掉一条译名（作者觉得译得不对时，回退到英文原名） */
export function clearSkillZh(name: string) {
  if (!settings.skillZh?.[name]) return
  const map = { ...settings.skillZh }
  delete map[name]
  settings.skillZh = map
}

/* ------------------------------------------------------------------ 让 AI 翻 */

/** 一条待翻技能在 AI 眼里的样子：名字 + slug + 说明（说明常常比名字更关键） */
export interface ZhItem {
  name: string
  slug?: string
  description?: string
}

/**
 * 翻译提示词。
 *
 * 「符合原意、简单明了」是作者的原话，落到提示词里就是三条硬要求：
 *  - 译名 **2–8 个汉字**，不写解释、不加「技能」二字（列表里本来就都是技能）；
 *  - **按它实际干什么翻**，不要逐词直译（`continuation` 不是「继续」而是「断点续写」）；
 *  - 译述 **一句话说清什么时候用它**，不要复述原文、不要加功能（模型最爱干的就是顺手扩写功能）。
 */
export function skillZhPrompt(items: ZhItem[], instruction = ''): string {
  const list = items
    .map((s) => `- ${s.name}${s.slug ? ` (${s.slug})` : ''}：${(s.description || '（无说明）').replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n')
  return [
    '下面是写作软件里的一批技能（提示词包）的英文名与说明。请把它们的名字和说明翻译成简体中文。',
    '',
    '要求：',
    '1. 译名 2–8 个汉字，简单明了，按它实际干什么翻，不要逐词直译（例如 continuation 译「断点续写」，不要译「继续」）。',
    '2. 译名后面不要加「技能」二字，不要加引号，不要加解释。',
    '3. 译述一句话（30 字内）说清「什么时候用它」，不要复述英文原文，不要添加原文没有的功能。',
    '4. 专有名词（工具名、命令名、英文缩写）保留原文。',
    '5. 名单里没有的技能不要自己加。',
    '',
    instruction ? `作者的补充要求：${instruction}` : '',
    '',
    '输出格式：每行一条，用竖线分隔三列，不要表头、不要代码围栏、不要序号、不要多余的话。',
    '原名|译名|译述',
    '',
    '待翻译的技能：',
    list
  ]
    .filter((x) => x !== undefined && x !== '')
    .join('\n')
}

export interface ParsedZh {
  name: string
  zh: string
  desc?: string
}

/**
 * 解析 AI 给的译名表。
 *
 * 容错优先（跟 worldbuild 那套一个道理）：
 *  - 全角 `｜` 与半角 `|` 都认；
 *  - 跳掉代码围栏、表头、分隔行（`---|---`）、空行；
 *  - **只保留名单里的名字** —— 模型编一个名单外技能出来，最坏情况是
 *    作者以为自己装了某个技能，所以这里直接丢掉；
 *  - 译名为空的行跳过（那一列没翻出来就不写，留着英文原名比写个空名强）。
 */
export function parseSkillZh(text: string, allowed: string[]): ParsedZh[] {
  const set = new Set(allowed)
  const out: ParsedZh[] = []
  const seen = new Set<string>()
  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // 代码围栏的标记行直接跳过，但**围栏里面的内容照读** ——
    // 模型最爱干的一件事就是把整份结果裹在 ``` 里，连围栏一起跳过等于什么都拿不到。
    // 围栏里万一有别的文本也不怕：没有竖线的行本来就会被下面几步丢掉。
    if (/^(```|~~~)/.test(line)) continue
    if (/^\s*[-:]?\s*-{2,}/.test(line)) continue // --- 分隔行
    const parts = line
      .replace(/^\s*[-*•]\s*/, '')
      .split(/\s*[|｜]\s*/)
      .map((s) => s.trim())
    if (parts.length < 2) continue
    const [name, zh, desc] = parts
    if (!name || !zh) continue
    if (name === '原名' || zh === '译名') continue // 表头
    if (!set.has(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, zh, desc: desc || undefined })
  }
  return out
}

/** 只翻「需要翻」的那批：已经是中文的技能不送去翻（省钱，也不会把中文名改坏） */
export function pickNeedZh(items: ZhItem[]): ZhItem[] {
  return items.filter((s) => needsZh(s.name) || (!hasCJK(s.description || '') && /[A-Za-z]/.test(s.description || '')))
}
