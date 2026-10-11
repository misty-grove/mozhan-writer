/**
 * 技能分类（大纲 / 设定 / 文本生成 / 记忆 / 文风）
 *
 * # 为什么默认分类是关键词启发式而不是让 AI 先分一轮
 *
 * 技能列表里躺着的是「名字 + 一句 description」，这层信息**人眼都够分**——
 * 「记忆整理」总不会是文风技能。所以默认分类用纯函数零依赖就能做完：
 * 不联网、不花钱、selfcheck 直接可断言。AI 整理（技能面板的指令框）只在
 * 作者想**批量重排或清掉无关技能**时才出手，而且它的结果要人工确认后才应用。
 *
 * # 优先级
 *
 * 作者手动移动（settings.skillCats）> SKILL.md frontmatter 的 `category`
 * > 关键词启发式 > `other`。前两层是「作者与技能作者的明确意志」，
 * 启发式只负责兜底 —— 三层叠起来，谁也没法把作者亲手定的分类悄悄改掉。
 */

/** 五个业务分类 + other（兜底：工具类、元技能、看不懂的都落这里） */
export type SkillCat = 'outline' | 'setting' | 'gen' | 'memory' | 'style' | 'other'

export const SKILL_CAT_LABEL: Record<SkillCat, string> = {
  outline: '大纲',
  setting: '设定',
  gen: '文本生成',
  memory: '记忆',
  style: '文风',
  other: '其他'
}

/** 面板页签的固定顺序（other 永远在最后） */
export const SKILL_CAT_ORDER: SkillCat[] = ['outline', 'setting', 'gen', 'memory', 'style', 'other']

/** AI 整理方案里允许出现的「分类值」——中英文都认，省得模型输出格式对不上就整批作废 */
const ALIAS: Record<string, SkillCat> = {
  大纲: 'outline',
  outline: 'outline',
  设定: 'setting',
  人物: 'setting',
  世界观: 'setting',
  setting: 'setting',
  文本生成: 'gen',
  生成: 'gen',
  正文: 'gen',
  续写: 'gen',
  gen: 'gen',
  text: 'gen',
  writing: 'gen',
  记忆: 'memory',
  memory: 'memory',
  文风: 'style',
  style: 'style',
  其他: 'other',
  other: 'other',
  misc: 'other'
}

/** 把 AI / frontmatter 里给的分类值洗成合法的 SkillCat；认不出返回 null（调用方决定兜到哪） */
export function normalizeCat(v: unknown): SkillCat | null {
  const s = String(v || '')
    .trim()
    .toLowerCase()
  if (!s) return null
  return ALIAS[s] || null
}

/**
 * 关键词启发式。
 *
 * 关键词按「越具体越先判」排列：先问是不是记忆/文风/大纲/设定这类**窄**类别，
 * 最后才落到「生成/写作」这个宽口径 —— 否则「续写工作流」会被「写作」一口吞掉，
 * 永远到不了该去的 gen；反过来「文风仿写」必须抢在「写」之前认领。
 * 中英文都收（DSH 技能库里的技能名常是英文：continuation、style-imitation）。
 */
const RULES: Array<[SkillCat, string[]]> = [
  ['memory', ['记忆', '摘要', '伏笔', '状态表', '时间线', 'memory', 'summary', 'recap', 'timeline']],
  ['style', ['文风', '语气', '仿写', '笔触', '风格', 'style', 'tone', 'voice']],
  ['outline', ['大纲', '章纲', '分卷', '梗概', '结构', 'outline', 'plot', 'structure']],
  ['setting', ['设定', '人物', '世界观', '势力', '角色', '世界观规则', 'character', 'worldbuild', 'codex']],
  ['gen', ['续写', '正文', '扩写', '缩写', '纠错', '校对', '生成', '写作', '对账', '一致性', '矛盾', 'continuation', 'write', 'draft', 'check', 'consistency']]
]

