<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import fs, { hostInfo, peekHost } from '@/platform'
import { aiState, enabled, loadSkills, rawChat } from '@/stores/ai'
import * as sk from '@/core/skills'
import { settings } from '@/core/settings'
import { download } from '@/core/exportDoc'
import { agentSkillsDir } from '@/platform/aiBridge'
import { state } from '@/stores/workspace'
import { askConfirm } from '@/stores/dialog'
import {
  SKILL_CAT_LABEL,
  SKILL_CAT_ORDER,
  organizePrompt,
  parseOrganizePlan,
  type OrganizeItem,
  type SkillCat
} from '@/core/skillCats'
import {
  descZhOf,
  displayDesc,
  displayName,
  parseSkillZh,
  pickNeedZh,
  setSkillZh,
  skillZhPrompt,
  zhOf,
  type ParsedZh
} from '@/core/skillI18n'
import type { Skill } from '@/core/types'

// 移动端没有目录选择器：靠选文件夹导入技能的入口在那里用不了，直接不显示，
// 而不是让人点完才发现没反应。
const mobile = ref(!!peekHost()?.isMobile)
onMounted(async () => {
  mobile.value = (await hostInfo()).isMobile
})

const editing = ref<Skill | null>(null)
const importing = ref(false)
const notice = ref('')
const filter = ref('')
/** 当前选中的分类页签；'all' = 全部 */
const cat = ref<SkillCat | 'all'>('all')

/** 一条技能当前生效的分类（作者手挪 > frontmatter > 启发式，见 core/skills.catOf） */
const catOf = (s: Skill) => sk.catOf(s)

// 注意要复制一份再 sort：Array.prototype.sort 是原地排序，直接对 aiState.skills 排
// 会把 store 里的顺序也改掉（别的组件读到的顺序跟着变），这种隐式副作用后来极难查。
const list = computed(() =>
  aiState.skills
    .filter((s) => (cat.value === 'all' ? true : catOf(s) === cat.value))
    // 搜索要同时认中文译名：作者记住的是「断点续写」，不是 continuation
    .filter((s) => !filter.value || s.name.includes(filter.value) || displayName(s.name).includes(filter.value) || s.description.includes(filter.value) || displayDesc(s.name, s.description).includes(filter.value))
    .slice()
    .sort((a, b) => SKILL_CAT_ORDER.indexOf(catOf(a)) - SKILL_CAT_ORDER.indexOf(catOf(b)) || a.name.localeCompare(b.name))
)

/** 每个分类的数量（页签上标出来，作者不用点进去数） */
const catCounts = computed(() => {
  const m = new Map<SkillCat, number>()
  for (const s of aiState.skills) m.set(catOf(s), (m.get(catOf(s)) || 0) + 1)
  return m
})

/**
 * 可清理的「无关技能」条数（内置技能不算 —— 见 clearOther 的注释）。
 * 页签上的数字和这个数不一样时要能看出来，否则作者会以为按钮漏了几条。
 */
const junkCount = computed(() => aiState.skills.filter((s) => catOf(s) === 'other' && s.source !== 'builtin').length)

async function toggle(s: Skill, on: boolean) {
  sk.setSkillEnabled(s.name, on)
  await loadSkills()
}

async function pickLibrary() {
  const d = await fs().pickDir('选择全局技能库目录')
  if (!d) return
  settings.skillLibrary = { id: d.id, name: d.name }
  await loadSkills()
}

/**
 * 一键接入本机 DSH 的技能库（`~/.dsh/skills`）。
 *
 * 为什么值得一个按钮：DSH 那边装了 50 来个技能，其中十多个跟小说写作直接相关
 * （`continuation` 断点续写、`long-memory` 记忆维护、`style-imitation` 文风仿写…）。
 * 这些技能就是纯文本提示词，读进来不联网、不花钱，接上就能喂给应用自己的 API 引擎。
 * 原来的路是「先自己知道 ~/.dsh/skills 在哪，再逐个点选文件夹」—— 对一个
 * 只想写小说的作者来说门槛太高了。
 */
