/** 数据模型（对应开发文档第四节：目录结构即数据模型） */

export type ChapterStatus = '待写' | '草稿' | '待修' | '已定稿'

export const STATUS_LIST: ChapterStatus[] = ['待写', '草稿', '待修', '已定稿']

export interface ChapterMeta {
  /** 本章目标 */
  target?: string
  /** 出场人物 */
  characters?: string[]
  /** 涉及设定 */
  settings?: string[]
  /** 情绪走向 */
  emotion?: string
  /** 自定义备注 */
  notes?: string
}

export interface Chapter {
  /** 唯一标识：相对于作品根的 POSIX 路径 */
  id: string
  /** 所属卷 id（未分卷为 null） */
  volumeId: string | null
  /** 文件名（不含路径） */
  file: string
  title: string
  status: ChapterStatus
  tags: string[]
  order: number
  wordCount: number
  updated: string
  meta: ChapterMeta
}

export interface VolumeMeta {
  /** 本卷目标 */
  target?: string
  /** 核心冲突 */
  conflict?: string
  /** 推进线 */
  line?: string
  /** 卷末钩子 */
  hook?: string
  notes?: string
}

export interface Volume {
  id: string
  name: string
  /** 卷目录名 */
  dir: string
  order: number
  chapters: Chapter[]
  wordCount: number
  meta: VolumeMeta
}

export interface WorkInfo {
  title: string
  author: string
  brief: string
  targetWords: number
  created: string
}

export interface WorkSummary {
  title: string
  author: string
  brief: string
  wordCount: number
  targetWords: number
  chapterCount: number
  updated: string
}

/** 设定条目分类（对应「设定/」下的子目录） */
export type SettingKind = 'character' | 'location' | 'item' | 'organization' | 'race' | 'lore' | 'term' | 'timeline' | 'misc'

/** 设定库条目：底层存储仍然是「设定/xx/名称.md」的作者自己的 Markdown */
export interface SettingEntry {
  /** 相对作品根的路径 id */
  id: string
  kind: SettingKind
  name: string
  aliases: string[]
  /** 目录归属（人物设定 / 世界设定 / 自定义） */
  group: string
  file: string
  wordCount: number
  /** front matter 中的其余字段 */
  fields: Record<string, string>
  body: string
  /** 正文中 [[名称]] 形式的关系指向 */
  links: string[]
}

export interface RecentWork {
  refId: string
  name: string
  pathLabel: string
  lastOpened: string
  lastWordCount: number
}

/** 设定/资料文件（正文外的参考资料，注入上下文用） */
export interface AssetDoc {
  id: string
  name: string
  /** 分类：大纲 / 设定 / 记忆 等 */
  group: string
  wordCount: number
}

export interface Skill {
  id: string
  name: string
  /**
   * 面向外部 Agent（DSH）的技能标识：**必须是 ASCII slug**。
   *
   * 为什么要单独一个字段：本应用界面上用的是中文名（`一致性检查`），
   * 但 DSH 的 skill 工具只认 `[a-z0-9-]` 这类 ASCII 名 —— 传中文名会直接报
   * `invalid skill name`（本机 dsh 0.2.0-rc.2 实测）。
   * 所以投递技能到 `~/.dsh/skills/` 时用 slug 当目录名与 frontmatter name，
   * 中文名只留在本应用的界面与提示词里。
   * 没有 slug 的技能（作者手写的）投递时按中文名兜底 transliterate/哈希，
   * 见 `core/agentSkills.ts`。
   */
  slug?: string
  description: string
  allowedTools: string[]
  source: 'builtin' | 'work' | 'global'
  enabled: boolean
  /** 文件所在位置（可编辑） */
  location?: string
  content: string
}

export interface ContextItem {
  id: string
  label: string
  detail: string
  content: string
  group: '大纲' | '本章' | '设定' | '记忆' | '前文' | '文风'
  enabled: boolean
  required?: boolean
  source: string
}

export interface Candidate {
  id: string
  title: string
  text: string
  model: string
  skill?: string
  createdAt: string
  mode: 'continue' | 'rewrite' | 'expand' | 'shrink' | 'tone' | 'summary' | 'outline' | 'generate' | 'fix' | 'setting'
  targetChapterId?: string
  applied?: boolean
  tokens?: number
  /**
   * 纠错模式的「改了什么」清单：模型按约定分隔符输出，这里拆开存放。
   * 拆开是必须的 —— 不然采纳时会把说明文字一起写进正文。
   */
  notes?: string
  /** 纠错没有选区时是对整章做的：采纳方式因此不同（替换整章，不是替换选区） */
  wholeChapter?: boolean
}
