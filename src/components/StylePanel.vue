<script setup lang="ts">
/**
 * 文风检查面板（Task #4 · 纯本地，不用 AI）
 * 左半：本章指标 vs 基线（其余章节）；右半（纵向）：命中清单，点一条跳到正文对应位置。
 */
import { computed, ref, watch } from 'vue'
import {
  ISSUE_LABEL,
  analyzeStyle,
  drift,
  driftFromBaseline,
  parseBaseline,
  serializeBaseline,
  toBaseline,
  type StyleBaseline,
  type StyleIssue
} from '@/core/style'
import { settings } from '@/core/settings'
import { readMemoryFile, writeMemoryFile } from '@/core/memory'
import { requestJump, setDockTab } from '@/stores/editor'
import { currentChapter, ensureBodies, orderedChapters, state } from '@/stores/workspace'
import { aiState, enabled as aiEnabled, pushStyleNotesCandidate, rawChat } from '@/stores/ai'
import { askConfirm } from '@/stores/dialog'
import {
  listStyleSamples,
  readStyleSample,
  readStyleNotes,
  removeStyleSample,
  sampleName,
  saveStyleSample,
  importStyleFile,
  parseStyleNotes,
  styleLearnPrompt,
  STYLE_SAMPLE_DIR,
  type StyleSample
} from '@/core/styleLearn'

const FILE_BASELINE = '文风基线.md'

const bannedText = ref(settings.style.bannedWords.join('\n'))
const showMetrics = ref(true)