const dshBusy = ref(false)
async function useDshLibrary() {
  dshBusy.value = true
  try {
    const r = await agentSkillsDir()
    if (!r.found || !r.path) {
      notice.value = r.path
        ? `没找到 DSH 技能库（${r.path} 不存在）—— 装过 DSH 再用这个入口`
        : '没找到 DSH 技能库（需要桌面端，且本机装过 DSH）'
      return
    }
    // 直接用绝对路径当 DirRef id：桌面端 DirRef.id 本身就是路径（同 Agent 的 cwd）
    settings.skillLibrary = { id: r.path, name: r.path.split(/[\\/]/).pop() || 'skills' }
    await loadSkills()
    const n = aiState.skills.length
    notice.value = `已接入 DSH 技能库（发现 ${r.count} 个技能，合并后共 ${n} 个）`
  } catch (e: any) {
    notice.value = `接入失败：${e?.message || e}`
  } finally {
    dshBusy.value = false
  }
}

async function importFolder() {
  const d = await fs().pickDir('选择含 SKILL.md 的技能文件夹')
  if (!d || !state.ref) return
  const n = await sk.importFromFolder(d, state.ref)
  notice.value = `导入了 ${n} 个技能`
  await loadSkills()
}

/**
 * 导入散装文件：zip（可以是一整个技能包），或单个 .md/.txt/.markdown。
 *
 * 单文件这条路上原来没有 —— 作者手里最常见的形态恰恰就是一个 SKILL.md
 * （或从别的工具导出的一份提示词），却必须先打成 zip 或摆成目录才能进。
 * 文件名做兜底技能名：frontmatter 里没写 name 的，总不能叫「未命名技能」。
 */
async function importFiles(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files || [])
  ;(e.target as HTMLInputElement).value = ''
  if (!files.length) return
  if (!state.ref) {
    notice.value = '先打开一部作品 —— 导入的技能存进作品的「技能/」目录。'
    return
  }
  importing.value = true
  try {
    let n = 0
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        n += await sk.importFromZip(f, state.ref)
        continue
      }
      const raw = await f.text()
      const parsed = sk.parseSkillFile(raw, 'work', f.name)
      const fallback = f.name.replace(/\.(md|markdown|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '_') || '未命名技能'
      const name = !parsed.name || parsed.name === '未命名技能' || /\.(md|markdown|txt)$/i.test(parsed.name) ? fallback : parsed.name
      await sk.saveWorkSkill(state.ref, { ...parsed, name, content: parsed.content || raw })
      n++
    }
    notice.value = `导入了 ${n} 个技能`
    await loadSkills()
  } catch (err: any) {
    notice.value = `导入失败：${err?.message || err}`
  } finally {
    importing.value = false
  }
}

function newSkill() {
  editing.value = {
    id: 'tmp',
    name: '',
    slug: '',
    description: '',
    category: '',
    allowedTools: [],
    source: 'work',
    enabled: true,
    content: '# 技能正文\n\n## 何时使用\n\n## 流程\n\n## 输出格式\n'
  }
}

async function saveSkill() {
  if (!editing.value || !state.ref) return
  const s = editing.value
  if (!s.name.trim()) {
    notice.value = '技能名不能为空'
    return
  }
  await sk.saveWorkSkill(state.ref, { ...s, name: s.name.trim(), category: s.category || undefined })
  editing.value = null
  await loadSkills()
}

/**
 * 删除一条技能。
 *
 * 两种「删除」要分清：
 *  - 作品内技能（`技能/` 目录）：真删文件；
 *  - 全局（DSH 技能库）/ 内置技能：只**隐藏** —— 那个目录是 DSH 自己的，
 *    里面的技能 DSH 本体可能还要用，应用没权利替作者删他自己的文件。
 *    隐藏 = 从列表和喂给 AI 的技能目录里消失，随时可恢复。
 */
