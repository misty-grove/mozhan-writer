<script setup lang="ts">
/**
 * 翻译对话框：把正文翻成 中文 / English / 日本語。
 *
 * 三个刻意的设计：
 *  - **语言只有三个**。作者要的就是这三国语言，先做扎实；
 *    给一个「自动识别源语言」的提示，但不给一个下拉里塞二十种语言（选了也用不上）。
 *  - **先报代价再动手**。开翻之前就把「多少字、要分几块」摊出来 ——
 *    翻译是要花钱和时间的，作者不该点下去才知道。
 *  - **不动作者的原稿**。落点是候选区，作者在候选区决定「存为新章节」还是「存为 md」。
 *    这里刻意不给「把译文写回原章」这条路：译错了还能改，原稿被盖掉就找不回来了。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { currentChapter, ensureBodies, orderedChapters, saveNow, state } from '@/stores/workspace'
import { cancelTranslate, runTranslate, translateState } from '@/stores/translate'
import { enabled as aiEnabled } from '@/stores/ai'
import { TRANS_LANGS, chunkCount, detectLang, langLabel, type LangCode } from '@/core/translate'
import { countWords } from '@/core/util'
import { setDockTab } from '@/stores/editor'

const emit = defineEmits<{ (e: 'close'): void }>()

/** 'current' = 当前章；'all' = 全书逐章 */
const scope = ref<'current' | 'all'>('current')
const to = ref<LangCode>('en')
const keepNames = ref(true)
const glossary = ref('')
const instruction = ref('')
const notice = ref('')

const canRun = computed(() => aiEnabled.value && !translateState.busy && estimate.value.chars > 0)

/** 开翻之前先算清楚：哪几章、多少字、要分几块 */
const estimate = computed(() => {
  if (scope.value === 'current') {
    const t = state.content || ''
    return { chapters: currentChapter.value ? 1 : 0, chars: countWords(t), chunks: chunkCount(t) }
  }
  const n = orderedChapters.value.length
  let chars = 0
  let chunks = 0
  for (const c of orderedChapters.value) {
    const t = state.bodies[c.id] || ''
    chars += countWords(t)
    chunks += chunkCount(t)
  }
  return { chapters: n, chars, chunks }
})

/** 源语言是猜的（只给作者一个参考，猜错了他在界面上也改不了，但提示词里会照用） */
const fromGuess = computed(() => detectLang(state.content || ''))

// 「全书」要先读一遍正文才报得出字数与块数 —— 不读的话 estimate 会是 0，
// 作者点下去才发现原来这么大。切到全书那一档时才读，当前章不牵连全书 I/O。
watch(scope, (v) => {
  if (v === 'all') ensureBodies()
})

/** 全书模式下每一章都要读一遍正文，先算个数给作者看 */
const scopeHint = computed(() =>
  scope.value === 'all'
    ? `全书 ${estimate.value.chapters} 章，逐章翻（可随时停，已翻完的照样进候选区）`
    : `当前章：${currentChapter.value?.title || '—'}`
)

