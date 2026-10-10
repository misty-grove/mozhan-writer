/**
 * 把「本应用认识的技能」投递给外部 Agent（DSH）。
 *
 * # 为什么需要这个模块
 *
 * 本应用的技能是**提示词 + 流程**（`core/skills.ts`），本来只喂给自己的 API 引擎。
 * 接了 DSH Agent 后端之后，同一批技能要让 DSH 也能用上 —— 否则 Agent 会拿它自己的
 * `project-layout` 技能（认 `spec/ stories/` 那套）去读作者的作品，把 `大纲/ 正文/`
 * 当成"不合规范"，还建议作者新建目录（本机实测，2026-10-10）。
 *
 * # DSH 的硬约束（全部实测得出，不是猜的）
 *
 * 1. **技能名必须是 ASCII slug**。`skill` 工具传中文名直接报
 *    `Error: invalid skill name "目录对照表"`；目录名是中文、frontmatter name 也是中文
 *    时同样无效。所以投递时用 `slug` 字段（如 `work-layout-map`）当目录名与 name。
 * 2. **技能只从 `~/.dsh/skills/<slug>/SKILL.md` 登记**。
 *    `--patch` 覆盖 `skill-filesystem.config.customSkillDirs` 在 `--dump-config` 里合成成功，
 *    但运行时**不被扫描** —— ASCII 名、带 `skills/` 子层、绝对路径全试过，都不行。
 *    所以唯一可靠的投递路径就是把文件写进 `~/.dsh/skills/`。
 * 3. 技能加载失败报 `Error: skill "x" is unknown or no longer available`。
 *
 * # 幂等与边界
 *
 * - 只写**本应用命名空间**（`mozhan-` 前缀）的目录，绝不覆盖作者自己在 `~/.dsh/skills/`
 *   放的技能（那是 50 个第三方技能的地盘）。
 * - 内容没变就不重写（DSH 有文件监听，反复写会触发无谓的重载）。
 * - 删除只删自己命名空间内、且这次没再投递的。
 */

import type { Skill } from './types'

/** 本应用写入 DSH 技能库时的目录前缀 —— 划清命名空间，避免误删作者自己的技能。 */
export const SKILL_NS = 'mozhan-'

/** 投递结果，UI 用来显示「已同步 N 个技能」。 */
export interface SyncResult {
  /** 本次写入的技能目录名（不含前缀） */
  written: string[]
  /** 因为内容相同而跳过的 */
  skipped: string[]
  /** 清理掉的过期技能目录名 */
  removed: string[]
}

/**
 * 把技能的中文名或任意文本转成合法的 DSH slug。
 *
 * 规则（对齐 DSH 报错信息里暗示的约束）：
 * - 只保留 `[a-z0-9-]`；
 * - ASCII 字母数字直接小写保留；
 * - 中文等非 ASCII 字符**丢弃**（不音译 —— 音译表又大又不准）；
 * - 结果为空时退化为 `skill`，再由调用方补 hash 后缀保证唯一。
 *
 * 注意：内置技能都显式写了 `slug`，这个函数只是给**作者手写的技能**兜底。
 */
export function toSlug(input: string): string {
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return ascii
}

/** 简单的稳定短哈希（FNV-1a 32 位），用于给纯中文技能名造唯一后缀。 */
export function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).slice(0, 6)
}

/**
 * 为一个技能算出它在 DSH 技能库里的目录名（**不含** `SKILL_NS` 前缀）。
 *
 * 优先用显式 `slug`；没有就用中文名的 ASCII 化结果；还是空就 `skill-<hash>`。
 * 最后统一补 hash 后缀 —— 因为中文名 ASCII 化后可能撞车
 * （「一致性检查」和「一致性 检查」都会变成空），撞车会让两个技能互相覆盖。
 */
