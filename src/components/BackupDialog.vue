<script setup lang="ts">
/**
 * 备份与恢复（P3-C）
 *
 * 作品的唯一真相是磁盘上的普通文件 —— 所以「备份」就是把它们打成一个标准 zip，
 * 「恢复」就是解开写回去。不做私有格式，也不做整目录替换：
 * 恢复默认只覆盖同名文件，包里没有的文件一律保留。
 */
import { computed, onMounted, ref } from 'vue'
import {
  backupFileName,
  buildBackup,
  humanSize,
  previewBackup,
  restoreBackup,
  storageUsage,
  type RestorePreview,
  type UsageReport
} from '@/core/backup'
import { snapshotPolicy } from '@/core/snapshots'
import { refresh, state } from '@/stores/workspace'
import { settings } from '@/core/settings'

const emit = defineEmits<{ (e: 'close'): void }>()

const tab = ref<'backup' | 'restore' | 'usage'>('backup')
const busy = ref(false)
const msg = ref('')
const err = ref('')

/* ---------------- 备份 ---------------- */
const includeSnapshots = ref(false)
const lastManifest = ref<{ fileCount: number; totalWords: number; createdAt: string } | null>(null)
const lastPaths = ref<string[]>([])
const downloadUrl = ref('')
const downloadName = ref('')

/* ---------------- 恢复 ---------------- */
const restoreFile = ref('')
const preview = ref<RestorePreview | null>(null)
const pendingBytes = ref<Uint8Array | null>(null)
const onConflict = ref<'overwrite' | 'skip'>('overwrite')
const restoreInput = ref<HTMLInputElement | null>(null)
const confirmRestore = ref(false)

/* ---------------- 占用 ---------------- */
const usage = ref<UsageReport | null>(null)

const policy = computed(() => snapshotPolicy())

onMounted(loadUsage)

async function loadUsage() {
  if (!state.ref) return
  try {
    usage.value = await storageUsage(state.ref)
  } catch (e: any) {
    err.value = `统计占用失败：${e?.message || e}`
  }
}

/* ---------------- 备份 ---------------- */

function releaseUrl() {
  if (downloadUrl.value) {
    URL.revokeObjectURL(downloadUrl.value)
    downloadUrl.value = ''
  }
}

async function doBackup() {
  if (!state.ref) return
  busy.value = true
  err.value = ''
  msg.value = '正在打包…'
  try {
    const res = await buildBackup(state.ref, { title: state.info.title, author: state.info.author }, {
      includeSnapshots: includeSnapshots.value,
      onProgress: (_d, label) => (msg.value = label)
    })
    releaseUrl()
    downloadUrl.value = URL.createObjectURL(res.blob)
    downloadName.value = backupFileName(state.info.title || state.ref.name)
    lastManifest.value = res.manifest
    lastPaths.value = res.paths
    msg.value = `已打包 ${res.manifest.fileCount} 个文件 · ${humanSize(res.blob.size)}`
  } catch (e: any) {
    err.value = `备份失败：${e?.message || e}`
    msg.value = ''
  } finally {
    busy.value = false
  }
}

function saveBackup() {
  if (!downloadUrl.value) return
  const a = document.createElement('a')
  a.href = downloadUrl.value
  a.download = downloadName.value
  document.body.appendChild(a)
  a.click()
  a.remove()
  msg.value = `已下载 ${downloadName.value}`
}

/* ---------------- 恢复 ---------------- */

async function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f || !state.ref) return
  err.value = ''
  msg.value = '正在读取备份…'
  try {
    const bytes = new Uint8Array(await f.arrayBuffer())
    pendingBytes.value = bytes
    restoreFile.value = f.name
    preview.value = await previewBackup(bytes)
    confirmRestore.value = false
    msg.value = `备份包可恢复 ${preview.value.files.length} 个文件`
  } catch (e2: any) {
    preview.value = null
    pendingBytes.value = null
    err.value = `读取失败：${e2?.message || e2}`
    msg.value = ''
  }
}

