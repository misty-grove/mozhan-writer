<script setup lang="ts">
/**
 * AI 指令对话框（生成 / 扩写共用）
 *
 * 为什么不是面板里那个两行输入框：
 * 作者真要下指令的时候，两行根本不够 —— 得说清「扩写哪一段、往哪个方向扩、
 * 加多少字、哪些东西不许动」。挤在两行里，最后就变成一句「写得详细点」，
 * 模型照着发挥，出来的东西不是作者要的。
 *
 * 所以这里给一整个对话框：模式 + 大指令框 + 目标字数 + 候选个数 + 技能，
 * 并且**把「这次到底对哪段文字动手」明写出来**（选区字数 or 本章最后一段 or 整章）。
 * AI 不知道你指的是哪一段，是最常见的一类翻车。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { aiState, generate } from '@/stores/ai'
import { selectedText, setDockTab } from '@/stores/editor'
import { currentChapter, saveNow, state } from '@/stores/workspace'

const emit = defineEmits<{ (e: 'close'): void }>()

type Mode = 'continue' | 'generate' | 'expand' | 'rewrite' | 'shrink' | 'tone' | 'fix'

const MODES: Array<{ v: Mode; label: string }> = [
  { v: 'continue', label: '续写' },
  { v: 'generate', label: '生成' },
  { v: 'expand', label: '扩写' },
  { v: 'rewrite', label: '局部重写' },
  { v: 'shrink', label: '缩写' },
  { v: 'tone', label: '改语气' },
  { v: 'fix', label: '纠错' }
]
/** 动的是「选中的那一段」的模式 */
const SEL_MODES: Mode[] = ['expand', 'rewrite', 'shrink', 'tone', 'fix']
/** 一次能出多个候选的模式 */
const MULTI_MODES: Mode[] = ['continue', 'generate']

const mode = ref<Mode>('expand')
const instruction = ref('')
const targetChars = ref(0)
const candidates = ref(2)
const tip = ref('')

const needSel = computed(() => SEL_MODES.includes(mode.value))
const sel = computed(() => selectedText.value || '')

/**
 * 「这次对哪段文字动手」—— 必须算给作者看，不能让 AI 猜。
 * 扩写没有选区时退化成本章最后一段（这是作者最常想要的），
 * 但**要说出来**：静默换目标是 bug 的经典形态。
 */
const lastParagraph = computed(() => {
  const ps = (state.content || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
  return ps.length ? ps[ps.length - 1] : ''
})

const scopeText = computed(() => {
  if (!needSel.value) {
    return mode.value === 'generate'
      ? '从零写一段新正文（不接现有结尾，不复述已有情节）'
      : '接本章现有结尾往下写'
  }
  if (sel.value) return `正文里选中的那 ${sel.value.length} 字`
  if (mode.value === 'fix') return `没有选区 —— 将对整章（${state.content.length} 字）做校对`
  if (mode.value === 'expand') {
    return lastParagraph.value
      ? `没有选区 —— 将对**本章最后一段**（${lastParagraph.value.length} 字）扩写`
      : '没有选区，本章也还没有正文 —— 请先在正文里选中一段'
  }
  return '这一项需要对选中的文字做处理，请先在正文里选中一段'
})

const canRun = computed(() => {
  if (aiState.generating) return false
  if (!needSel.value) return true
  if (sel.value) return true
  if (mode.value === 'fix') return !!state.content.trim()
  if (mode.value === 'expand') return !!lastParagraph.value
  return false
})

/** 目标字数写进指令里：只写「约 N 字」，不替作者编别的 */
function composedInstruction(): string {
  const base = instruction.value.trim()
  const n = Number(targetChars.value) || 0
  if (n <= 0) return base
  return `${base ? base + '\n' : ''}目标字数：约 ${n} 字。`
}

async function run() {
  if (!currentChapter.value || !canRun.value) return
  tip.value = ''
  await saveNow()
  let text = ''
  let whole = false
  if (needSel.value) {
    if (sel.value) text = sel.value
    else if (mode.value === 'fix') {
      whole = true
      text = state.content
    } else if (mode.value === 'expand') text = lastParagraph.value
    else {
      tip.value = '请先在正文里选中一段文字。'
      return
    }
  }
  await generate({
    mode: mode.value,
    skill: aiState.selectedSkill,
    instruction: composedInstruction(),
    n: MULTI_MODES.includes(mode.value) ? candidates.value : 1,
    selection: text,
    wholeChapter: whole
  })
  setDockTab('candidate')
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <b>给 AI 下指令</b>
        <button class="btn-icon" title="关闭（Esc）" @click="emit('close')">×</button>
      </div>

      <div class="body col">
        <div class="row">
          <span class="dim small nowrap">做什么</span>
          <select v-model="mode" class="mode-sel">
            <option v-for="m in MODES" :key="m.v" :value="m.v">{{ m.label }}</option>
          </select>
          <select v-model="aiState.selectedSkill" class="skill-sel" title="给这次任务挂一个技能">
            <option value="">不使用技能</option>
            <option v-for="s in aiState.skills.filter((x) => x.enabled)" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
        </div>

        <div class="scope-box small">
          <span class="tag info">动哪一段</span>
          <span>{{ scopeText }}</span>
        </div>

        <textarea
          ref="area"
          v-model="instruction"
          class="ins"
          rows="8"
          spellcheck="false"
          placeholder="写清楚你要什么。例如：

把这段扩写到 800 字左右，只加环境与动作细节，不加新人物、不提前透露身份；
对话保持短促，引号用中文双引号。"
        ></textarea>

        <div class="row small">
          <label class="nowrap" title="写进指令里，让模型有个长度概念；0 = 不限制">
            目标字数<input v-model.number="targetChars" type="number" min="0" step="100" class="num" />
          </label>
          <label v-if="MULTI_MODES.includes(mode)" class="nowrap">
            候选个数<input v-model.number="candidates" type="number" min="1" max="4" class="num" />
          </label>
        </div>

        <div v-if="tip" class="small warn-text">{{ tip }}</div>
        <div v-if="aiState.error" class="small err">{{ aiState.error }}</div>
      </div>

      <div class="spread foot">
        <span class="small dim">产出先进候选区，你点了采纳才会写进正文</span>
        <div class="row">
          <button @click="emit('close')">取消</button>
          <button class="primary" :disabled="!canRun || aiState.generating" @click="run">
            {{ aiState.generating ? '生成中…' : '生成并放入候选区' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  padding: 16px;
}
.dialog {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  width: min(680px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-pop);
}
.head {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
}
.body {
  padding: 12px;
  gap: 8px;
  overflow: auto;
}
.col {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 下拉不许写死高度（字会被削），用 flex 让它跟同行控件自然对齐 */
.mode-sel {
  flex: 0 0 auto;
  min-width: 96px;
}
.skill-sel {
  flex: 1 1 auto;
  min-width: 0;
}
.scope-box {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--bg-panel);
  line-height: 1.6;
}
.ins {
  width: 100%;
  font-family: inherit;
  line-height: 1.7;
}
.num {
  width: 72px;
}
.foot {
  padding: 10px 12px;
  border-top: 1px solid var(--line-soft);
  gap: 10px;
  flex-wrap: wrap;
}
.err {
  color: var(--danger);
}
</style>