async function run() {
  if (!canRun.value) return
  notice.value = ''
  // 先落盘再读：自动保存是防抖的，不落盘会把刚写的几段漏在译文外面
  await saveNow()
  const list =
    scope.value === 'current'
      ? currentChapter.value
        ? [{ id: currentChapter.value.id, title: currentChapter.value.title, text: state.content || '' }]
        : []
      : await ensureBodies(true).then((bodies) =>
          orderedChapters.value.map((c) => ({ id: c.id, title: c.title, text: bodies[c.id] || '' }))
        )
  if (!list.length) {
    notice.value = '没有可翻的正文。'
    return
  }
  const res = await runTranslate({
    to: to.value,
    chapters: list,
    opts: { keepNames: keepNames.value, glossary: glossary.value.trim(), instruction: instruction.value.trim(), from: fromGuess.value || undefined }
  })
  if (translateState.error) notice.value = translateState.error
  else if (translateState.summary) notice.value = translateState.summary
  if (res.done.length) {
    setDockTab('candidate')
    emit('close')
  }
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
        <b>翻译正文</b>
        <button class="btn-icon" title="关闭（Esc）" @click="emit('close')">×</button>
      </div>

      <div class="body col">
        <div class="row">
          <span class="dim small nowrap">翻成</span>
          <button
            v-for="l in TRANS_LANGS"
            :key="l.k"
            class="chip"
            :class="{ on: to === l.k }"
            :title="l.hint"
            @click="to = l.k"
          >
            {{ l.label }}
          </button>
        </div>

        <div class="row">
          <span class="dim small nowrap">翻哪一段</span>
          <button class="chip" :class="{ on: scope === 'current' }" @click="scope = 'current'">当前章</button>
          <button class="chip" :class="{ on: scope === 'all' }" @click="scope = 'all'">全书</button>
        </div>
        <div class="small dim">{{ scopeHint }}</div>

        <div class="scope-box small">
          <span class="tag info">翻什么</span>
          <span>
            {{ estimate.chapters }} 章 · 约 {{ estimate.chars }} 字 · 分 {{ estimate.chunks }} 块
            <template v-if="fromGuess"> · 识别为{{ langLabel(fromGuess) }}</template>
          </span>
        </div>

        <label class="row small">
          <input v-model="keepNames" type="checkbox" style="width: auto" />
          <span>人名 / 地名 / 专有名词保留原文写法（不音译、不另起名）</span>
        </label>

        <textarea
          v-model="glossary"
          rows="2"
          spellcheck="false"
          placeholder="术语对照（可留空）。每行一条：原文 = 译文
例如：林越 = Lin Yue"
        ></textarea>
        <textarea
          v-model="instruction"
          rows="2"
          spellcheck="false"
          placeholder="补充要求（可留空）。例如：对话要口语化，保留原文的短句节奏"
        ></textarea>

        <div v-if="!aiEnabled" class="small warn-text">未配置 API —— 翻译需要 AI，请先在设置里配好。</div>
        <div v-if="notice" class="small err">{{ notice }}</div>

        <div v-if="translateState.busy" class="progress small">
          <span>
            正在翻：{{ translateState.chapter || '—' }}
            <template v-if="translateState.chapterTotal > 1">（第 {{ translateState.chapterIndex }}/{{ translateState.chapterTotal }} 章）</template>
            <template v-if="translateState.total > 1"> · 第 {{ Math.min(translateState.done + 1, translateState.total) }}/{{ translateState.total }} 块</template>
          </span>
        </div>
      </div>

      <div class="spread foot">
        <span class="small dim">产出先进候选区，不会动你的原文</span>
        <div class="row">
          <button @click="emit('close')">{{ translateState.busy ? '后台继续' : '取消' }}</button>
          <button v-if="translateState.busy" class="danger-btn" @click="cancelTranslate">停止</button>
          <button v-else class="primary" :disabled="!canRun" @click="run">开始翻译</button>
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
  border-radius: var(--radius);
  width: min(560px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
}
.head {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
}
.body {
  padding: 12px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.col {
  display: flex;
  flex-direction: column;
}
.foot {
  padding: 10px 12px;
  border-top: 1px solid var(--line-soft);
}
/* 语言 / 范围用一排小胶囊，比下拉直观：就三个选项，没有下拉的必要 */
.chip {
  border: 1px solid var(--line);
  background: var(--bg-field);
  border-radius: 999px;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--text-soft);
  cursor: pointer;
}
.chip.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}
.scope-box {
  background: var(--bg-field);
  border-left: 2px solid var(--accent-soft);
  border-radius: 4px;
  padding: 6px 8px;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.progress {
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 6px 8px;
}
.danger-btn {
  border-color: var(--danger, #c0392b);
  color: var(--danger, #c0392b);
}
</style>