async function remove(s: Skill) {
  if (s.source === 'work' && state.ref) {
    const ok = await askConfirm({
      title: `删除作品内技能「${s.name}」`,
      message: '该技能会从作品的「技能」目录里移除。',
      detail: ['内置技能不受影响，需要时随时能再装回来'],
      okText: '删除',
      danger: true
    })
    if (!ok) return
    await sk.deleteWorkSkill(state.ref, s)
    await loadSkills()
    return
  }
  const ok = await askConfirm({
    title: `隐藏技能「${s.name}」`,
    message: s.source === 'builtin' ? '内置技能不从磁盘删除，只是不再出现在列表里、也不会喂给 AI。' : '这个技能在全局技能库（DSH）里 —— 应用不会动那个目录的文件，只在列表里隐藏它。',
    detail: ['想恢复时点列表底部的「已隐藏的技能」'],
    okText: '隐藏',
    danger: true
  })
  if (!ok) return
  sk.hideSkill(s.name)
  await loadSkills()
  notice.value = `已隐藏「${s.name}」（没有删除任何文件）`
}

const hiddenList = computed(() => sk.hiddenSkillNames())

/**
 * 把一条技能挪到另一个分类。
 *
 * 两种落点要分开：
 *  - 作品内技能 → 分类写进 `技能/<名>/SKILL.md` 的 frontmatter。
 *    作品的技能目录是「目录即数据模型」的一部分，分类跟着作品走，
 *    换台电脑、拷给别人的时候分类还在；只记在本机 settings 里就丢了。
 *  - 全局（DSH 技能库）/ 内置技能 → 只能记在本机 settings。
 *    那些文件不属于本应用（`~/.dsh/skills` 是 DSH 自己的），一个字都不能改。
 *
 * 挪完重新 load 一次：页签计数 / 筛选 / 排序要跟界面用同一份数据，
 * 而不是界面刷新了、底层列表还是旧顺序。
 */
async function applyMove(s: Skill, c: SkillCat) {
  if (!c || c === catOf(s)) return
  if (s.source === 'work' && state.ref) {
    sk.clearCat(s.name)
    await sk.saveWorkSkill(state.ref, { ...s, category: c })
  } else {
    sk.moveCat(s, c)
  }
  await loadSkills()
}

async function onMoveCat(s: Skill, value: string) {
  await applyMove(s, value as SkillCat)
}

/**
 * 清掉「其他」这一类 —— 也就是清掉跟小说写作无关的技能。
 *
 * 这一步不能静默做：启发式分类会看错（「目录对照表」这种元技能就落在其他里），
 * 所以必须先把名单摊给作者确认。作品内技能真删文件，全局/内置技能只隐藏。
 */
async function clearOther() {
  // 内置技能不进这个名单：它们是我们自己挑出来的、跟写作全都相关，
  // 只是不属于那五类（比如「目录对照表」）。让作者一键把自己认可的技能清掉是坑。
  const others = aiState.skills.filter((s) => catOf(s) === 'other' && s.source !== 'builtin')
  if (!others.length) return
  const work = others.filter((s) => s.source === 'work').length
  const ok = await askConfirm({
    title: `清理无关技能（${others.length} 个）`,
    message: '「其他」= 不属于大纲 / 设定 / 文本生成 / 记忆 / 文风 的技能，通常是工具类、元技能。',
    detail: [
      work ? `其中 ${work} 个是作品内技能，会从作品的「技能」目录里删掉` : '没有作品内技能，全部只做隐藏',
      others.length - work ? '全局（DSH）技能不删文件，只在列表里隐藏，可随时恢复' : '',
      '内置技能不在清理范围内（我们挑的，都跟写作相关）'
    ].filter(Boolean) as string[],
    okText: `清理 ${others.length} 个`,
    danger: true
  })
  if (!ok) return
  let deleted = 0
  let hidden = 0
  for (const s of others) {
    if (s.source === 'work' && state.ref) {
      await sk.deleteWorkSkill(state.ref, s)
      deleted++
    } else {
      sk.hideSkill(s.name)
      hidden++
    }
  }
  await loadSkills()
  notice.value = `清理完成：删除 ${deleted} 个、隐藏 ${hidden} 个（可按分类页签逐个查看）`
}

