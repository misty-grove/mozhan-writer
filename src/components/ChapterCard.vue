<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { currentChapter, saveChapterCard, state } from '@/stores/workspace'
import type { ChapterStatus, VolumeMeta } from '@/core/types'
import { STATUS_LIST } from '@/core/types'
import { readVolumeOutline, saveVolumeOutline } from '@/core/workspace'

const form = ref({
  title: '',
  status: '待写' as ChapterStatus,
  tags: '' as string,
  target: '',
  characters: '',
  settings: '',
  emotion: '',
  notes: ''
})
const volForm = ref<VolumeMeta & { title?: string }>({})
const volBody = ref('')
const dirty = ref(false)

watch(
  () => currentChapter.value?.id,
  () => {
    const c = currentChapter.value
    if (!c) return
    form.value = {
      title: c.title,
      status: c.status,
      tags: c.tags.join('、'),
      target: c.meta.target || '',
      characters: (c.meta.characters || []).join('、'),
      settings: (c.meta.settings || []).join('、'),
      emotion: c.meta.emotion || '',
      notes: c.meta.notes || ''
    }
    dirty.value = false
    loadVol()
  },
  { immediate: true }
)

async function loadVol() {
  const vid = currentChapter.value?.volumeId
  if (!vid || !state.ref) {
    volForm.value = {}
    volBody.value = ''
    return
  }
  const { meta, body } = await readVolumeOutline(state.ref, vid)
  volForm.value = { ...meta }
  volBody.value = body
}

async function save() {
  if (!currentChapter.value) return
  const toArr = (s: string) => s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean)
  await saveChapterCard(currentChapter.value.id, {
    title: form.value.title,
    status: form.value.status,
    tags: toArr(form.value.tags),
    target: form.value.target,
    characters: toArr(form.value.characters),
    settings: toArr(form.value.settings),
    emotion: form.value.emotion,
    notes: form.value.notes
  })
  dirty.value = false
}

async function saveVol() {
  const vid = currentChapter.value?.volumeId
  if (!vid || !state.ref) return
  await saveVolumeOutline(state.ref, vid, volForm.value, volBody.value)
  dirty.value = false
}

const volName = computed(() => state.volumes.find((v) => v.id === currentChapter.value?.volumeId)?.name)
</script>

<template>
  <div class="card-p">
    <b class="tt">章节卡片</b>
    <p class="small dim">写之前先想清楚：本章要达成什么、谁在场、用到哪些设定、情绪从哪走到哪。</p>

    <template v-if="currentChapter">
      <label class="small">章节标题<input v-model="form.title" @input="dirty = true" /></label>
      <div class="row small">
        <span class="nowrap">状态</span>
        <select v-model="form.status" @change="dirty = true" style="width: 100px">
          <option v-for="s in STATUS_LIST" :key="s" :value="s">{{ s }}</option>
        </select>
        <span class="nowrap">标签</span>
        <input v-model="form.tags" placeholder="用顿号分隔" @input="dirty = true" />
      </div>
      <label class="small">本章目标<textarea v-model="form.target" rows="2" @input="dirty = true"></textarea></label>
      <label class="small">出场人物<textarea v-model="form.characters" rows="2" @input="dirty = true"></textarea></label>
      <label class="small">涉及设定<textarea v-model="form.settings" rows="2" @input="dirty = true"></textarea></label>
      <label class="small">情绪走向<textarea v-model="form.emotion" rows="2" @input="dirty = true"></textarea></label>
      <label class="small">备注<textarea v-model="form.notes" rows="2" @input="dirty = true"></textarea></label>
      <button class="primary" :disabled="!dirty" @click="save">保存章节卡片</button>

      <template v-if="volName">
        <hr />
        <b class="tt">本卷大纲 · {{ volName }}</b>
        <label class="small">本卷目标<textarea v-model="volForm.target" rows="2" @input="dirty = true"></textarea></label>
        <label class="small">核心冲突<textarea v-model="volForm.conflict" rows="2" @input="dirty = true"></textarea></label>
        <label class="small">推进线<textarea v-model="volForm.line" rows="2" @input="dirty = true"></textarea></label>
        <label class="small">卷末钩子<textarea v-model="volForm.hook" rows="2" @input="dirty = true"></textarea></label>
        <label class="small">卷纲正文<textarea v-model="volBody" rows="4" @input="dirty = true"></textarea></label>
        <button :disabled="!dirty" @click="saveVol">保存卷纲</button>
      </template>
    </template>
    <div v-else class="small dim">未选择章节。</div>
  </div>
</template>

<style scoped>
.card-p {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt {
  font-size: 13px;
}
label.small {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--text-soft);
}
textarea {
  font-family: inherit;
  resize: vertical;
  line-height: 1.6;
}
</style>