/** 分类一条技能。`category` 是 frontmatter 里技能作者亲手写的（如有）。 */
export function classifySkill(s: { name: string; description?: string; category?: unknown }): SkillCat {
  const explicit = normalizeCat(s.category)
  if (explicit) return explicit
  const text = `${s.name || ''}\n${s.description || ''}`.toLowerCase()
  for (const [cat, words] of RULES) {
    if (words.some((w) => text.includes(w))) return cat
  }
  return 'other'
}

/* ------------------------------------------------------------------ AI 整理：提示词与方案解析 */

/**
 * 技能整理的提示词。
 *
 * 把**全部技能**（名字 + 当前分类 + 描述）都给模型 —— 「让 AI 自己去找」在
 * 这个场景里的含义是：候选集已经在提示词里了，模型按作者的指令挑出该动的那些。
 * 输出严格 JSON：解析器在 `parseOrganizePlan`，容错但不猜。
 */
export function organizePrompt(
  skills: Array<{ name: string; description?: string; category?: SkillCat }>,
  instruction: string
): string {
  const list = skills.map((s) => `- ${s.name}（当前：${SKILL_CAT_LABEL[s.category || 'other']}）${s.description ? `：${s.description}` : ''}`).join('\n')
  return `你是写作应用里的技能管理员。下面是这个应用当前拥有的全部技能。

${list}

作者的指令：${instruction.trim() || '把与小说写作无关的技能标记删除，其余按用途归类。'}

请输出一个 JSON 数组，**只列需要改动的技能**（分类已经对的、作者没提到的不要列），每个元素：
{"name":"技能名（必须与上面完全一致）","category":"大纲|设定|文本生成|记忆|文风|其他|删除","reason":"一句话理由"}

规则：
- category 只能取上面这七个值之一；想让某个技能从列表里消失就写「删除」。
- 不要输出 JSON 之外的任何文字（不要解释、不要代码围栏外的说明）。
- 技能名必须逐字照抄上面的列表，编造的名字会被丢弃。`
}

/** AI 整理方案里的一条：挪到哪个分类（'delete' = 建议删除） */
export interface OrganizeItem {
  name: string
  cat: SkillCat | 'delete'
  reason: string
}

/**
 * 解析 AI 给的整理方案。容错点：
 *  - 剥代码围栏（```json … ```）；
 *  - 取第一个 `[` 到最后一个 `]` 之间的一段（模型爱在前后加客套话）；
 *  - JSON.parse 失败按行兜底：尝试从 `{"name":…}` 形态的行里抠；
 *  - **名字不在已知列表里的一律丢弃**（防编造 —— 生成一个不存在的技能名，
 *    应用侧会拿着它去删一个不存在的目录，静默失败还让人以为删成了）。
 */
export function parseOrganizePlan(text: string, knownNames: string[]): OrganizeItem[] {
  const raw = String(text || '')
  let body = raw.replace(/```(?:json)?/gi, '')
  const a = body.indexOf('[')
  const b = body.lastIndexOf(']')
  const known = new Set(knownNames)
  const out: OrganizeItem[] = []
  const push = (name: unknown, cat: unknown, reason: unknown) => {
    const n = String(name || '').trim()
    if (!n || !known.has(n)) return
    if (out.some((o) => o.name === n)) return
    const c = String(cat || '').trim()
    if (/^删除|delete$/i.test(c)) {
      out.push({ name: n, cat: 'delete', reason: String(reason || '').trim() })
      return
    }
    const k = normalizeCat(c)
    if (!k) return
    out.push({ name: n, cat: k, reason: String(reason || '').trim() })
  }
  if (a >= 0 && b > a) {
    body = body.slice(a, b + 1)
    try {
      const arr = JSON.parse(body)
      if (Array.isArray(arr)) {
        for (const it of arr) {
          if (it && typeof it === 'object') push((it as any).name, (it as any).category, (it as any).reason)
        }
        return out
      }
    } catch {
      /* 掉到按行兜底 */
    }
  }
  // 按行兜底：模型有时会忘了外层数组括号，但每行还是合法的 JSON 对象
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/\{[^{}]*\}/)
    if (!m) continue
    try {
      const it = JSON.parse(m[0])
      push(it.name, it.category, it.reason)
    } catch {
      /* 这行不是 JSON，跳过 */
    }
  }
  return out
}