async function restore(name: string) {
  sk.restoreSkill(name)
  await loadSkills()
}

function exportOne(s: Skill) {
  sk.exportSkillZip(s).then((b) => download(b, `${s.name}.zip`))
}

/* ------------------------------------------------------------------ AI 整理 *
 * 作者发一句话指令（「把跟写作无关的删掉」「把大纲类的挪到一起」），
 * AI 对着**全部技能名单**出一份方案；方案先摊开给人勾选，确认了才动手 ——
 * 和所有 AI 功能同一条铁律：不确认，不动盘。
 */

const aiOpen = ref(false)
const aiBusy = ref(false)
const aiInstruction = ref('')
/** AI 没有给方案、而是直接回答了作者的问题（「有没有能起名的技能」）时，把话原样摊出来 */
const aiAnswer = ref('')
const plan = ref<OrganizeItem[]>([])
const planPicked = ref<Set<string>>(new Set())

const canOrganize = computed(() => !!enabled.value)

/** 默认指令：作者最常想做的第一件事就是「把不相关的清掉」，别让人从空白框开始想 */
const DEFAULT_INSTRUCTION = '把跟小说写作无关的技能都删掉，其余按用途归类到 大纲 / 设定 / 文本生成 / 记忆 / 文风。'

function openAi() {
  aiOpen.value = !aiOpen.value
  if (aiOpen.value && !aiInstruction.value.trim()) aiInstruction.value = DEFAULT_INSTRUCTION
}

/** 面板里每条技能在 AI 眼里的样子（name + 当前分类 + 描述） */
async function askOrganize() {
  aiBusy.value = true
  notice.value = ''
  aiAnswer.value = ''
  try {
    const catalog = aiState.skills.map((s) => ({ name: s.name, description: s.description, category: catOf(s) }))
    const out = await rawChat(
      '你是写作应用的技能整理助手。作者让你整理技能时就只输出 JSON 方案；作者只是问问题（比如「有没有能起名的技能」）就直接回答，不要输出 JSON。',
      organizePrompt(catalog, aiInstruction.value)
    )
    const items = parseOrganizePlan(out, aiState.skills.map((s) => s.name))
    if (!items.length) {
      plan.value = []
      // 模型没吐 JSON、而是认真回答了一段话 —— 那多半是作者在问「有没有 XX 技能」，
      // 把话原样摊出来，别用一句「没有可用方案」把答案吃掉。
      if (!out.includes('[')) aiAnswer.value = out.trim()
      else notice.value = 'AI 没有给出可用的整理方案（可能所有技能在它看来都已经归类正确）。'
      return
    }
    plan.value = items
    // 默认全选：作者要做的只是把明显不对的几条勾掉，而不是逐条打勾
    planPicked.value = new Set(items.map((i) => i.name))
  } catch (e: any) {
    notice.value = `整理失败：${e?.message || e}`
  } finally {
    aiBusy.value = false
  }
}

function togglePick(name: string, on: boolean) {
  const next = new Set(planPicked.value)
  if (on) next.add(name)
  else next.delete(name)
  planPicked.value = next
}

function findSkill(name: string): Skill | undefined {
  return aiState.skills.find((s) => s.name === name)
}

/**
 * 应用勾选的方案。
 *
 * 顺序是「先挪后删」：删除会把技能从列表里拿掉，反过来做的话，
 * 一条既该挪又该删的技能会先消失，挪的那一步就找不到人了（静默少做一件事）。
 */