export function skillDirName(s: Skill): string {
  const explicit = (s.slug || '').trim()
  const base = explicit || toSlug(s.name) || 'skill'
  // 显式 slug 也可能撞（作者手写重复），统一带 hash 保证稳定唯一
  return `${base}-${shortHash(s.name)}`
}

/** 生成要写进 DSH 技能库的 SKILL.md 内容：frontmatter 的 name 换成 slug。 */
export function renderForDsh(s: Skill): string {
  const dir = skillDirName(s)
  const tools = s.allowedTools.length ? s.allowedTools.join(', ') : 'read'
  const desc = (s.description || `本应用技能：${s.name}`).replace(/\r?\n/g, ' ').trim()
  const head = ['---', `name: ${dir}`, `description: ${desc}`, `allowed-tools: ${tools}`, '---'].join('\n')
  // 正文里标明中文名，方便作者在 DSH 侧认出这是哪个技能
  const body = s.content.trim()
  return `${head}\n\n<!-- 本技能由「墨栈写作台」自动投递，中文名：${s.name} -->\n\n${body}\n`
}

/** 一次投递计划：文件名 → 内容。 */
export interface DeliverPlan {
  /** 目录名（不含前缀）→ 文件内容 */
  files: Map<string, string>
  /** 目录名 → 中文名，UI 显示用 */
  labels: Map<string, string>
}

/**
 * 算出一份投递计划。**只处理启用的技能** —— 作者在设置里关掉的技能
 * 不应该出现在 DSH 那边（否则关了还在生效，作者会以为开关坏了）。
 */
export function planDelivery(skills: Skill[]): DeliverPlan {
  const files = new Map<string, string>()
  const labels = new Map<string, string>()
  for (const s of skills) {
    if (!s.enabled) continue
    const dir = skillDirName(s)
    files.set(dir, renderForDsh(s))
    labels.set(dir, s.name)
  }
  return { files, labels }
}

/**
 * 布局技能（目录对照表）在 DSH 侧的实际技能名。
 *
 * 用途：任务提示词里**点名**让 Agent 先加载它。不点名就得靠模型自己猜 ——
 * 实测它会把带 `mozhan-` 前缀的名字试一遍（先猜 `mozhan-work-layout-map-1xi1vn`
 * 失败、再猜 `work-layout-map-1xi1vn` 才成功），白烧一轮往返。
 * 点名之后一步到位。
 */
export function layoutSkillName(): string | null {
  const s = BUILTIN_LAYOUT
  return s ? `mozhan-${skillDirName(s)}` : null
}

/**
 * 找内置的「目录对照表」技能。按 slug 认，不按中文名 ——
 * 中文名作者能改，slug 是我们自己定的标识。
 */
const BUILTIN_LAYOUT_SKILL_SLUG = 'work-layout-map'
let BUILTIN_LAYOUT: Skill | null = null

/** 由 `stores/ai.ts` 在加载技能后注入，避免核心层反向依赖 store。 */
export function rememberLayoutSkill(skills: Skill[]): void {
  BUILTIN_LAYOUT = skills.find((s) => s.slug === BUILTIN_LAYOUT_SKILL_SLUG) || null
}

/**
 * 给任务前加一段「先读目录对照表」的引导。
 *
 * 不这么做的话，DSH 会退回到它自带的 `project-layout`（认 `spec/ stories/`），
 * 把本应用的 `大纲/ 正文/` 判成"不合规范"并建议新建目录 —— 本机实测过。
 */
export function layoutGuide(): string {
  const name = layoutSkillName()
  if (!name) return ''
  return (
    `【作品目录约定】这个作品用的是「墨栈写作台」的目录结构：` +
    `作品信息.md / 大纲/ / 设定/ / 正文/ / 记忆/ / 技能/。` +
    `动手前先用 skill 工具加载 \`${name}\`，按它说的路径去找文件；` +
    `**不要**新建 spec/、stories/、memory/ 这类目录，也不要把现有结构判成"不合规范"。\n\n`
  )
}