async function doRestore() {
  if (!state.ref || !pendingBytes.value) return
  if (!confirmRestore.value) {
    confirmRestore.value = true
    return
  }
  busy.value = true
  err.value = ''
  msg.value = '正在写入…'
  try {
    const res = await restoreBackup(state.ref, pendingBytes.value, {
      onConflict: onConflict.value,
      onProgress: (d, t, label) => (msg.value = `写入 ${d}/${t}：${label}`)
    })
    msg.value = `已恢复 ${res.written.length} 个文件${res.skipped.length ? `，跳过 ${res.skipped.length} 个已存在` : ''}${res.refused.length ? `，拒绝 ${res.refused.length} 个不安全条目` : ''}`
    await refresh(false)
    await loadUsage()
    preview.value = null
    pendingBytes.value = null
    restoreFile.value = ''
    confirmRestore.value = false
  } catch (e: any) {
    err.value = `恢复失败：${e?.message || e}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mask backup-mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <b>备份与存储</b>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>

      <div class="tabs row small">
        <button class="text small" :class="{ on: tab === 'backup' }" @click="tab = 'backup'">导出备份</button>
        <button class="text small" :class="{ on: tab === 'restore' }" @click="tab = 'restore'">从备份恢复</button>
        <button class="text small" :class="{ on: tab === 'usage' }" @click="((tab = 'usage'), loadUsage())">磁盘占用</button>
      </div>

      <div class="body col">
        <!-- 导出 -->
        <template v-if="tab === 'backup'">
          <p class="small dim">
            把整个作品打成一个标准 zip：解开就是原来那套目录，<code>大纲/设定/正文/记忆/技能/插件</code> 一个不少，
            换个机器解压出来就能直接打开。
          </p>
          <label class="small row">
            <input v-model="includeSnapshots" type="checkbox" style="width: auto" />
            同时打包 .snapshots（版本快照；放进去包会大很多）
          </label>
          <div class="row">
            <button class="primary" :disabled="busy" @click="doBackup">打包</button>
            <button :disabled="!downloadUrl" @click="saveBackup">下载 zip</button>
          </div>
          <div v-if="lastManifest" class="small box">
            <div>{{ lastManifest.fileCount }} 个文件 · {{ lastManifest.totalWords.toLocaleString() }} 字 · 打包于 {{ lastManifest.createdAt.slice(0, 16).replace('T', ' ') }}</div>
            <details>
              <summary class="dim">查看包含的文件（{{ lastPaths.length }}）</summary>
              <div class="paths">
                <span v-for="p in lastPaths" :key="p">{{ p }}</span>
              </div>
            </details>
          </div>
        </template>

        <!-- 恢复 -->
        <template v-else-if="tab === 'restore'">
          <div class="row">
            <button class="primary" :disabled="busy" @click="restoreInput?.click()">选择备份 zip</button>
            <input ref="restoreInput" type="file" accept=".zip,application/zip" class="hidden-file" @change="onPick" />
            <span v-if="restoreFile" class="small dim">{{ restoreFile }}</span>
          </div>

          <div v-if="preview" class="small box col">
            <div v-if="preview.manifest">
              备份来自《{{ preview.manifest.title }}》<span v-if="preview.manifest.author">／{{ preview.manifest.author }}</span>
              · 打包于 {{ preview.manifest.createdAt.slice(0, 16).replace('T', ' ') }}
              · {{ preview.totalWords.toLocaleString() }} 字
            </div>
            <div v-else class="warn-box small">包里没有备份信息清单（可能不是本应用产出的 zip），下面按实际文件列出。</div>
            <div>{{ preview.files.length }} 个文件可恢复</div>
            <details>
              <summary class="dim">查看文件清单</summary>
              <div class="paths">
                <span v-for="f in preview.files" :key="f.path">{{ f.path }}<em v-if="f.words"> · {{ f.words }} 字</em></span>
              </div>
            </details>
            <div v-if="preview.skipped.length" class="warn-box small">
              有 {{ preview.skipped.length }} 个条目路径不安全（含 <code>..</code> 或绝对路径），已拒绝，不会写入。
              <div class="paths">{{ preview.skipped.join('、') }}</div>
            </div>

            <label class="small"
              >同名文件怎么处理
              <select v-model="onConflict" :disabled="busy">
                <option value="overwrite">覆盖（用备份里的版本）</option>
                <option value="skip">跳过（保留当前文件）</option>
              </select>
            </label>

            <p class="small dim">
              恢复**只覆盖同名文件**，备份包里没有的文件一律保留 —— 不会清空你现在的作品。
              想先留个底，可以在「导出备份」里先打一个包。
            </p>

            <div class="row">
              <button class="primary" :disabled="busy" @click="doRestore">
                {{ confirmRestore ? '确认恢复（再点一次）' : '开始恢复' }}
              </button>
              <button v-if="confirmRestore" @click="confirmRestore = false">取消</button>
            </div>
          </div>
        </template>

        <!-- 占用 -->
        <template v-else>
          <div v-if="!usage" class="small dim">统计中…</div>
          <template v-else>
            <table class="usage small">
              <thead>
                <tr>
                  <th>目录</th>
                  <th class="num">文件</th>
                  <th class="num">体积</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in usage.rows" :key="r.label">
                  <td>{{ r.label }}</td>
                  <td class="num">{{ r.files }}</td>
                  <td class="num">{{ humanSize(r.bytes) }}</td>
                  <td class="bar-cell">
                    <i :style="{ width: (usage.totalBytes ? Math.round((r.bytes / usage.totalBytes) * 100) : 0) + '%' }"></i>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="small dim">
              正文与资料合计 {{ usage.totalFiles }} 个文件 · {{ humanSize(usage.totalBytes) }}；
              快照 {{ usage.snapshotFiles }} 份 · {{ humanSize(usage.snapshotBytes) }}。
              <span class="dim">（按文本 UTF-8 字节估算，不含文件系统的块对齐开销）</span>
            </div>
            <div class="small box col">
              <b>自动快照策略</b>
              <label class="small row"
                >每章最多保留 <input v-model.number="settings.general.recentSnapshots" type="number" min="1" max="200" class="narrow" /> 份自动快照</label
              >
              <label class="small row"
                >同一章两次自动快照至少间隔 <input v-model.number="settings.general.autoSnapshotIntervalMin" type="number" min="0" max="240" class="narrow" /> 分钟</label
              >
              <div class="dim">当前生效：最多 {{ policy.maxAuto }} 份 / 间隔 {{ Math.round(policy.intervalMs / 60000) }} 分钟。手动快照不受份数限制。</div>
            </div>
          </template>
        </template>

        <div v-if="msg" class="small dim">{{ msg }}</div>
        <p v-if="err" class="err-box small">{{ err }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  width: 640px;
  max-height: 86vh;
}
.tabs {
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
}
.hidden-file {
  display: none;
}
.box {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  background: var(--bg-panel);
}
.paths {
  max-height: 150px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-dim);
  font-family: ui-monospace, Consolas, monospace;
}
.paths em {
  font-style: normal;
  opacity: 0.7;
}
.warn-box {
  border: 1px solid var(--note-line);
  background: var(--note-bg);
  color: var(--note-fg);
  padding: 6px 8px;
  border-radius: 4px;
}
.err-box {
  border: 1px solid var(--danger-line);
  background: var(--danger-bg);
  color: var(--danger-fg);
  padding: 8px 10px;
  border-radius: 4px;
}
.usage {
  width: 100%;
  border-collapse: collapse;
}
.usage th,
.usage td {
  border-bottom: 1px solid var(--line-soft);
  padding: 4px 6px;
  text-align: left;
}
.usage .num {
  text-align: right;
  white-space: nowrap;
}
.bar-cell {
  width: 120px;
}
.bar-cell i {
  display: block;
  height: 6px;
  background: var(--accent);
  border-radius: 3px;
  min-width: 2px;
}
.narrow {
  width: 72px;
}
button.text.on {
  color: var(--accent);
  background: var(--accent-soft);
}
code {
  background: var(--line-soft);
  padding: 1px 5px;
  border-radius: 3px;
}
</style>
