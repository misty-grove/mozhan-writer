<script setup lang="ts">
import { computed, ref } from 'vue'
import { aiState, buildContext, cancelGenerate, contextStat, enabled, generate, toggleItem } from '@/stores/ai'
import { settings } from '@/core/settings'
import { currentChapter, saveNow, state } from '@/stores/workspace'
import { selectedText, setDockTab } from '@/stores/editor'
import { estimateTokens } from '@/core/util'
import AiPromptDialog from './AiPromptDialog.vue'

const openId = ref('')
/** 两行输入框写不下的时候，走这个对话框（模式 + 大指令框 + 目标字数） */
const showAi = ref(false)
const instruction = ref('')
const candidates = ref(2)
const mode = ref<'continue' | 'rewrite' | 'expand' | 'shrink' | 'tone' | 'generate' | 'fix'>('continue')
/** 本面板自己的提示：不能用 alert（桌面壳/部分 WebView 会禁掉原生弹窗，调用处静默失败） */
const tip = ref('')

/** 需要选区的工具。生成与续写从零/接文末，不依赖选区 */
const SEL_MODES = ['rewrite', 'expand', 'shrink', 'tone', 'fix']
/** 可一次出多个候选的工具 */
const MULTI_MODES = ['continue', 'generate']

const used = computed(() => contextStat.value)
const overBudget = computed(() => used.value.tokens > settings.ai.contextWindow * 0.7)

async function rebuild() {
  await buildContext()
}

async function run() {
  if (!currentChapter.value) return
  tip.value = ''
  await saveNow()
  const needSel = SEL_MODES.includes(mode.value)
  let text = needSel ? selectedText.value : ''
  let whole = false
  if (needSel && !text) {
    // 纠错没有选区时退而求其次：整章校对（这是它最常用的形态）。
    // 其余局部工具没有选区就真的没法做，只能请作者先选一段。
    if (mode.value !== 'fix') {
      tip.value = '请先在正文里选中一段文字，再做局部处理。'
      return
    }
    whole = true
    text = state.content
    if (!text.trim()) {
      tip.value = '这一章还没有正文，没有可校对的内容。'
      return
    }
  }
  await generate({
    mode: mode.value,
    skill: aiState.selectedSkill,
    instruction: instruction.value.trim(),
    n: MULTI_MODES.includes(mode.value) ? candidates.value : 1,
    selection: text,
    wholeChapter: whole
  })
  setDockTab('candidate')
}
</script>

