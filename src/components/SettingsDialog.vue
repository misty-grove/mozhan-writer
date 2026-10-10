<script setup lang="ts">
import { ref } from 'vue'
import { aiEnabled, settings, THEMES, zoomBy } from '@/core/settings'
import { editorState } from '@/stores/editor'
import { testConnect } from '@/stores/ai'
import { agentAvailable, agentProbe, type AgentProbeResult } from '@/platform/aiBridge'
import fs, { hostInfo } from '@/platform'
import { copyWorkTo } from '@/core/workspace'
import { state } from '@/stores/workspace'
import type { DirRef } from '@/platform'
import BackupDialog from './BackupDialog.vue'

const props = defineProps<{ initialTab?: 'ai' | 'type' | 'general' }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const tab = ref<'ai' | 'type' | 'general'>(props.initialTab ?? 'ai')
const testing = ref(false)
const result = ref('')
const models = ref<string[]>([])
const backing = ref(false)
const backupMsg = ref('')
const showBackup = ref(false)
const showKey = ref(false)

/* ---- DSH Agent 探测 ---- */
const agentOk = ref(false)
const agentInfo = ref<AgentProbeResult | null>(null)
const agentMsg = ref('')
const probing = ref(false)

async function probeAgent() {
  probing.value = true
  agentMsg.value = ''
  try {
    agentInfo.value = await agentProbe(settings.ai.agentCli || undefined)
    agentOk.value = !!agentInfo.value?.found
    agentMsg.value = agentInfo.value?.found
      ? `已检测到${agentInfo.value.version ? ' · ' + agentInfo.value.version : ''}${
          agentInfo.value.probeError ? ' · ' + agentInfo.value.probeError : ''
        }`
      : agentInfo.value?.hint || '未检测到 DSH'
  } catch (e: any) {
    agentOk.value = false
    agentMsg.value = String(e?.message || e)
  } finally {
    probing.value = false
  }
}

/** 切到 Agent 档时自动探一次 —— 让作者马上知道这台机器上到底有没有 */
async function onEngineChange() {
  if (settings.ai.engine === 'agent' || settings.ai.engine === 'both') {
    if (!agentInfo.value) await probeAgent()
  }
}
/** 当前设备能不能用 Agent（浏览器 / 手机不行） */
const agentHostOk = ref(false)
agentAvailable().then((v) => {
  agentHostOk.value = v
  if (v && (settings.ai.engine === 'agent' || settings.ai.engine === 'both')) probeAgent()
})

/**
 * 常用服务商预设：选中即填 Base URL（模型名也给个默认值，可直接改）。
 * 全部是 OpenAI 兼容协议；endpoint 拼接规则见 core/ai.ts（自动补 /v1/chat/completions）。
 */
const PRESETS = [
  { label: 'DeepSeek（官方）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'OpenAI（官方）', baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini' },
  { label: 'Ollama（本机模型）', baseUrl: 'http://127.0.0.1:11434', model: '' },
  { label: '自定义 / 其他兼容服务商', baseUrl: '', model: '' }
]
const presetKey = ref(PRESETS.findIndex((p) => p.baseUrl === settings.ai.baseUrl.trim()))

/** 三种引擎。措辞刻意说"人话"——作者不关心 SSE 还是 NDJSON，只关心要花什么、得到什么。 */
const ENGINES: Array<{ k: 'api' | 'agent' | 'both'; label: string; hint: string }> = [
  { k: 'api', label: '直连 API', hint: '填 Key，快、便宜' },
  { k: 'agent', label: 'DSH Agent', hint: '用本机 DSH，能自己翻资料' },
  { k: 'both', label: '两者并存', hint: 'Agent 优先，跑不动就回落 API' }
]

function applyPreset(i: number) {
  const p = PRESETS[i]
  if (!p) return
  if (p.baseUrl) settings.ai.baseUrl = p.baseUrl
  if (p.model && !settings.ai.model.trim()) settings.ai.model = p.model
}