async function applyPlan() {
  const picked = plan.value.filter((i) => planPicked.value.has(i.name))
  if (!picked.length) return
  let moved = 0
  let deleted = 0
  let hidden = 0
  for (const it of picked) {
    if (it.cat !== 'delete') {
      const s = findSkill(it.name)
      if (s && catOf(s) !== it.cat) {
        await applyMove(s, it.cat)
        moved++
      }
    }
  }
  for (const it of picked) {
    if (it.cat !== 'delete') continue
    const s = findSkill(it.name)
    if (s?.source === 'work' && state.ref) {
      await sk.deleteWorkSkill(state.ref, s)
      deleted++
    } else {
      sk.hideSkill(it.name)
      hidden++
    }
  }
  await loadSkills()
  plan.value = []
  planPicked.value = new Set()
  const bits = [`移动 ${moved} 个`]
  if (deleted) bits.push(`删除 ${deleted} 个`)
  if (hidden) bits.push(`隐藏 ${hidden} 个（全局/内置技能不动文件）`)
  notice.value = `整理完成：${bits.join('，')}`
}

/* ------------------------------------------------------------------ AI 翻译 *
 * 技能库里大半是英文技能（DSH 那 50 来个尤其如此），作者看着一堆
 * `continuation` / `long-memory` 不知道是干什么的。让 AI 翻成中文，
 * 但**只改显示**：译名存本机 settings，一个 SKILL.md 都不动 ——
 * 全局技能库是 DSH 自己的目录，应用没权利替作者改他自己的文件。
 *
 * 和整理功能同一条铁律：AI 出的译名先摊开给人勾选，确认了才写。
 */

const zhOpen = ref(false)
const zhBusy = ref(false)
const zhInstruction = ref('')
const zhList = ref<ParsedZh[]>([])
const zhPicked = ref<Set<string>>(new Set())

/** 需要翻的那批（已经是中文的技能不送去翻：省钱，也不会把作者自己的命名改坏） */
const needZh = computed(() => pickNeedZh(aiState.skills.map((s) => ({ name: s.name, slug: s.slug, description: s.description }))))

/** 默认指令：作者要的就是「看得懂」，别让人从空白框开始想 */
const DEFAULT_ZH_INSTRUCTION = '译名要短、要能一眼看出这个技能是干什么的；看不出用途的就按字面直译。'

function openZh() {
  zhOpen.value = !zhOpen.value
  if (zhOpen.value && !zhInstruction.value.trim()) zhInstruction.value = DEFAULT_ZH_INSTRUCTION
}

async function askZh() {
  if (!needZh.value.length) {
    notice.value = '没有需要翻译的技能（名字和说明都已经是中文了）。'
    return
  }
  zhBusy.value = true
  notice.value = ''
  try {
    const out = await rawChat(
      '你是写作软件的技能翻译助手。只输出「原名|译名|译述」这类三列文本，不要输出别的话。',
      skillZhPrompt(needZh.value, zhInstruction.value)
    )
    const items = parseSkillZh(out, needZh.value.map((s) => s.name))
    if (!items.length) {
      zhList.value = []
      notice.value = 'AI 没有给出可用的译名（它可能直接回答了一段话，而不是按格式输出）。'
      return
    }
    zhList.value = items
    zhPicked.value = new Set(items.map((i) => i.name))
  } catch (e: any) {
    notice.value = `翻译失败：${e?.message || e}`
  } finally {
    zhBusy.value = false
  }
}

function toggleZhPick(name: string, on: boolean) {
  const next = new Set(zhPicked.value)
  if (on) next.add(name)
  else next.delete(name)
  zhPicked.value = next
}

/** 应用勾选的译名：只写本机 settings，不动任何 SKILL.md */
function applyZh() {
  const picked = zhList.value.filter((i) => zhPicked.value.has(i.name))
  if (!picked.length) return
  setSkillZh(picked)
  zhList.value = []
  zhPicked.value = new Set()
  notice.value = `已译 ${picked.length} 个技能名（只改显示，没动任何技能文件）`
}
</script>

