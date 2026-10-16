<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { readAsset, writeAsset } from '@/core/workspace'
import { state } from '@/stores/workspace'
import { openAssetRequest } from '@/stores/editor'
import fs from '@/platform'

// 默认停在「大纲」：作者最常翻的是大纲（设定往往是空的，记忆由软件自己写），
// 默认停在一个空分类上，看着就像「导进去了却看不到」
const group = ref('大纲')
const openId = ref('')
const text = ref('')
const dirty = ref(false)
const GROUPS = ['大纲', '设定', '记忆']

const list = computed(() => state.assets.filter((a) => a.group === group.value))

watch(openId, async (id) => {
  text.value = id && state.ref ? await readAsset(state.ref, id) : ''
  dirty.value = false
})

/* 搜索面板点了某份资料：切到对应分类并展开它 */
watch(openAssetRequest, (req) => {
  if (!req?.id) return
  const asset = state.assets.find((a) => a.id === req.id)
  if (asset) group.value = asset.group
  openId.value = req.id
})

async function save() {
  if (!state.ref || !openId.value) return
  await writeAsset(state.ref, openId.value, text.value)
  dirty.value = false
}

async function openFolder() {
  alert('作品根目录：' + (state.ref?.name || '') + '\n直接在文件管理器里打开即可编辑这些 Markdown。')
}
</script>

<template>
  <div class="ap">
    <div class="spread">
      <b class="tt">资料</b>
      <div class="row small">
        <button v-for="g in GROUPS" :key="g" class="text small" :class="{ on: group === g }" @click="group = g">{{ g }}</button>
      </div>
    </div>

    <div class="list">
      <div v-for="a in list" :key="a.id" class="row item">
        <span class="nm small" :title="a.id" @click="openId = openId === a.id ? '' : a.id">{{ a.name }}</span>
        <span class="dim small">{{ a.wordCount }} 字</span>
      </div>
      <div v-if="!list.length" class="small dim">这个分类下还没有 Markdown 文件。可以直接把文件丢进作品目录的对应文件夹。</div>
    </div>

    <template v-if="openId">
      <div class="small dim">{{ openId }}</div>
      <textarea v-model="text" class="doc small" spellcheck="false" @input="dirty = true"></textarea>
      <div class="row">
        <button class="primary" :disabled="!dirty" @click="save">保存</button>
        <button class="text small" @click="((text = ''), (openId = ''))">收起</button>
      </div>
    </template>

    <div class="row small dim">
      <span>文件就在作品文件夹里，卸载软件也能看</span>
      <button class="text small" @click="openFolder">在哪？</button>
    </div>
  </div>
</template>

<style scoped>
.ap {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
button.on {
  color: var(--text);
  background: var(--accent-soft);
}
.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 30vh;
  overflow: auto;
}
.item {
  justify-content: space-between;
  gap: 8px;
}
.nm {
  cursor: pointer;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nm:hover {
  color: var(--accent);
}
.doc {
  min-height: 220px;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.7;
  resize: vertical;
}
</style>
