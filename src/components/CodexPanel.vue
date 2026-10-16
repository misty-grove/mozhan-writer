<script setup lang="ts">
/**
 * 设定库面板（Task #1）
 * 数据落在「设定/<分类>/<名称>.md」，这里的编辑最终都写回作者自己的 Markdown。
 */
import { computed, reactive, ref, watch } from 'vue'
import { KIND_LABEL, KIND_ORDER, defaultBody, importSettingFolder } from '@/core/codex'
import fs from '@/platform'
import { buildRefIndex, presenceStats, type RefHit } from '@/core/links'
import type { SettingKind } from '@/core/types'
import { addEntry, codexState, ensureCodex, removeEntry, refreshCodex, saveEntry } from '@/stores/codex'
import { askConfirm } from '@/stores/dialog'
import { aiEnabled } from '@/core/settings'
import { generate } from '@/stores/ai'
import { GEN_KIND_LABEL, condenseOutline, savedTags, settingGenPrompt, type SettingGenKind } from '@/core/worldbuild'
import { setDockTab } from '@/stores/editor'
import { ensureBodies, orderedChapters, state } from '@/stores/workspace'

interface FieldRow {
  k: string
  v: string
}

const draft = reactive({
  name: '',
  aliases: '',
  fields: [] as FieldRow[],
  body: ''
})

const creating = ref(false)
const newKind = ref<SettingKind>('character')
const newName = ref('')
const busy = ref(false)
const msg = ref('')

const refs = ref<RefHit[]>([])
const gap = ref<{ total: number; lastChapter: number | null; gapFromEnd: number } | null>(null)

/* 大纲的状态必须在下面那个 watch 之前声明 —— 那个 watch 是 `immediate: true`，
   在 setup 阶段就会同步调到 loadOutline()，而这些是 `const` ref。
   声明在后面就是 TDZ：`ReferenceError: Cannot access 'genOutline' before initialization`，
   整个面板白屏。这个项目在「绑到元素上」的初始化上栽过一次，这里是同一类坑。 */
/** 大纲读进来一次就够：面板打开时读，作者改了再点「重读大纲」 */
const genOutline = ref('')
const genOutlineName = ref('')
const genOutlineErr = ref('')

const selected = computed(() => codexState.entries.find((e) => e.id === codexState.selectedId) || null)
const dirty = computed(() => {
  const e = selected.value
  if (!e) return false
  const fieldsEqual = JSON.stringify(fieldObj(draft.fields)) === JSON.stringify(e.fields)
  const aliasesEqual = draft.aliases.trim() === e.aliases.join('、')
  return !fieldsEqual || !aliasesEqual || draft.name !== e.name || draft.body !== e.body
})

const groups = computed(() =>
  KIND_ORDER.map((k) => ({
    kind: k,
    label: KIND_LABEL[k],
    items: codexState.entries.filter((e) => e.kind === k && matchQuery(e))
  })).filter((g) => g.items.length)
)

function matchQuery(e: { name: string; aliases: string[]; body: string }): boolean {
  const q = codexState.query.trim().toLowerCase()
  if (!q) return true
  return (
    e.name.toLowerCase().includes(q) ||
    e.aliases.join(' ').toLowerCase().includes(q) ||
    e.body.toLowerCase().includes(q)
  )
}

function fieldObj(rows: FieldRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.k.trim()) out[r.k.trim()] = r.v.trim()
  return out
}

watch(
  () => state.ref,
  () => {
    ensureCodex(true)
    // 换作品要重读大纲：上一部的大纲留着会把设定带偏（切换作品后状态残留是这个项目的老毛病）
    loadOutline()
  },
  { immediate: true }
)

watch(selected, (e) => {
  if (!e) {
    draft.name = ''
    draft.aliases = ''
    draft.fields = []
    draft.body = ''
    refs.value = []
    gap.value = null
    return
  }
  draft.name = e.name
  draft.aliases = e.aliases.join('、')
  draft.fields = Object.entries(e.fields).map(([k, v]) => ({ k, v }))
  draft.body = e.body
  loadInsight(e)
})