const banned = computed(() =>
  bannedText.value
    .split(/[\n,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
)

const result = computed(() => {
  const text = state.content || ''
  const all = analyzeStyle(text, banned.value)
  const issues = settings.style.checkAiTone ? all.issues : all.issues.filter((i) => i.type !== 'ai-cliche' && i.type !== 'summary-tone')
  return { metrics: all.metrics, issues }
})

const baseline = ref<{ label: string; text: string } | null>(null)

/** 已存档基线（记忆/文风基线.md），优先于临时算出的对比样本 */
const archived = ref<StyleBaseline | null>(null)

/* ------------------------------------------------------------------ 文风学习（样本库）
   注意：下面这些 ref 必须声明在 `watch(..., loadAll, { immediate: true })` **之前** ——
   immediate 的 watch 在 setup 期同步执行 loadAll，碰到还没初始化的 const 就是
   TDZ（生产构建压缩后是单字母变量，整个面板白屏），typecheck 看不出来。 */
const samples = ref<StyleSample[]>([])
/** 勾上的样本 = 会进上下文的那批；同时也是「让 AI 学」的输入 */
const picked = ref<string[]>([])
const pasted = ref('')
const pasteName = ref('')
const learnInstruction = ref('')
const learnMsg = ref('')
const busy = ref(false)
/** 记忆/文风要点.md 的现有内容（AI 学过之后会写在这里） */
const styleNotes = ref('')
const fileEl = ref<HTMLInputElement | null>(null)

const baselineMetrics = computed(() => {
  if (!baseline.value?.text) return null
  return analyzeStyle(baseline.value.text).metrics
})

const compare = computed(() => {
  if (archived.value) return driftFromBaseline(archived.value, result.value.metrics)
  if (baselineMetrics.value) return drift(baselineMetrics.value, result.value.metrics)
  return null
})

const compareSource = computed(() => (archived.value ? `已存档基线（${archived.value.chars} 字样本）` : baseline.value?.label || ''))

const grouped = computed(() => {
  const m = new Map<string, StyleIssue[]>()
  for (const i of result.value.issues) {
    const arr = m.get(i.type) || []
    arr.push(i)
    m.set(i.type, arr)
  }
  return [...m.entries()].map(([type, list]) => ({ type, list }))
})

async function buildBaseline() {
  if (!state.ref) return
  await ensureBodies()
  const others = orderedChapters.value.filter((c) => c.id !== state.currentId)
  const useAll = settings.style.baseline === 'all'
  const picked = useAll ? orderedChapters.value : others
  const text = picked.map((c) => state.bodies[c.id] || '').join('\n\n')
  baseline.value = { label: useAll ? '全书' : `其余 ${picked.length} 章`, text }
}

watch([() => state.ref, () => settings.style.baseline], loadAll, { immediate: true })

async function loadAll() {
  if (!state.ref) return
  archived.value = parseBaseline(await readMemoryFile(state.ref, FILE_BASELINE))
  await buildBaseline()
  samples.value = await listStyleSamples(state.ref)
  // 上回勾过、而且文件还在的，继续勾着（文件被删了就别留个幽灵勾选）
  picked.value = (aiState.buildOpts.styleSampleFiles || []).filter((f) => samples.value.some((s) => s.file === f))
  aiState.buildOpts.styleSampleFiles = [...picked.value]
  styleNotes.value = await readStyleNotes(state.ref)
}

/* ------------------------------------------------------------------ 样本库操作 */

function togglePick(file: string, on: boolean) {
  picked.value = on ? [...new Set([...picked.value, file])] : picked.value.filter((f) => f !== file)
  // 上下文装配读的就是这个字段，勾完立刻生效（每次生成都会重新装配）
  aiState.buildOpts.styleSampleFiles = [...picked.value]
}

async function saveAsSample(rawName: string, text: string, warnings: string[] = []) {
  if (!state.ref) return
  const s = await saveStyleSample(state.ref, rawName, text)
  samples.value = await listStyleSamples(state.ref)
  if (s.chars < 200) warnings = [...warnings, `样本只有 ${s.chars} 字，AI 学不出什么（建议 500 字以上）。`]
  learnMsg.value = warnings.length
    ? warnings.join(' ')
    : `已存为「${s.name}」（${s.chars} 字），勾上它再让 AI 学。`
  togglePick(s.file, true)
}

async function onPickFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = '' // 清掉，否则同一个文件再选一次不触发 change
  if (!f) return
  learnMsg.value = `正在读 ${f.name} …`
  try {
    const r = await importStyleFile(f.name, await f.arrayBuffer())
    if (!r.text.trim()) {
      learnMsg.value = r.warnings[0] || '这个文件里没读到文字。'
      return
    }
    await saveAsSample(r.name || f.name, r.text, r.warnings)
  } catch (err: any) {
    learnMsg.value = `导入失败：${err?.message || err}`
  }
}

async function savePasted() {
  const t = pasted.value.trim()
  if (!t) return
  const name = pasteName.value.trim() || `粘贴样本 ${samples.value.length + 1}`
  await saveAsSample(name, t)
  pasted.value = ''
  pasteName.value = ''
}

async function delSample(s: StyleSample) {
  if (!state.ref) return
  const okDel = await askConfirm({
    title: `删除样本「${s.name}」`,
    message: `会删掉 记忆/文风样本/${s.file}。这是你自己存进作品目录的文件，删了就没了。`,
    detail: [`${s.chars} 字`, '只是不想让它进上下文的话，取消勾选就行，不用删'],
    okText: '删除',
    danger: true
  })
  if (!okDel) return
  await removeStyleSample(state.ref, s.file)
  samples.value = await listStyleSamples(state.ref)
  togglePick(s.file, false)
  learnMsg.value = ''
}

/** 让 AI 从勾上的样本里归纳文风要点 —— 产出进候选区，作者点采纳才落到 记忆/文风要点.md */
async function runLearn() {
  if (!state.ref || busy.value) return
  if (!picked.value.length) {
    learnMsg.value = '先勾上至少一份样本，AI 才有东西可学。'
    return
  }
  busy.value = true
  learnMsg.value = ''
  try {
    const list: Array<{ name: string; text: string }> = []
    for (const f of picked.value) {
      const text = await readStyleSample(state.ref, f)
      if (text.trim()) list.push({ name: sampleName(f), text })
    }
    if (!list.length) {
      learnMsg.value = '勾上的样本都是空的。'
      return
    }
    const out = await rawChat(
      '你是中文网络小说的文风分析师。只输出可执行的规则，不复述情节，不寒暄，不要开场白。',
      styleLearnPrompt(list, learnInstruction.value.trim())
    )
    const notes = parseStyleNotes(out)
    if (!notes) {
      // 模型没吐内容也要说清楚，不能静默 —— 作者会以为「学完了」
      learnMsg.value = 'AI 这次没给出可用的要点（多半是样本太短，或它只是回答了一句话）。'
      return
    }
    pushStyleNotesCandidate(notes)
    setDockTab('candidate')
    learnMsg.value = '要点已放进候选区 —— 看过再点「写入 记忆/文风要点.md」，之后每次生成都会带上。'
  } catch (e: any) {
    learnMsg.value = `让 AI 学失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}

/** 用当前全文重算基线并存档到 记忆/文风基线.md（作者可手工改） */
async function archiveBaseline() {
  if (!state.ref) return
  await ensureBodies()
  const text = orderedChapters.value.map((c) => state.bodies[c.id] || '').join('\n\n')
  if (!text.trim()) return
  const b = toBaseline(analyzeStyle(text).metrics)
  await writeMemoryFile(state.ref, FILE_BASELINE, serializeBaseline(b))
  archived.value = b
}

function jump(i: StyleIssue) {
  if (!currentChapter.value) return
  requestJump(currentChapter.value.id, i.pos, i.text)
}
</script>

<template>
  <div class="st">
    <div class="spread">
      <b class="tt">文风 / 去 AI 味</b>
      <select v-model="settings.style.baseline">
        <option value="others">基线＝其余章节</option>
        <option value="all">基线＝全书</option>
      </select>
    </div>

    <!-- 文风学习：作者给材料 → AI 归纳成能照着做的规则。
         样本存在作品目录里（记忆/文风样本/），不是数据库里的黑盒；
         AI 归纳出的要点先进候选区，作者点了采纳才写进 记忆/文风要点.md。 -->
    <div class="learn">
      <div class="spread">
        <b class="small">让 AI 学我的文风</b>
        <span class="small dim">样本存 记忆/{{ STYLE_SAMPLE_DIR[1] }}/</span>
      </div>
      <p class="small dim lh">
        导入或粘贴你想学的味道（自己的旧稿、参考书都行）。勾上的样本会进上下文，
        再让 AI 归纳成「要怎么做 / 不要怎么做」的要点。
      </p>

      <div class="row">
        <button class="text small" @click="fileEl?.click()">导入文件…</button>
        <span class="small dim">.docx / .pdf / .txt / .md</span>
        <input
          ref="fileEl"
          type="file"
          accept=".docx,.pdf,.txt,.md,text/markdown,text/plain"
          class="hidden-file"
          @change="onPickFile"
        />
      </div>

      <textarea
        v-model="pasted"
        rows="3"
        class="paste"
        spellcheck="false"
        placeholder="把想让 AI 学的文字粘在这里（建议 500 字以上，太少学不出东西）"
      ></textarea>
      <div class="row">
        <input v-model="pasteName" class="nm-input" placeholder="样本名，例如：旧稿·雨夜" />
        <button :disabled="!pasted.trim()" @click="savePasted">存为样本</button>
      </div>

      <div v-if="samples.length" class="samples">
        <div v-for="s in samples" :key="s.file" class="srow">
          <input type="checkbox" :checked="picked.includes(s.file)" @change="togglePick(s.file, ($event.target as any).checked)" />
          <span class="sname">{{ s.name }}</span>
          <span class="small dim nowrap">{{ s.chars }} 字</span>
          <button class="btn-icon danger small" title="删除这份样本（会删掉作品目录里的文件）" @click="delSample(s)">✕</button>
        </div>
      </div>
      <p v-else class="small dim">还没有样本 —— 导入一个文件，或粘一段文字。</p>

      <textarea
        v-model="learnInstruction"
        rows="2"
        spellcheck="false"
        placeholder="给 AI 的额外要求（可留空）：例如「对话要短，少用形容词，禁止大段心理独白」"
      ></textarea>
      <div class="row">
        <button class="primary" :disabled="busy || !aiEnabled || !picked.length" @click="runLearn">
          {{ busy ? 'AI 在学…' : '让 AI 学并出要点' }}
        </button>
        <button class="text small" @click="setDockTab('candidate')">去看候选区</button>
      </div>
      <div v-if="!aiEnabled" class="small dim">未配置 API —— 样本可以先存着，配好之后再来学。</div>
      <div v-if="learnMsg" class="small warn-text lh">{{ learnMsg }}</div>
      <div v-if="styleNotes" class="small dim lh">
        已有要点（记忆/文风要点.md，{{ styleNotes.length }} 字）—— 之后每次生成都会带上它。
      </div>
    </div>

    <div v-if="result.metrics.chars" class="metrics">
      <div class="kv small"><span class="dim">字数</span><b>{{ result.metrics.chars }}</b></div>
      <div class="kv small"><span class="dim">平均句长</span><b>{{ result.metrics.avgSentence }} 字</b></div>
      <div class="kv small"><span class="dim">最长句</span><b>{{ result.metrics.maxSentence }} 字</b></div>
      <div class="kv small"><span class="dim">对话占比</span><b>{{ result.metrics.dialogueRatio }}%</b></div>
      <div class="kv small"><span class="dim">段落数</span><b>{{ result.metrics.paragraphCount }}</b></div>
      <div class="kv small"><span class="dim">平均段落</span><b>{{ result.metrics.avgParagraph }} 字</b></div>
    </div>
    <p v-else class="small dim">本章还没有正文。</p>

    <div class="row">
      <button class="text small" @click="archiveBaseline">重算并存档基线</button>
      <span class="small dim">存到 记忆/{{ FILE_BASELINE }}</span>
    </div>

    <div v-if="compare && compare.notes.length" class="drift">
      <div class="spread small">
        <span>与{{ compareSource }}偏离度 <b>{{ compare.score }}</b>/100</span>
      </div>
      <div v-for="(n, i) in compare.notes" :key="i" class="small dim">{{ n }}</div>
    </div>
    <p v-else class="small dim">暂无基线对比（存一份基线，或先写几章）。</p>

    <div v-if="archived" class="detail small">
      <div class="row">
        <span class="tag info">指纹</span>
        <span class="dim">{{ archived.topWords.slice(0, 12).join('、') || '样本不足' }}</span>
      </div>
      <div class="dim">
        基线：句长 {{ archived.avgSentence }} 字 · 对话 {{ archived.dialogueRatio }}% · 段落 {{ archived.avgParagraph }} 字
      </div>
    </div>

    <div v-if="showMetrics && result.metrics.topWords.length" class="detail small">
      <div class="dim">高频词</div>
      <div class="chips">
        <span v-for="w in result.metrics.topWords.slice(0, 14)" :key="w.w" class="tag">{{ w.w }}·{{ w.n }}</span>
      </div>
      <div v-if="result.metrics.idiomHits.length" class="dim">重复四字片段：{{ result.metrics.idiomHits.join(' / ') }}</div>
    </div>

    <hr />

    <div class="spread">
      <b class="small">命中清单（{{ result.issues.length }}）</b>
      <button class="text small" @click="showMetrics = !showMetrics">{{ showMetrics ? '收起指标' : '展开指标' }}</button>
    </div>

    <div v-for="g in grouped" :key="g.type" class="grp">
      <div class="grp-h small">
        <span class="tag" :class="g.type === 'banned' ? 'warn' : 'info'">{{ ISSUE_LABEL[g.type as keyof typeof ISSUE_LABEL] }}</span>
        <span class="dim">{{ g.list.length }} 处</span>
      </div>
      <div v-for="(i, k) in g.list.slice(0, 30)" :key="k" class="hit" @click="jump(i)">
        <div class="hit-t small">{{ i.text }}</div>
        <div class="dim small ctx">{{ i.context }}</div>
        <div class="small dim hint">{{ i.hint }}</div>
      </div>
    </div>
    <p v-if="!result.issues.length" class="small dim">没检出明显的 AI 腔 / 重复结构。</p>

    <details>
      <summary class="small dim">禁用词表（每行一个，作者自定义）</summary>
      <textarea v-model="bannedText" class="banned" rows="5" spellcheck="false" @change="settings.style.bannedWords = banned"></textarea>
    </details>
  </div>
</template>

<style scoped>
.st {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 10px;
}
.kv {
  display: flex;
  justify-content: space-between;
}
.learn {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-panel);
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lh {
  line-height: 1.6;
  margin: 0;
}
.hidden-file {
  display: none;
}
.paste,
.learn textarea {
  width: 100%;
  font-family: inherit;
}
/* 样本名那一行：输入框要能伸缩，别写死高度（13px 汉字要 17px 行高，
   写死高度会把字削掉 —— 作者报过「第X章」的「章」被削成「音」） */
.nm-input {
  flex: 1 1 auto;
  min-width: 0;
}
.samples {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 22vh;
  overflow: auto;
}
.srow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.drift {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 6px 8px;
  background: var(--bg-panel);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 0 6px;
}
.grp {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.grp-h {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
}
.hit {
  border-left: 2px solid var(--accent-soft);
  padding: 2px 0 2px 8px;
  cursor: pointer;
}
.hit:hover {
  background: var(--bg-soft);
}
.hit-t {
  color: var(--text);
}
.ctx,
.hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.banned {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  margin-top: 6px;
}
</style>
