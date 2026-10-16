<script setup lang="ts">
import { computed } from 'vue'
import { dockFx, editorState, setDockTab } from '@/stores/editor'
import { aiEnabled } from '@/core/settings'
import { aiState } from '@/stores/ai'
import ContextPanel from './ContextPanel.vue'
import CandidatePanel from './CandidatePanel.vue'
import ChapterCard from './ChapterCard.vue'
import MemoryPanel from './MemoryPanel.vue'
import AssetPanel from './AssetPanel.vue'
import SkillPanel from './SkillPanel.vue'
import SearchPanel from './SearchPanel.vue'
import CodexPanel from './CodexPanel.vue'
import ForeshadowPanel from './ForeshadowPanel.vue'
import StylePanel from './StylePanel.vue'
import CheckPanel from './CheckPanel.vue'

const tabs = computed(() => {
  // AI 相关页签只有在配置了 API 后才出现；技能页签例外 —— 它常驻。
  // 技能本质是作者的提示词资产（导入、编辑、导出都不需要联网），
  // 把它藏进「配了 API 才有」的那一组，作者就会在没配置时以为根本不能导入。
  const ai = aiEnabled()
    ? ([
        { k: 'candidate', label: `候选${aiState.candidates.length ? `(${aiState.candidates.length})` : ''}` },
        { k: 'context', label: '上下文' }
      ] as Array<{ k: any; label: string }>)
    : []
  const base = [
    { k: 'skill', label: '技能' },
    { k: 'card', label: '卡片' },
    { k: 'codex', label: '设定' },
    { k: 'foreshadow', label: '伏笔' },
    { k: 'check', label: '检查' },
    { k: 'style', label: '文风' },
    { k: 'memory', label: '记忆' },
    // 「统计」不在 dock：主视图有一份完整的（多健康度/自定义规则/分布图），
    // 这里再放一份只会让人疑心「两个数字怎么不一样」。
    { k: 'asset', label: '文件' },
    { k: 'search', label: '搜索' }
  ] as Array<{ k: any; label: string }>
  return [...ai, ...base]
})

/** AI 没开时 'context' 页签不存在，落到第一个可用页签 */
const current = computed(() => (tabs.value.some((t) => t.k === editorState.dockTab) ? editorState.dockTab : tabs.value[0].k))

/** 切页签：把「当前可见的顺序」一起交给 store，方向才判得对（页签会随 AI 开关增减） */
function pick(k: string) {
  setDockTab(k as typeof editorState.dockTab, tabs.value.map((t) => t.k))
}
</script>

<template>
  <aside class="dock">
    <div class="tabs">
      <button v-for="t in tabs" :key="t.k" class="text small" :class="{ on: current === t.k }" @click="pick(t.k)">
        {{ t.label }}
      </button>
    </div>
    <div class="body">
      <!-- 手机上切页签是「整块换掉」，不给动画就是硬切。用 out-in 而不是左右同时推：
           面板本身是滚动容器，两个同时在场要额外处理绝对定位，收益不如风险大。 -->
      <Transition :name="'dock-' + dockFx.dir" mode="out-in">
        <ContextPanel v-if="current === 'context'" key="context" />
        <CandidatePanel v-else-if="current === 'candidate'" key="candidate" />
        <SkillPanel v-else-if="current === 'skill'" key="skill" />
        <ChapterCard v-else-if="current === 'card'" key="card" />
        <CodexPanel v-else-if="current === 'codex'" key="codex" />
        <ForeshadowPanel v-else-if="current === 'foreshadow'" key="foreshadow" />
        <CheckPanel v-else-if="current === 'check'" key="check" />
        <StylePanel v-else-if="current === 'style'" key="style" />
        <MemoryPanel v-else-if="current === 'memory'" key="memory" />
        <AssetPanel v-else-if="current === 'asset'" key="asset" />
        <SearchPanel v-else-if="current === 'search'" key="search" />
      </Transition>
    </div>
  </aside>
</template>

<style scoped>
.dock {
  width: 348px;
  flex: 0 0 348px;
  border-left: 1px solid var(--line);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* 页签是一组互斥选项，做成胶囊而不是「一排边框按钮」：
   默认几乎没有边框，只有选中的那颗浮起来，一眼能看出「现在看的是哪一个」。 */
.tabs {
  display: flex;
  gap: 4px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
  flex-wrap: wrap;
}
.tabs button {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  color: var(--text-soft);
  white-space: nowrap;
}
.tabs button:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.tabs button.on {
  color: var(--text);
  background: var(--bg-elev);
  border-color: var(--line);
  box-shadow: var(--shadow-1);
  font-weight: 500;
}
.body {
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
}
</style>