async function loadInsight(e: { name: string; aliases: string[]; id: string }) {
  if (!state.ref) return
  const bodies = await ensureBodies()
  const keys = [e.name, ...e.aliases]
  const index = buildRefIndex(orderedChapters.value, bodies, keys)
  const hits: RefHit[] = []
  for (const k of keys) hits.push(...(index.get(k) || []))
  refs.value = hits.sort((a, b) => a.pos - b.pos)
  const entry = codexState.entries.find((x) => x.id === e.id)
  if (entry) {
    const p = presenceStats([entry], orderedChapters.value, bodies)[0]
    gap.value = { total: p.total, lastChapter: p.lastChapter, gapFromEnd: p.gapFromEnd }
  }
}

function pick(id: string) {
  codexState.selectedId = id
}

/** 整夹导入：设定本来就在别的文件夹里的作者，选一次目录就全进来 */
async function onImportFolder() {
  if (!state.ref) {
    msg.value = '先打开一部作品再导入。'
    return
  }
  const d = await fs().pickDir('选择设定所在的文件夹（会复制到 设定/ 下）')
  if (!d) return
  busy.value = true
  msg.value = ''
  try {
    const { copied, skipped } = await importSettingFolder(state.ref, d)
    await refreshCodex()
    msg.value = `导入 ${copied} 个文件${skipped ? `，跳过 ${skipped} 个同名（不覆盖）` : ''}`
  } catch (e: any) {
    msg.value = `导入失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

function reloadInsight() {
  const e = selected.value
  if (e) loadInsight(e)
}

/* ------------------------------------------------------------------ AI 生成设定 */

/** 可生成的类型与中文标签（与 core/worldbuild.ts 的 GEN_KIND_LABEL 对齐） */
const GEN_KINDS: Array<{ k: SettingGenKind; label: string }> = [
  { k: 'character', label: '人物' },
  { k: 'location', label: '地点' },
  { k: 'organization', label: '组织/势力' },
  { k: 'item', label: '道具' },
  { k: 'race', label: '种族/生物' },
  { k: 'lore', label: '世界观规则' }
]

const genOpen = ref(false)
const genBusy = ref(false)
const genMsg = ref('')
const genKinds = ref<SettingGenKind[]>(['character'])
const genPer = ref(3)
const genMaterial = ref('')

/** 本次生成实际会带上的标签（作者上次在大纲面板点的那串，见 rememberTags） */
const genTags = computed(() => savedTags())

/**
 * 读作品现有的大纲。
 *
 * 只读**不解析** —— 模型看得懂 Markdown，压成骨架反而丢信息。
 * 落点有两个：软件自己写的 `大纲/剧情大纲.md`，和作者手写的
 * `剧情大纲.md` / `全书*.md`（导入大纲时落在这些名字上）。两个都试，
 * 谁有内容用谁，这样「作者自己写的稿子」不会被空模板压过去。
 */
async function loadOutline() {
  genOutline.value = ''
  genOutlineName.value = ''
  genOutlineErr.value = ''
  if (!state.ref) return
  /* 先扫目录、再按优先级试：作者手写的「剧情大纲 / 全书」排在软件生成的
     「大纲.md」前面 —— 前者信息更多，且不会被新建作品时的空模板压过去。 */
  let names: string[] = []
  try {
    names = (await fs().listDir(state.ref, ['大纲']))
      .filter((e) => e.kind === 'file' && /\.(md|txt)$/i.test(e.name))
      .map((e) => e.name)
  } catch {
    /* 还没有 大纲/ 目录 */
  }
  const rank = (n: string) => (n.includes('剧情大纲') || n.includes('全书') ? 0 : n === '大纲.md' ? 1 : 2)
  const ordered = [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const name of ordered) {
    try {
      const text = condenseOutline(await fs().readFile(state.ref, ['大纲', name]))
      if (text.trim()) {
        genOutline.value = text
        genOutlineName.value = `大纲/${name}`
        return
      }
    } catch {
      /* 读不到就试下一个 */
    }
  }
  genOutlineErr.value = '还没读到大纲 —— 先去「大纲」面板生成或导入，AI 才能让设定跟故事对上。'
}

/**
 * 让 AI 生成设定。
 *
 * 输入综合三样：**大纲**（故事走向）+ **作品标签**（题材调性）+ 作者粘的材料。
 * 产出**先落候选区**（和所有 AI 功能一条规矩）：候选那边能预览、能删，
 * 作者确认后才点「写入设定库」。所以这里只负责拼提示词、发请求、说一句结果。
 */
async function onGenerate() {
  if (!state.ref || !genKinds.value.length) return
  genBusy.value = true
  genMsg.value = '生成中…'
  try {
    const out = await generate({
      mode: 'setting',
      instruction: settingGenPrompt({
        title: state.info.title || '',
        brief: state.info.brief || '',
        // 标签不落盘，是「大纲 → AI 推荐」那边记住的；作者没选过就是空串，
        // 提示词里会退化成「按想法与材料自行判断」。
        tags: genTags.value,
        outline: genOutline.value,
        material: genMaterial.value,
        existing: codexState.entries.map((e) => e.name),
        kinds: genKinds.value,
        perKind: genPer.value
      }),
      n: 1
    })
    setDockTab('candidate')
    genMsg.value = out.length ? '设定稿已进「候选」——看过再点采纳' : '没有生成候选'
  } catch (e: any) {
    genMsg.value = `生成失败：${e?.message || e}`
  } finally {
    genBusy.value = false
  }
}

async function onCreate() {
  const name = newName.value.trim()
  if (!name) return
  busy.value = true
  msg.value = ''
  try {
    await addEntry(newKind.value, name, { body: defaultBody(newKind.value, name) })
    msg.value = `已创建 设定/${KIND_LABEL[newKind.value]}/${name}.md`
    newName.value = ''
    creating.value = false
  } catch (e: any) {
    msg.value = `创建失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

async function onSave() {
  const e = selected.value
  if (!e) return
  busy.value = true
  msg.value = ''
  try {
    await saveEntry(e.id, {
      name: draft.name,
      aliases: draft.aliases.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
      fields: fieldObj(draft.fields),
      body: draft.body
    })
    msg.value = '已写回文件'
  } catch (err: any) {
    msg.value = `保存失败：${err?.message || err}`
  } finally {
    busy.value = false
  }
}

async function onDelete() {
  const e = selected.value
  if (!e) return
  const ok = await askConfirm({
    title: `删除设定「${e.name}」`,
    message: '这条设定会从作品的「设定」目录里移除。',
    detail: [`文件：${e.id}`, '若有章节还链着它，链接会变成找不到的状态'],
    okText: '删除',
    danger: true
  })
  if (!ok) return
  await removeEntry(e.id)
  msg.value = '已删除'
}

function addField() {
  draft.fields.push({ k: '', v: '' })
}
function dropField(i: number) {
  draft.fields.splice(i, 1)
}
</script>

<template>
  <div class="codex">
    <div class="spread">
      <b class="tt">设定库</b>
      <div class="row">
        <button class="text small" @click="refreshCodex()">刷新</button>
        <button class="text small" :disabled="busy" @click="onImportFolder">导入文件夹</button>
        <button class="text small" @click="creating = !creating">{{ creating ? '取消' : '+ 新建' }}</button>
      </div>
    </div>

    <!-- AI 生成设定：只在配了 AI 时出现（纯离线作者不该看见点不通的按钮） -->
    <div v-if="aiEnabled()" class="gen">
      <div class="spread">
        <button class="text small" @click="genOpen = !genOpen">
          {{ genOpen ? '收起 AI 生成' : '✦ 让 AI 生成设定' }}
        </button>
        <span v-if="genMsg" class="small dim">{{ genMsg }}</span>
      </div>
      <div v-if="genOpen" class="gen-body">
        <div class="row small wrap">
          <label v-for="k in GEN_KINDS" :key="k.k" class="chip-in">
            <input type="checkbox" :value="k.k" v-model="genKinds" />
            {{ k.label }}
          </label>
        </div>
        <div class="row small">
          <span class="dim">每类</span>
          <input v-model.number="genPer" type="number" min="1" max="12" style="width: 64px" />
          <span class="dim">条</span>
          <button class="primary small" :disabled="genBusy || !genKinds.length" @click="onGenerate">
            {{ genBusy ? '生成中…' : '生成' }}
          </button>
        </div>

        <!-- 把「AI 实际会看到的输入」摊开，作者不用猜 -->
        <div class="seen small">
          <div class="spread">
            <span class="dim">大纲：</span>
            <span class="row">
              <b v-if="genOutlineName">{{ genOutlineName }} · {{ genOutline.length.toLocaleString() }} 字</b>
              <span v-else class="dim">{{ genOutlineErr || '读取中…' }}</span>
              <button class="text small" @click="loadOutline">重读</button>
            </span>
          </div>
          <div class="spread">
            <span class="dim">标签：</span>
            <b v-if="genTags">{{ genTags }}</b>
            <span v-else class="dim">没选过 —— 去「大纲 → AI 推荐」点几个，这里就有了</span>
          </div>
        </div>

        <textarea
          v-model="genMaterial"
          rows="3"
          placeholder="可选：再补一点世界观 / 已有设定（AI 当作事实来源，不会跟它矛盾）"
        ></textarea>
      </div>
    </div>

    <div v-if="creating" class="create">
      <div class="row">
        <select v-model="newKind">
          <option v-for="k in KIND_ORDER" :key="k" :value="k">{{ KIND_LABEL[k] }}</option>
        </select>
        <input v-model="newName" placeholder="名称，如 云杉" @keydown.enter="onCreate" />
      </div>
      <button class="primary small" :disabled="busy || !newName.trim()" @click="onCreate">创建并按模板展开</button>
    </div>

    <input v-model="codexState.query" placeholder="搜索名称 / 别名 / 正文" />

    <div class="list">
      <div v-if="!codexState.loaded" class="small dim pad">读取中…</div>
      <div v-else-if="!codexState.entries.length" class="small dim pad">
        「设定/」下还没有 md。上面点 + 新建，或者自己用记事本建都行。
      </div>
      <div v-for="g in groups" :key="g.kind" class="grp">
        <div class="grp-h small dim">{{ g.label }} · {{ g.items.length }}</div>
        <button
          v-for="e in g.items"
          :key="e.id"
          class="item text small"
          :class="{ on: e.id === codexState.selectedId }"
          @click="pick(e.id)"
        >
          <span class="nm">{{ e.name }}</span>
          <span class="dim">{{ e.wordCount }}字</span>
        </button>
      </div>
    </div>

    <template v-if="selected">
      <hr />
      <div class="detail">
        <div class="row">
          <input v-model="draft.name" placeholder="名称" />
          <input v-model="draft.aliases" placeholder="别名（逗号或顿号分隔）" />
        </div>

        <div class="fields">
          <div v-for="(f, i) in draft.fields" :key="i" class="row">
            <input v-model="f.k" placeholder="字段" />
            <input v-model="f.v" placeholder="值" />
            <button class="btn-icon" @click="dropField(i)">×</button>
          </div>
          <button class="text small" @click="addField">+ 字段</button>
        </div>

        <textarea v-model="draft.body" class="body-box small" spellcheck="false"></textarea>

        <div class="row">
          <button class="primary" :disabled="!dirty || busy" @click="onSave">保存</button>
          <button :disabled="busy" @click="onDelete">删除</button>
          <span class="small dim">{{ dirty ? '有改动' : '已同步' }}</span>
        </div>

        <div class="refs">
          <div class="spread">
            <b class="small">反向引用（{{ refs.length }}）</b>
            <button class="text small" @click="reloadInsight">重算</button>
          </div>
          <p class="small dim" v-if="gap">
            全书出现 {{ gap.total }} 次 · 上次出场第 {{ gap.lastChapter ?? '—' }} 章
            <span v-if="gap.gapFromEnd >= 8" class="tag warn">已断 {{ gap.gapFromEnd }} 章</span>
          </p>
          <div v-if="!refs.length" class="small dim">正文里还没有 [[{{ selected.name }}]] 或 @{{ selected.name }}。</div>
          <div v-for="(r, i) in refs" :key="i" class="ref">
            <div class="spread small">
              <span class="rt">{{ r.title }}</span>
              <span class="dim">{{ r.count }} 次</span>
            </div>
            <div class="snippet dim small">{{ r.snippet }}</div>
          </div>
        </div>
      </div>
    </template>

    <p v-if="msg" class="small dim">{{ msg }}</p>
  </div>
</template>

<style scoped>
.codex {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.create {
  border: 1px dashed var(--line);
  padding: 8px;
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gen {
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius);
  padding: 8px;
}
.gen-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.seen {
  border-top: 1px dashed var(--line-soft);
  padding-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gen-body textarea {
  min-height: 60px;
  resize: vertical;
}
.list {
  max-height: 32vh;
  overflow: auto;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
}
.pad {
  padding: 10px;
}
.grp-h {
  padding: 6px 8px 2px;
}
.item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 3px 8px;
}
.item.on {
  background: var(--accent-soft);
  color: var(--text);
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.body-box {
  min-height: 180px;
  resize: vertical;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.7;
}
.refs {
  border-top: 1px solid var(--line-soft);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ref {
  border-left: 2px solid var(--accent-soft);
  padding-left: 8px;
}
.rt {
  color: var(--text-soft);
}
.snippet {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