<template>
  <div class="sk">
    <div class="spread">
      <b class="tt">技能</b>
      <div class="row">
        <button class="text small" @click="newSkill">＋新建</button>
        <button v-if="!mobile" class="text small" @click="pickLibrary">指定技能库目录</button>
      </div>
    </div>
    <p v-if="!enabled" class="small dim">技能随 AI 层启用；配置 API 后才能调用。</p>
    <p class="small dim">加载优先级：作品内 <code>技能/</code> &gt; 全局技能库 &gt; 内置技能（同名覆盖）。</p>

    <div class="row small">
      <input v-model="filter" placeholder="搜索技能" />
      <button v-if="!mobile" class="text small" @click="importFolder">导入文件夹</button>
      <label class="text small" style="cursor: pointer">
        导入文件（zip / md）
        <input type="file" accept=".zip,.md,.markdown,.txt" multiple style="display: none" @change="importFiles" />
      </label>
    </div>
    <div v-if="!mobile" class="row small">
      <button class="text small" :disabled="dshBusy" @click="useDshLibrary">
        {{ dshBusy ? '查找中…' : '一键接入 DSH 技能库' }}
      </button>
      <span class="dim">把本机 DSH 装的写作技能直接读进来，不用手动找目录</span>
    </div>
    <div v-if="settings.skillLibrary" class="small dim">全局技能库：{{ settings.skillLibrary.name }}</div>
    <div v-if="notice" class="small dim">{{ notice }}</div>

    <!-- AI 整理：发一句话指令，AI 出方案，人工勾选后才应用 -->
    <div v-if="canOrganize" class="ai-box">
      <div class="spread">
        <button class="text small" @click="openAi">
          {{ aiOpen ? '收起 AI 整理' : '✦ 让 AI 整理技能' }}
        </button>
        <span class="dim small">分类 / 移动 / 删除无关技能 / 帮你找技能</span>
      </div>
      <div v-if="aiOpen" class="col">
        <textarea
          v-model="aiInstruction"
          rows="2"
          placeholder="告诉 AI 你想怎么整理。例如：把跟写小说无关的技能都删掉；把大纲类的技能归到一起；帮我找找有没有能起名字的技能"
        ></textarea>
        <div class="row">
          <button class="primary small" :disabled="aiBusy" @click="askOrganize">
            {{ aiBusy ? '整理中…' : '让 AI 出方案' }}
          </button>
          <span class="dim small">方案出来后由你勾选确认，不会直接动手</span>
        </div>

        <div v-if="aiAnswer" class="answer small">{{ aiAnswer }}</div>

        <div v-if="plan.length" class="plan">
          <div class="spread">
            <b class="small">整理方案（{{ plan.length }} 条）</b>
            <span class="row">
              <button class="text small" @click="planPicked = new Set(plan.map((i) => i.name))">全选</button>
              <button class="text small" @click="planPicked = new Set()">全不选</button>
            </span>
          </div>
          <label v-for="it in plan" :key="it.name" class="plan-row small">
            <input
              type="checkbox"
              style="width: auto"
              :checked="planPicked.has(it.name)"
              @change="togglePick(it.name, ($event.target as any).checked)"
            />
            <b class="nm">{{ it.name }}</b>
            <span v-if="it.cat === 'delete'" class="tag warn">删除</span>
            <template v-else>
              <span class="dim">→</span>
              <span class="tag info">{{ SKILL_CAT_LABEL[it.cat] }}</span>
            </template>
            <span class="dim reason">{{ it.reason }}</span>
          </label>
          <div class="row">
            <button class="primary small" :disabled="!planPicked.size" @click="applyPlan">
              应用所选（{{ planPicked.size }}）
            </button>
            <button class="text small" @click="plan = []">放弃</button>
          </div>
          <p class="small dim">全局 / 内置技能的「删除」是隐藏：不删 DSH 目录里的文件，随时可恢复。</p>
        </div>
      </div>
    </div>
    <p v-else class="small dim">AI 整理需要在设置里配置 API（直连或 both 档）。</p>

    <!-- AI 翻译：把英文技能名/说明翻成中文。只改显示，不动任何 SKILL.md -->
    <div v-if="canOrganize" class="ai-box">
      <div class="spread">
        <button class="text small" @click="openZh">
          {{ zhOpen ? '收起 AI 翻译' : `✦ 让 AI 翻译技能名${needZh.length ? `（${needZh.length} 个是英文）` : ''}` }}
        </button>
        <span class="dim small">只改界面显示，不动技能文件</span>
      </div>
      <div v-if="zhOpen" class="col">
        <textarea
          v-model="zhInstruction"
          rows="2"
          placeholder="告诉 AI 你想怎么翻。例如：译名要短，按它实际干什么翻，不要逐词直译"
        ></textarea>
        <div class="row">
          <button class="primary small" :disabled="zhBusy || !needZh.length" @click="askZh">
            {{ zhBusy ? '翻译中…' : `让 AI 出译名（${needZh.length}）` }}
          </button>
          <span class="dim small">译名出来后由你勾选，确认才生效</span>
        </div>

        <div v-if="zhList.length" class="plan">
          <div class="spread">
            <b class="small">译名（{{ zhList.length }} 条）</b>
            <span class="row">
              <button class="text small" @click="zhPicked = new Set(zhList.map((i) => i.name))">全选</button>
              <button class="text small" @click="zhPicked = new Set()">全不选</button>
            </span>
          </div>
          <label v-for="it in zhList" :key="it.name" class="plan-row small">
            <input
              type="checkbox"
              style="width: auto"
              :checked="zhPicked.has(it.name)"
              @change="toggleZhPick(it.name, ($event.target as any).checked)"
            />
            <b class="nm">{{ it.zh }}</b>
            <span class="dim mono">{{ it.name }}</span>
            <span class="dim reason">{{ it.desc }}</span>
          </label>
          <div class="row">
            <button class="primary small" :disabled="!zhPicked.size" @click="applyZh">
              应用所选（{{ zhPicked.size }}）
            </button>
            <button class="text small" @click="zhList = []">放弃</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="editing" class="panel edit">
      <div class="row">
        <input v-model="editing.name" placeholder="技能名（唯一标识）" />
      </div>
      <div class="row">
        <input
          v-model="editing.slug"
          placeholder="英文标识 slug（可留空，自动生成）—— 外部 Agent 用它认这个技能"
        />
      </div>
      <div class="row">
        <select v-model="editing.category" class="cat-select">
          <option value="">分类：跟关键词自动判断</option>
          <option v-for="c in SKILL_CAT_ORDER" :key="c" :value="c">{{ SKILL_CAT_LABEL[c] }}</option>
        </select>
      </div>
      <textarea v-model="editing.description" rows="2" placeholder="description：决定 AI 何时自动加载它，写清楚触发场景"></textarea>
      <textarea v-model="editing.content" rows="16" placeholder="技能正文：流程 / 规范 / 输出格式"></textarea>
      <div class="row">
        <button class="primary" @click="saveSkill">保存到 作品/技能/</button>
        <button @click="editing = null">取消</button>
        <span class="small dim">allowed-tools 由正文决定，脚本默认不执行</span>
      </div>
    </div>

    <!-- 分类页签：每类几个一眼看清 -->
    <div class="row small wrap chips">
      <button class="chip" :class="{ on: cat === 'all' }" @click="cat = 'all'">
        全部{{ aiState.skills.length ? ` ${aiState.skills.length}` : '' }}
      </button>
      <button v-for="c in SKILL_CAT_ORDER" :key="c" class="chip" :class="{ on: cat === c }" @click="cat = c">
        {{ SKILL_CAT_LABEL[c] }}{{ catCounts.get(c) ? ` ${catCounts.get(c)}` : '' }}
      </button>
    </div>
    <!-- 「其他」= 跟写小说无关的那批，给一个一次清掉的入口（清之前先摊名单确认） -->
    <div v-if="cat === 'other' && junkCount" class="row small">
      <button class="text small danger-text" @click="clearOther">清理无关技能（{{ junkCount }}）</button>
      <span class="dim">删作品内技能 / 隐藏全局技能；内置技能不在其中</span>
    </div>

    <div class="list">
      <div v-if="!list.length" class="small dim pad">这个分类下没有技能。</div>
      <div v-for="s in list" :key="s.id" class="item">
        <div class="spread">
          <div class="row">
            <input type="checkbox" :checked="s.enabled" style="width: auto" @change="toggle(s, ($event.target as any).checked)" />
            <!-- 有译名就显示中文，原名缩在后面那个小标签里：作者随时能对着原名去搜索/对照 -->
            <b class="nm">{{ displayName(s.name) }}</b>
            <span v-if="zhOf(s.name)" class="tag small dim mono" :title="`原名（AI 译）：${s.name}`">{{ s.name }}</span>
            <span class="tag small">{{ s.source === 'builtin' ? '内置' : s.source === 'work' ? '作品内' : '全局' }}</span>
            <span class="tag small info">{{ SKILL_CAT_LABEL[catOf(s)] }}</span>
            <span v-if="s.slug" class="tag small mono" :title="`给外部 Agent（DSH）用的英文标识：投递时目录名是 mozhan-${s.slug}-*`">{{ s.slug }}</span>
          </div>
          <div class="row">
            <button v-if="s.source === 'work'" class="text small" @click="editing = { ...s }">编辑</button>
            <button class="text small" @click="exportOne(s)">导出</button>
            <button class="text small danger-text" @click="remove(s)">{{ s.source === 'work' ? '删除' : '隐藏' }}</button>
          </div>
        </div>
        <div class="small dim" :title="descZhOf(s.name) ? `原文：${s.description}` : ''">
          {{ displayDesc(s.name, s.description) || '（无描述：AI 不会自动判断何时用它）' }}
        </div>
        <!-- 移动分类单独占一行：跟「编辑/导出/删除」挤在同一行时，flex 会把它压到 0 宽，
             「文本生成」四个字直接被切没（§7.14 全界面扫描抓到的）。 -->
        <div class="row small cat-row">
          <span class="dim nowrap">分类</span>
          <select
            class="cat-select"
            :value="catOf(s)"
            title="移动到别的分类"
            @change="onMoveCat(s, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="c in SKILL_CAT_ORDER" :key="c" :value="c">{{ SKILL_CAT_LABEL[c] }}</option>
          </select>
        </div>
      </div>
    </div>

    <details v-if="hiddenList.length" class="hidden-box">
      <summary class="small dim">已隐藏的技能（{{ hiddenList.length }}）</summary>
      <div v-for="n in hiddenList" :key="n" class="spread small">
        <span>{{ n }}</span>
        <button class="text small" @click="restore(n)">恢复</button>
      </div>
    </details>
  </div>