async function backup() {
  backupMsg.value = ''
  if (!state.ref) return
  // 移动端没有目录选择器 —— 备份直接进应用自己的下载目录
  // （路径由 Rust 侧 app_host_info 给出，作者能在文件管理器里翻到）。
  const host = await hostInfo()
  let dst: DirRef | null = null
  if (host.isMobile) {
    if (!host.exportDir) {
      backupMsg.value = '这台设备上找不到可用的备份目录'
      return
    }
    dst = { id: host.exportDir, name: host.exportHint || '下载目录' }
  } else {
    dst = await fs().pickDir('选择备份到的目标文件夹')
  }
  if (!dst) return
  backing.value = true
  try {
    const name = `${state.ref.name}-备份-${new Date().toISOString().slice(0, 10)}`
    await copyWorkTo(state.ref, dst, name)
    backupMsg.value = host.isMobile ? `已备份到 ${host.exportDir}/${name}` : `已备份到 ${dst.name}/${name}`
  } catch (e: any) {
    backupMsg.value = `备份失败：${String(e?.message || e)}`
  } finally {
    backing.value = false
  }
}

const FONTS = [
  { label: '宋体（默认，适合长文）', value: '"Source Han Serif SC","Noto Serif CJK SC",SimSun,"Songti SC",Georgia,serif' },
  { label: '黑体（更醒目）', value: '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif' },
  { label: '楷体', value: 'KaiTi,"STKaiti","Kaiti SC",serif' },
  { label: '系统等宽', value: 'Consolas,"Courier New",monospace' }
]

async function test() {
  testing.value = true
  result.value = ''
  models.value = []
  try {
    const r = await testConnect()
    result.value = r.message
    models.value = r.models || []
    // 测通了就顺手把 AI 层打开 —— 省得填完一切还忘拨那个总开关
    if (r.message.startsWith('连接成功')) settings.ai.configured = true
  } finally {
    testing.value = false
  }
}