<template>
  <div class="ctx">
    <div v-if="!enabled" class="empty small">
      未配置 API。本面板在配置前不该出现 —— 请在「设置 · AI」里填写 Base URL / Key / 模型。
    </div>

    <template v-else>
      <div class="spread">
        <b class="tt">上下文装配</b>
        <button class="text small" @click="rebuild">重新装配</button>
      </div>
      <p class="hint small dim">这次会喂给模型什么，全在这里。不想要的项目直接取消勾选 —— 续写质量由它决定。</p>

      <div class="row small opts">
        <label title="取最近几章的摘要">近<input v-model.number="aiState.buildOpts.recentChapters" type="number" min="0" max="20" />章摘要</label>
        <label title="上一章结尾取多少字">接前文<input v-model.number="aiState.buildOpts.tailChars" type="number" min="0" step="200" />字</label>
        <label title="取本文风样本字数">文风样本<input v-model.number="aiState.buildOpts.styleSampleChars" type="number" min="0" step="500" />字</label>
        <button class="text small" @click="rebuild">应用</button>
      </div>

      <div class="row small stat" :class="{ warn: overBudget }">
        <span>已选 {{ aiState.items.filter((i) => i.enabled).length }}/{{ aiState.items.length }} 项</span>
        <span>{{ used.chars.toLocaleString() }} 字</span>
        <span>≈{{ used.tokens.toLocaleString() }} token</span>
        <span class="dim">窗口 {{ settings.ai.contextWindow.toLocaleString() }}</span>
      </div>
      <div v-if="overBudget" class="warnline small">注入量偏大，建议取消部分设定，或提高上下文窗口。</div>

      <div class="items">
        <div v-for="it in aiState.items" :key="it.id" class="item">
          <div class="row">
            <input type="checkbox" :checked="it.enabled" style="width: auto" @change="toggleItem(it.id, ($event.target as any).checked)" />
            <span class="lbl" @click="openId = openId === it.id ? '' : it.id">{{ it.label }}</span>
            <span class="dim small nowrap">{{ estimateTokens(it.content) }}t</span>
          </div>
          <div class="small dim detail">{{ it.detail }}</div>
          <pre v-if="openId === it.id" class="preview small">{{ it.content.slice(0, 3000) }}{{ it.content.length > 3000 ? '\n…（预览截断）' : '' }}</pre>
        </div>
      </div>

      <hr />
      <div class="col">
        <div class="row">
          <select v-model="mode" style="width: 120px">
            <option value="continue">续写</option>
            <option value="generate">生成</option>
            <option value="fix">纠错</option>
            <option value="rewrite">局部重写</option>
            <option value="expand">扩写</option>
            <option value="shrink">缩写</option>
            <option value="tone">改语气</option>
          </select>
          <select v-model="aiState.selectedSkill">
            <option value="">不使用技能</option>
            <option v-for="s in aiState.skills.filter((x) => x.enabled)" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
          <button class="text small nowrap" title="导入 / 管理技能" @click="setDockTab('skill')">技能…</button>
        </div>
        <div v-if="MULTI_MODES.includes(mode)" class="row small">
          <span class="dim">候选个数</span>
          <input v-model.number="candidates" type="number" min="1" max="4" style="width: 60px" />
        </div>
        <div v-else-if="mode === 'fix' && selectedText" class="small dim">已选中 {{ selectedText.length }} 字，将只校对这一段</div>
        <div v-else-if="mode === 'fix'" class="small dim">未选中文字 —— 将校对整章（{{ state.content.length }} 字）</div>
        <div v-else-if="mode === 'generate'" class="small dim">从零生成：在下面写清楚要什么（角色、场景、情节点），AI 不接续现有结尾</div>
        <div v-else class="small dim">已选中 {{ selectedText.length }} 字，将对这段做局部处理</div>
        <textarea
          v-model="instruction"
          rows="2"
          :placeholder="mode === 'generate'
            ? '写什么？例如：主角深夜抵达港口城市，被人尾随，写一段压抑的环境与心理'
            : '补充要求（可留空）：例如「这段要更压抑一点，不要让角色说话」'
        "></textarea>
        <div class="row">
          <button class="primary" :disabled="aiState.generating || !currentChapter" @click="run">
            {{ aiState.generating ? '生成中…' : '生成并放入候选区' }}
          </button>
          <!-- 两行不够写的时候走这里：模式 + 大指令框 + 目标字数，
               并且会把「这次对哪一段动手」明写出来（AI 不知道你指哪段是最常见的翻车） -->
          <button class="text small nowrap" title="打开大指令框：写清楚要什么、扩多少字" @click="showAi = true">
            详细指令…
          </button>
          <button v-if="aiState.generating" @click="cancelGenerate">停止</button>
        </div>
        <div v-if="tip" class="small warn-text">{{ tip }}</div>
        <div class="small dim">当前章节：{{ currentChapter?.title || '—' }}</div>
        <div v-if="aiState.error" class="small err">{{ aiState.error }}</div>
        <div v-if="aiState.streaming" class="stream small">{{ aiState.streaming.slice(-600) }}</div>
      </div>
    </template>

    <AiPromptDialog v-if="showAi" @close="showAi = false" />
  </div>
</template>

<style scoped>
.ctx {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
.hint {
  margin: 0;
  line-height: 1.6;
}
.opts label {
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--text-soft);
}
.opts input {
  width: 62px;
}
.stat {
  color: var(--text-soft);
  gap: 10px;
}
.stat.warn {
  color: var(--warn);
}
.warnline {
  color: var(--warn);
}
.items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 40vh;
  overflow: auto;
}
.item {
  border-bottom: 1px dashed var(--line-soft);
  padding-bottom: 6px;
}
.lbl {
  flex: 1;
  cursor: pointer;
  font-size: 13px;
}
.detail {
  padding-left: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview {
  margin: 6px 0 0;
  padding: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}
.stream {
  border: 1px solid var(--line);
  padding: 8px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
}
.err {
  color: var(--danger);
}
.empty {
  color: var(--text-soft);
  line-height: 1.7;
}
</style>