</template>

<style scoped>
.sk {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.code,
code {
  font-family: Consolas, monospace;
  font-size: 11px;
  background: var(--line-soft);
  padding: 0 4px;
  border-radius: 3px;
}
.edit {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edit textarea {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
}
.chips {
  gap: 4px;
}
.chip {
  border: 1px solid var(--line);
  background: var(--bg-field);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--text-soft);
  cursor: pointer;
}
.chip.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 56vh;
  overflow: auto;
}
.item {
  border-bottom: 1px dashed var(--line-soft);
  padding-bottom: 8px;
}
.nm {
  font-size: 13px;
}
.pad {
  padding: 10px;
}
/* 分类下拉：别写死高度（写死必削字，项目里有前科），宽度让 flex 去分。
   注意 `min-width: 0` 在这里是**正确**的：全局 `select` 有 26px 的箭头内边距，
   在窄面板上不让它收缩会溢出；它独占一行，分到的是整行减掉标签的宽度，够放四个字。 */
.cat-select {
  flex: 1 1 auto;
  min-width: 0;
}
.cat-row {
  padding-top: 2px;
}
.ai-box {
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-box .col {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-box textarea {
  min-height: 52px;
  resize: vertical;
}
.plan {
  border-top: 1px dashed var(--line-soft);
  padding-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.plan-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.answer {
  white-space: pre-wrap;
  background: var(--bg-field);
  border-left: 2px solid var(--accent-soft);
  padding: 6px 8px;
  border-radius: 4px;
}
.reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hidden-box {
  border-top: 1px dashed var(--line-soft);
  padding-top: 6px;
}
</style>