function pickModel(m: string) {
  settings.ai.model = m
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="spread head">
        <div class="row tabs">
          <button class="text" :class="{ 'on': tab === 'ai' }" @click="tab = 'ai'">AI</button>
          <button class="text" :class="{ 'on': tab === 'type' }" @click="tab = 'type'">排版</button>
          <button class="text" :class="{ 'on': tab === 'general' }" @click="tab = 'general'">通用</button>
        </div>
        <button class="btn-icon" @click="emit('close')">×</button>
      </div>

      <div class="body">
        <!-- AI -->
        <div v-if="tab === 'ai'" class="col">
          <div class="grp small">AI 引擎</div>
          <div class="engines">
            <button
              v-for="e in ENGINES"
              :key="e.k"
              type="button"
              class="engine"
              :class="{ on: settings.ai.engine === e.k, off: e.k !== 'api' && !agentHostOk }"
              :disabled="e.k !== 'api' && !agentHostOk"
              @click="((settings.ai.engine = e.k), onEngineChange())"
            >
              <b>{{ e.label }}</b>
              <span class="dim small">{{ e.hint }}</span>
            </button>
          </div>
          <p class="small dim lead-note">
            <b>直连 API</b>：把上下文拼成提示词发给服务商，拿回一段文本，速度快、便宜。<br />
            <b>DSH Agent</b>：交给本机装好的 DSH，它能自己翻你的 <code>设定/</code>、<code>记忆/</code>，
            按技能库的流程分多步做事，<b>密钥由 DSH 自己管，这里不用填</b>。慢一些，但更懂这本书。
          </p>

          <!-- DSH Agent 配置 -->
          <template v-if="settings.ai.engine !== 'api'">
            <div class="grp small">DSH Agent</div>
            <div class="row">
              <button type="button" @click="probeAgent" :disabled="probing || !agentHostOk">
                {{ probing ? '检测中…' : '检测 DSH' }}
              </button>
              <span class="small" :class="agentOk ? 'ok' : 'err'">{{ agentMsg }}</span>
            </div>
            <label class="small">dsh 可执行文件路径（留空自动找 PATH 与默认安装位置）
              <input v-model="settings.ai.agentCli" placeholder="E:\DSH\resources\runtime\cli\bin\dsh.cmd" />
            </label>
            <div class="grid2">
              <label class="small">profile
                <select v-model="settings.ai.agentProfile" style="width: 100%">
                  <option value="headless">headless（一次性任务）</option>
                  <option v-for="p in (agentInfo?.profiles || []).filter((x) => x !== 'headless')" :key="p" :value="p">{{ p }}</option>
                </select>
              </label>
              <label class="small">单次超时（秒）
                <input v-model.number="settings.ai.agentTimeoutSecs" type="number" min="30" step="30" />
              </label>
            </div>
            <label class="small">权限档位
              <select v-model="settings.ai.agentPermission" style="width: 100%">
                <option value="read_only">只读（推荐）—— 只能看，产出回到候选区</option>
                <option value="write_in_cwd">可写作品目录 —— 允许它自己更新记忆库 / 伏笔台账</option>
              </select>
            </label>
            <p class="small dim">
              <b>只读</b>是默认，因为本软件的铁律是「AI 的产出先进候选区，你点了采纳才写进正文」。
              可写档位放开的是<code>记忆/</code>这类重复劳动，正文仍然要你确认。<br />
              注意：只要给了「可写」，Agent 就真的能改文件 —— 提示词里的限制是<u>软约束</u>，
              建议先在测试作品上试一次。
            </p>
            <p class="small dim">
              <b>Windows 上的一条实情：</b>DSH 自带的沙箱在本机起不来（授权工作目录时报系统错误），
              所以软件会关掉它的沙箱再启动 Agent。也就是说 Agent 进程本身有完整的本机文件访问能力，
              「只读 / 可写」靠的是<u>给它的指令约束</u>，不是操作系统层面的隔离。
              在意这一点的话，就只在你信得过的作品目录里用 Agent 模式。
            </p>
            <p class="small dim">
              每个作品会自动绑一个 DSH 会话，所以第二次续写时它记得前文。换作品自动换会话，不会串。
            </p>
          </template>

          <!-- 直连 API 配置 -->
          <div v-if="settings.ai.engine !== 'agent'" class="col">
            <div class="grp small">服务商（直连 API）</div>
            <p class="small dim lead-note">
              支持 OpenAI 兼容协议（DeepSeek、智谱、Kimi、本地 Ollama 等）。<b>不填就是纯离线写作工具</b>，界面上不会出现任何 AI 入口。
              桌面版直连服务商，不受浏览器跨域限制。
            </p>

            <!-- 预设既能点下面的下拉，也能直接点这块牌子：第一次配的人通常是照着牌子找自己的服务商 -->
            <div class="presets">
              <button
                v-for="(p, i) in PRESETS"
                :key="p.label"
                type="button"
                class="preset"
                :class="{ on: presetKey === i }"
                @click="((presetKey = i), applyPreset(i))"
              >
                <b>{{ p.label }}</b>
                <span class="dim small url">{{ p.baseUrl || '自己填 Base URL' }}</span>
              </button>
            </div>
            <label class="small">服务商预设（下拉与上面同一份）
              <select v-model.number="presetKey" @change="applyPreset(presetKey)">
                <option v-for="(p, i) in PRESETS" :key="p.label" :value="i">{{ p.label }}</option>
              </select>
            </label>
            <label class="small">Base URL<input v-model="settings.ai.baseUrl" placeholder="https://api.deepseek.com" /></label>
            <label class="small">API Key
              <span class="key-row">
                <input v-model="settings.ai.apiKey" :type="showKey ? 'text' : 'password'" placeholder="sk-..." autocomplete="off" />
                <button class="text small" type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
              </span>
            </label>
            <label class="small">模型名<input v-model="settings.ai.model" placeholder="deepseek-chat" /></label>
            <div class="row">
              <button @click="test" :disabled="testing">{{ testing ? '测试中…' : '测试连接' }}</button>
              <span class="small" :class="result.startsWith('连接成功') ? 'ok' : 'err'">{{ result }}</span>
            </div>
            <div v-if="models.length" class="row wrap small models">
              <span class="dim">可用模型：</span>
              <button v-for="m in models.slice(0, 30)" :key="m" class="text small" @click="pickModel(m)">{{ m }}</button>
            </div>
            <div class="grp small">生成参数</div>
            <div class="grid2">
              <label class="small">温度<input v-model.number="settings.ai.temperature" type="number" step="0.1" min="0" max="2" /></label>
              <label class="small">最大 Token<input v-model.number="settings.ai.maxTokens" type="number" step="256" /></label>
              <label class="small">上下文窗口<input v-model.number="settings.ai.contextWindow" type="number" step="2000" /></label>
            </div>
            <p class="small dim">
              Key 以混淆形式存在本机浏览器存储里（不是加密）。做成桌面端后改存系统凭据库。<br />
              浏览器宿主下部分服务商会因为跨域直接拒绝请求 —— 那时需要打包成桌面端，或用支持 CORS 的中转。
            </p>
          </div>

          <label class="small">AI 层开关
            <select v-model="settings.ai.configured" style="width: 100%">
              <option :value="true">启用（AI 功能入口出现）</option>
              <option :value="false">关闭（AI 面板全部隐藏，写作不受影响）</option>
            </select>
          </label>
          <div class="tag small status" :class="aiEnabled() ? 'ok' : ''">{{ aiEnabled() ? 'AI 层已解锁' : 'AI 层未启用（填好 Base URL / Key / 模型名并开启开关）' }}</div>
        </div>

        <!-- 排版 -->
        <div v-else-if="tab === 'type'" class="col">
          <div class="grp small">正文</div>
          <label class="small">正文字体
            <select v-model="settings.editor.fontFamily">
              <option v-for="f in FONTS" :key="f.label" :value="f.value">{{ f.label }}</option>
            </select>
          </label>
          <div class="grid2">
            <label class="small">字号 px<input v-model.number="settings.editor.fontSize" type="number" min="12" max="40" /></label>
            <label class="small">行距<input v-model.number="settings.editor.lineHeight" type="number" step="0.1" min="1" max="3" /></label>
            <label class="small">首行缩进（em）<input v-model.number="settings.editor.indent" type="number" step="0.5" min="0" max="4" /></label>
            <label class="small">栏宽 px<input v-model.number="settings.editor.width" type="number" step="40" min="480" max="1400" /></label>
          </div>
          <label class="small">背景主题（Ctrl+. 快速轮换）
            <select v-model="settings.editor.theme">
              <option v-for="th in THEMES" :key="th.k" :value="th.k">{{ th.label }} — {{ th.hint }}</option>
            </select>
          </label>
          <label class="row small"><input type="checkbox" style="width: auto" v-model="settings.editor.typewriter" />打字机滚动（光标固定在屏幕上方三分之一）</label>
          <label class="row small"><input type="checkbox" style="width: auto" v-model="settings.editor.focusParagraph" />段落聚焦（只高亮当前段）</label>

          <hr />
          <div class="grp small">无障碍</div>
          <div class="grid2">
            <label class="small">界面缩放
              <select v-model.number="settings.ui.scale">
                <option :value="0.8">80%</option>
                <option :value="1">100%</option>
                <option :value="1.15">115%</option>
                <option :value="1.3">130%</option>
                <option :value="1.6">160%</option>
              </select>
            </label>
            <div class="row small">
              <button @click="zoomBy(-0.1)">缩小 −</button>
              <button @click="zoomBy(0.1)">放大 +</button>
            </div>
          </div>
          <label class="row small"><input type="checkbox" style="width: auto" v-model="settings.ui.highContrast" />高对比度（加深文字与边框）</label>
          <p class="small dim">
            快捷键不用记：随时按 <kbd>?</kbd> 或点工具栏右侧的「?」看全表。
            <button class="text small" @click="((editorState.helpOpen = true), emit('close'))">打开快捷键一览</button>
          </p>
        </div>

        <!-- 通用 -->
        <div v-else class="col">
          <div class="grp small">写作与保存</div>
          <div class="grid2">
            <label class="small">自动保存延迟 ms<input v-model.number="settings.general.autoSaveMs" type="number" step="500" min="300" /></label>
            <label class="small">每日目标字数<input v-model.number="settings.general.dailyTarget" type="number" step="500" /></label>
          </div>

          <label class="row small"><input type="checkbox" style="width: auto" v-model="settings.general.autoSnapshot" />自动快照</label>
          <div class="grid2">
            <label class="small">按章节保留最近几份自动快照<input v-model.number="settings.general.recentSnapshots" type="number" min="1" max="200" /></label>
            <label class="small">同一章两次快照的最小间隔（分钟）<input v-model.number="settings.general.autoSnapshotIntervalMin" type="number" min="0" max="240" /></label>
          </div>
          <p class="small dim">手动的里程碑快照不受份数限制，永远保留。</p>

          <hr />
          <div class="grp small">备份</div>
          <div class="row">
            <button class="primary" @click="showBackup = true">备份与存储…</button>
            <span class="small dim">打包成 zip 下载 / 从备份恢复 / 看磁盘占用</span>
          </div>
          <div class="row">
            <button @click="backup" :disabled="backing">{{ backing ? '复制中…' : '整个作品复制到文件夹…' }}</button>
            <span class="small dim">另一种选择：直接拷一份目录（含快照），适合放到网盘同步</span>
          </div>
          <div v-if="backupMsg" class="small dim">{{ backupMsg }}</div>
          <p class="small dim">所有配置只存在这台机器上。没有任何遥测，没有自动联网。</p>
        </div>
      </div>
    </div>

    <BackupDialog v-if="showBackup" @close="showBackup = false" />
  </div>
</template>

<style scoped>
/* 遮罩 / 弹窗外壳 / 头部皮肤都在 global.css 里，这里只留本弹窗真正的差异 */
.dialog {
  width: 620px;
  max-height: 82vh;
}
.head .tabs {
  gap: 4px;
}
.head .tabs button {
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12.5px;
}
.head button.on {
  color: var(--text);
  background: var(--bg-elev);
  border-color: var(--line);
  box-shadow: var(--shadow-1);
  font-weight: 500;
}
label.small {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--text-soft);
}
/* 分区标题：让「这些格子是同一类设置」看得出来 */
.grp {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin-top: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--line-soft);
}
.lead-note {
  line-height: 1.7;
  margin: 0;
}
/* 服务商牌子：一排能点的卡片，比下拉好找 */
.presets {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(178px, 1fr));
  gap: 8px;
}
/* 引擎三选一：比单选按钮好点，也比下拉一眼能看全三个选项在说什么 */
.engines {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.engine {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  text-align: left;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg-field);
}
.engine b {
  font-size: 12.5px;
  font-weight: 500;
}
.engine span {
  font-size: 10.5px;
  line-height: 1.5;
}
.engine:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.engine.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 2px var(--ring);
}
.engine.on b {
  color: var(--accent);
  font-weight: 600;
}
/* 这台设备用不了的引擎（浏览器 / 手机上的 DSH）：说清原因，别让作者点了个没反应的按钮 */
.engine.off,
.engine:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.preset {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg-field);
}
.preset b {
  font-size: 12.5px;
  font-weight: 500;
}
.preset .url {
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.preset:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.preset.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 2px var(--ring);
}
.preset.on b {
  color: var(--accent);
  font-weight: 600;
}
.models {
  gap: 4px;
}
.status {
  align-self: flex-start;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.wrap {
  flex-wrap: wrap;
}
.ok {
  color: var(--ok);
}
.err {
  color: var(--danger);
}
.key-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.key-row input {
  flex: 1;
}
.key-row button {
  flex: 0 0 auto;
}
</style>
