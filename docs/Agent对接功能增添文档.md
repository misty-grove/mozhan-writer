# 与 DSH Agent 对接 · 功能增添文档

> **文档目的**：让「离线写作工作台」的 AI 能力接上 DSH 这类 Agent，直接使用 Agent 的技能库。
> **结论先行**：**可以。** 而且分两个互相独立的层次——第一层几乎零代码，第二层才是真对接。
> **适用代码库**：`F:\AI_Write_App\source\writer-app`（Tauri 2 + Vue 3）

---

# 零、一句话结论

| 层次 | 做什么 | 工作量 | 立刻能得到什么 |
|:----------|:--------------------|:--------------------|:--------------------------------------------------|
| **L1 技能库复用** | 把应用的「全局技能库」指向 DSH 的技能目录 | **零代码**（改一个设置项） | 44 个技能立刻可用，含 17 个小说专用技能 |
| **L2 Agent 后端** | 新增 `dsh headless` 后端，替代/补充裸 API 调用 | 中等（约 1 个 Rust 模块 + 3 个前端文件） | 真·多步工具调用、自动读写作品文件、一致性检查、长记忆维护 |

**建议路径**：先做 L1 验证价值（几分钟），确认有效后再决定要不要 L2。

---

# 一、为什么可行：三个硬事实

## 事实 1：DSH 有一次性执行入口，且支持机器可读输出与续接

实测 `dsh headless --help`（本机 `E:\DSH\resources\runtime\cli\bin\dsh.cmd`）：

```
Usage: dsh --profile headless [options] [task...]

Answer one task and exit; the answer goes to stdout and diagnostics to stderr.

Arguments:
  task               the task text; multiple words are joined by spaces, and `-`
                     reads stdin

Options:
  --json             write newline-delimited run events to stdout instead of the
                     final message
  --session-id <id>  adopt the persisted Session with this id; an unknown id is
                     an error
  -h, --help         show this help
```

这三条正是对接所需的三件事：

| 能力 | 对应参数 | 用途 |
|:--------------------|:--------------------|:------------------------------------------------------------|
| 一次性任务执行 | `task` 参数 / stdin（`-`） | 应用发起一次「续写第 12 章」 |
| **流式事件流** | `--json`（NDJSON） | 把过程实时显示在应用的候选区 |
| **会话续接** | `--session-id <id>` | 让同一个作品的多章写作共享上下文与记忆 |

另外，`headless` profile 在本机**已经存在且可用**（`~/.dsh/profiles/headless/`，
由 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` 组成，patch 层为空）。

> **额外红利**：走 DSH 之后，**API Key 由 DSH 自己管理**，应用不需要再存 Key，
> 也不必关心模型名——"AI 不智能"里的调参问题一并消失。

## 事实 2：应用的技能格式与 DSH **完全一致**

这是本次最关键的发现。应用的 `src/core/skills.ts` 开头写着：

```
技能系统（开发文档 B7 / P0-7）
技能 = 提示词 + 流程，不直接执行任何东西，只产生「工具调用意图」。
加载优先级：作品内技能 > 全局技能库 > 内置技能（同名覆盖）
```

它的解析函数 `parseSkillFile()` 读取的字段是 `name` / `description` / `allowed-tools`；
DSH 技能的实际字段分布（实测 44 个技能）：

| 字段 | 有多少个技能在用 |
|:------------|:----------------------------------------------------------------------------------------|
| `name` | 43 |
| `description` | 43 |
| `whenToUse` | 43 |
| `allowed-tools` | 15 |
| `license` / `version` / `author` 等 | 少 |

**应用读的三个字段，DSH 技能全都有。** 也就是说——**格式天然兼容，不需要转换器。**

## 事实 3：应用已经有宿主适配层，加后端不动现有代码路径

```
src/platform/aiBridge.ts   ← 宿主适配：桌面走 Rust 命令，浏览器/移动端走 fetch
src-tauri/src/commands/ai.rs  ← 全应用唯一出网点：ai_models / ai_chat（SSE 流式）
src/core/ai.ts             ← 只管 OpenAI 兼容协议，不感知宿主
src/stores/ai.ts           ← AI 状态
src/components/SkillPanel.vue ← 技能面板
```

`aiBridge.ts` 的注释里明确了设计意图：

> 两边对外暴露同一套原语：**发请求、按行收 SSE 数据**。
> `core/ai.ts` 只管 OpenAI 兼容协议，不感知宿主差异。

**Agent 后端就是这套原语下的第三个实现。** 把 `dsh` 的 NDJSON 事件流适配成同样的
「按行收数据」，上层解析与 UI 一行不用改。

---

# 二、L1：技能库复用（零代码，建议先做这一步）

## 2.1 操作步骤

应用已实现三层技能加载（`mergeSkills()`）：

```
builtin（内置，打包在 exe 里）
  → global（全局技能库，设置里的一个目录）
    → work（作品目录下的 技能\）
```

**把设置里的「全局技能库」指向 `C:\Users\刘运通\.dsh\skills` 即可。**

也可以指向 `E:\Worksplace\DSH-Worksplace\DSH-skill`（同一批技能的镜像）。

## 2.2 立刻可用的技能（DSH 里与小说写作直接相关的 17 个）

| 技能 | 作用 |
|:------------|:----------------------------------------------------------------------------------------|
| `continuation` | 续写六步工作流（加载上下文→对齐章节卡→查衔接伏笔→按文风写→更新记忆→自检） |
| `long-memory` | 长篇记忆系统：逐章摘要、滚动总述、状态追踪 |
| `outline-builder` | 全书/分卷大纲访谈式生成，拆到章节卡片 |
| `project-layout` | 小说项目目录规范（四级结构） |
| `style-imitation` | 文风指纹提取与仿写，去 AI 味 |
| `pre-write-checklist` | 写前 9 项必读文件清单（防长篇失焦） |
| `story-consistency-monitor` | 人物行为/世界规则/时间线一致性检查 |
| `forgotten-elements-reminder` | 「角色失踪 / 伏笔断线」提醒 |
| `scene-structure-techniques` | 场景-续接结构、张力管理 |
| `natural-dialogue-techniques` | 对话写作技法 |
| `outline-builder` / `setting-detector` / `style-detector` / `requirement-detector` | 需求与风格探测 |
| `fantasy-world-building` / `romance-novel-conventions` / `mystery-novel-conventions` | 类型文惯例 |
| `novel-writer-workflow-guide` | 七步法流程引导 |

## 2.3 已知差异与处理（重要）

| 差异 | 影响 | 处理 |
|:--------------------|:--------------------|:------------------------------------------------------------|
| 应用不读 `whenToUse` | 小 | DSH 技能的 `description` 里**已经内嵌触发词**（如「触发词：续写、下一章、接着写……」），应用用 `description` 做目录注入，效果等价 |
| DSH 有 27 个与本应用无关的技能（`nature-*`、`xlsx`、`pptx`、`docx`…） | 中 | 用应用已有的**禁用技能**功能关掉；`skillCatalog()` 只注入启用的 |
| 部分技能带资源目录（`docx` 67 个文件、`skill-creator` 18 个…） | 中 | **用「全局技能库指向目录」的方式不受影响**；**不要**用 zip 导入——应用的 `importFromZip()` 对非文本文件写入空串（见 `skills.ts` 第 140 行），会丢资源 |
| 技能正文里引用了相对路径（如 `../project-layout/SKILL.md`） | 中 | 指向目录时相对引用自然成立；zip 导入会断 |

**结论**：L1 用「指向目录」，不要用导入。

## 2.4 L1 的边界

L1 只解决「**AI 手里有方法论**」，不解决「**AI 能自己动手**」。

应用现在的 AI 调用是「拼一段 prompt → 发 HTTP → 拿回文本」。技能再好，它也只能
**一次性生成**，不能自己翻你的设定库、不能自己更新伏笔台账、不能分多步做完一件事。

**这正是 L2 要补的。**

---

# 三、L2：Agent 后端（真对接）

## 3.1 总体设计

```
┌─ 应用（Tauri + Vue）────────────────────────────┐
│  候选区 / 技能面板 / 作品树                       │
│        ▲                                        │
│  core/ai.ts（协议无关）                          │
│        ▲                                        │
│  platform/aiBridge.ts（宿主适配）                 │
│     ├─ 桌面 → invoke('ai_chat')      ← 现有      │
│     ├─ 浏览器 → fetch                ← 现有      │
│     └─ 桌面 → invoke('agent_run')    ← 新增      │
│                       │                          │
│  src-tauri/commands/agent.rs（新增）              │
│        │ spawn + NDJSON 解析                     │
└────────┼─────────────────────────────────────────┘
         ▼
   dsh --profile headless --json --session-id <id> "<task>"
         │
         ├─ 自带 44 个技能
         ├─ 自带工具（读写文件 / 搜索 / 执行）
         ├─ 自带长记忆与子任务编排
         └─ API Key 由 DSH 管理
```

## 3.2 Rust 侧：新增 `src-tauri/src/commands/agent.rs`

沿用现有 `ai.rs` 的 `Channel<StreamEvent>` 模式，前端适配成本最低。

### 接口定义

```rust
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};

/// DSH 环境探测结果，设置页用来显示「已检测到 / 未安装」。
#[derive(Serialize)]
pub struct AgentInfo {
    pub found: bool,
    /// dsh.cmd 的绝对路径
    pub cli: Option<String>,
    /// 版本号（`dsh -V`）
    pub version: Option<String>,
    /// 可用 profile 列表（headless / desktop …）
    pub profiles: Vec<String>,
    /// 未找到时给用户看的排查提示
    pub hint: Option<String>,
}

/// 一次 Agent 运行的请求参数。
#[derive(Deserialize)]
pub struct AgentRunReq {
    /// 任务文本
    pub task: String,
    /// 作品根目录：Agent 的 cwd，也是它被允许读写的范围
    pub cwd: String,
    /// 会话 id：同一作品复用，实现跨章记忆
    pub session_id: Option<String>,
    /// profile，默认 headless
    pub profile: Option<String>,
    /// 权限档位：read_only / write_in_cwd（见 §3.6）
    pub permission: Option<String>,
}

/// 运行结果收尾。
#[derive(Serialize)]
pub struct AgentRunOut {
    /// 进程退出码；-1 表示被取消
    pub code: i32,
    /// 最终消息（--json 模式下由事件流累积；非 --json 时是 stdout 全文）
    pub final_text: String,
}

/// 事件流：与 ai.rs 的 StreamEvent 保持同构，前端可复用同一套解析。
#[derive(Serialize, Clone)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 一行原始 NDJSON（前端解析，规则集中在 JS 侧）
    Line { d: String },
    /// 子进程已启动
    Started { pid: u32 },
    /// DSH 往 stderr 写的一行（诊断信息）
    Diag { d: String },
}
```

### 命令签名

```rust
#[tauri::command]
pub async fn agent_probe() -> Result<AgentInfo> { /* 见 §3.7 探测逻辑 */ }

#[tauri::command]
pub async fn agent_run(
    req: AgentRunReq,
    on_event: Channel<AgentEvent>,
) -> Result<AgentRunOut> { /* 见下方实现要点 */ }

#[tauri::command]
pub async fn agent_cancel(run_id: String) -> Result<()> { /* kill 子进程 */ }
```

### 实现要点

1. **命令拼接**（注意参数顺序与平台差异）：
   ```
   dsh --profile headless --json [--session-id <id>] "<task>"
   ```
2. **spawn 参数**：
   - `current_dir(req.cwd)` —— Agent 的工作目录就是作品目录
   - `stdout(Stdio::piped())`、`stderr(Stdio::piped())`
   - Windows 上用 `CREATE_NO_WINDOW`（`0x08000000`），避免闪黑框
   - 环境变量：继承父进程 + 注入权限档位对应的配置
3. **读取**：`BufReader::new(stdout).lines()`，每行 `on_event.send(AgentEvent::Line { d })`
   —— 与 `ai.rs` 里 SSE 的处理方式同构，逻辑简单
4. **超时**：默认 10 分钟（长篇续写可能很久），可通过设置调整；超时走 `agent_cancel`
5. **取消**：用 `RunId -> Child` 的 `Mutex<HashMap>` 保存句柄，`agent_cancel` 里 `child.kill()`
6. **并发**：同一时刻只允许一个 run（应用现有 AI 也是串行），避免多个 Agent 争作品文件

### 事件流映射（DSH NDJSON → 应用 UI）

| DSH 事件（示意） | 应用呈现 |
|:------------|:----------------------------------------------------------------------------------------|
| 开始 / 模型信息 | 候选区顶部状态行 |
| 思考 / 中间步骤 | 折叠的「过程」区 |
| 工具调用（读写文件、搜索） | 「正在读取 设定/人物设定.md」这类行 |
| 文本增量 | 候选区正文流式追加 |
| 最终消息 | 候选区定稿 + 启用「采纳」按钮 |
| 错误 | 错误条 + 原始信息可展开 |

> **事件字段名必须在开发时用真实输出核对一次**（`dsh --profile headless --json "..."`），
> 本文给出的是结构而非逐字段契约。

## 3.3 前端接入点（三处小改动）

### ① `src/platform/aiBridge.ts` —— 加第三条路径

```ts
export type AiBackend = 'api' | 'agent'

/** 按设置选择后端；Agent 不可用时自动回落 api */
export async function runAgentStream(
  req: { task: string; cwd: string; sessionId?: string; permission?: string },
  onLine: SseLineHandler
): Promise<RawHttpOut> {
  if (!(await useNativeHttp())) {
    return { status: 0, body: 'Agent 后端需要桌面端（移动端与浏览器不支持）' }
  }
  const { Channel } = await import('@tauri-apps/api/core')
  const ch = new Channel<{ t: 'line' | 'started' | 'diag'; d?: string }>()
  ch.onmessage = (m) => { if (m?.t === 'line' && m.d) onLine(m.d) }
  return tauriInvoke<RawHttpOut>('agent_run', { req, onEvent: ch })
}
```

### ② `src/core/ai.ts` —— 加 provider 维度

现有实现只管「拼 OpenAI 兼容请求 → 收 SSE 行」。新增一条并行的
`runWithAgent(task, ctx)`，把**同一份上下文装配结果**（作品大纲、设定库、近 N 章摘要、
上一章结尾）拼成一段任务文本交给 Agent。

> **关键点**：应用已经实现了「上下文装配」这件事，**不要重写**。
> Agent 需要的上下文，正是现有装配逻辑的产物。

### ③ `src/stores/ai.ts` + 设置页 —— 加一个开关

```
AI 引擎：  ○ 直连 API（现状，需填 Key）
           ● DSH Agent（需本机安装 DSH；Key 由 DSH 管理）
           ○ 两者并存（Agent 为主，失败回落 API）
```

并存模式最稳：DSH 没装 / 没登录时，行为与现在完全一致。

## 3.4 目录约定的冲突（**这一节最容易踩坑，务必先解决**）

DSH 的小说技能是按它自己的项目结构写的。以 `continuation` 技能正文为例，它要求：

```
memory/story-so-far.md
memory/chapter-summaries.md
spec/outline/chapters/<下一章>.md
```

而**本应用的目录约定是**：

```
大纲/  设定/  正文/  记忆/  技能/  作品信息.md
```

**两边不一致。** 如果直接把作品目录交给 DSH，`continuation` 会找不到文件，
然后按技能里的兜底逻辑告诉用户「这是新项目或记忆没落盘」——**表现为"AI 又变笨了"**。

### 两个解法

| 方案 | 做法 | 评价 |
|:--------------------|:--------------------|:------------------------------------------------------------|
| **A. 写一个适配技能**（推荐） | 在作品目录的 `技能/` 或全局技能库里放一个 `novel-app-layout/SKILL.md`，用 `description` 声明"本项目用 大纲/设定/正文/记忆 结构"，并在正文里给出「DSH 技能期望路径 ↔ 应用实际路径」的对照表 | 一次写好，所有 DSH 技能都受益；不动用户数据 |
| **B. 让应用兼容两套路径** | 应用同时读写 `spec/`+`memory/`+`stories/` 与 `大纲/`+`设定/`+`正文/`+`记忆/` | 改动大、目录变乱，不推荐 |

**方案 A 的适配技能草稿：**

```markdown
---
name: novel-app-layout
description: 【本项目专用】离线写作工作台的作品目录是 大纲/ 设定/ 正文/ 记忆/ 技能/，
  与 DSH 小说技能默认的 spec/ memory/ stories/ 不同。当需要定位作品文件时读本技能。
---

# 离线写作工作台 · 目录对照

本项目（作品根目录）使用以下结构：

| 本应用 | DSH 技能默认写法 | 说明 |
|:--------------------|:--------------------|:------------------------------------------------------------|
| `作品信息.md` | `book.md` | 书名、目标字数 |
| `大纲/大纲.md` | `spec/outline/book.md` | 全书大纲 |
| `大纲/` 下的其他 .md | `spec/outline/volume-XX.md` | 分卷大纲 |
| `设定/人物设定.md`、`设定/*.md` | `spec/characters/…` | 人物与世界观 |
| `正文/第NNN章 *.md` | `stories/第NNN章.md` | 章节正文 |
| `记忆/逐章摘要.md` | `memory/chapter-summaries.md` | 逐章摘要 |
| `记忆/伏笔台账.md` | `spec/tracking/*.json` | 伏笔状态 |

**执行任何技能前，先用本表把技能里写的路径翻译成实际路径；不要因为找不到
`spec/` 或 `stories/` 就判定项目为空。**
```

## 3.5 会话延续：让 Agent 记住这本书

```
session_id = "novel:" + <作品目录的稳定标识>
```

- 首次运行时**不传** `--session-id`，从 DSH 的 `--json` 事件里取回新会话 id 并保存
- 之后同一作品的每次调用都带上它 → 跨章记忆自然成立
- 会话 id 存在作品目录里（如 `作品信息.md` 的 frontmatter 加 `agentSession` 字段），
  换电脑不会串
- 换作品 = 换 session，**不要复用**，否则前后文会互相污染

## 3.6 权限与安全（**必须有，否则别上这一层**）

`dsh headless` 是**带工具的 Agent**：它能读写文件、执行命令。这和应用现有的
「AI 产出进候选区，作者点了采纳才落盘」的设计原则**直接冲突**。

必须做三层约束：

| 层 | 措施 |
|:------------|:----------------------------------------------------------------------------------------|
| **限定目录** | `current_dir` 固定为作品目录；在 DSH 的 profile patch 里限制工具可访问的根 |
| **权限档位** | 设置里给两档：**只读**（默认，Agent 只能读作品、产出文本给候选区）/ **可写**（显式开启，允许 Agent 直接更新记忆库与伏笔台账） |
| **审计可见** | 复用现有的「装配前显示这次会喂什么」思路，把 Agent **打算动哪些文件**在候选区列出来 |

**建议默认只读**：让 Agent 负责「生成 + 检查」，落盘仍由作者点采纳。
只有"记忆整理"这类重复劳动值得开「可写」。

在一个受限 profile 里配置，例如
`~/.dsh/profiles/headless/cordis.patch.yml`（当前为空数组 `[]`）里追加：

```yaml
# 示例：为写作应用场景限制工具范围（具体键名以 DSH 配置 schema 为准）
- id: <工具插件 id>
  config:
    allowedRoots: ['<作品根目录>']
```

> 具体可用的限制项需要查 `dsh --dump-config-schema` 或 DSH 插件文档；
> **开发时先跑一次 `dsh --dump-config-schema` 确认字段**。

## 3.7 DSH 探测逻辑（`agent_probe`）

按顺序找，找到即返回：

1. 设置里用户手填的 `dsh` 路径（最高优先级）
2. `PATH` 里的 `dsh` / `dsh.cmd`
3. 默认安装位置：`E:\DSH\resources\runtime\cli\bin\dsh.cmd`
4. 都没有 → `found: false`，并给出提示：
   「未检测到 DSH。请安装 DSH 桌面端，或在设置里手动指定 dsh 可执行文件路径；
   也可以继续使用『直连 API』模式。」

同时用 `dsh -V` 取版本、扫 `~/.dsh/profiles/` 取可用 profile 列表。

## 3.8 降级策略

| 情况 | 行为 |
|:------------|:----------------------------------------------------------------------------------------|
| DSH 未安装 | 设置页 Agent 项置灰 + 说明；自动用直连 API |
| DSH 已装但未登录 | 首次运行报错时提示「请在 DSH 里完成登录」，并回落到直连 API |
| Agent 运行超时 | 显示已产出的部分，不丢内容 |
| Agent 崩溃 | 保留 stderr 便于排查，候选区已有的文本不回滚 |

---

# 四、界面上怎么体现

## 4.1 设置页 · 新增「AI 引擎」区块

```
┌─ AI 引擎 ────────────────────────────────────┐
│ ○ 直连 API        Base URL [________]        │
│                   API Key  [________]        │
│                   [测试连接]                  │
│                                              │
│ ● DSH Agent      dsh 路径 [自动检测到 ✓]      │
│                   版本 v0.x    profile [headless▾] │
│                   session 已绑定本作品 ✓       │
│                   权限  ○只读 ●可写作品目录     │
│                   [测试一次]                  │
│                                              │
│ ○ 两者并存（Agent 优先，失败回落 API）         │
└──────────────────────────────────────────────┘
```

## 4.2 技能面板（`SkillPanel.vue`）· 增强

现在只有「内置 / 全局 / 作品内」三个来源。接上 Agent 后加一列
**「Agent 可用」**，展示 DSH 侧的技能清单与启用状态，并标明
「此技能由 Agent 执行，应用无法预览其工具调用细节」。

## 4.3 生成过程可视化（L2 的核心体验差异）

```
┌─ 第 013 章 · 候选 ──────────────────────────┐
│ ⟳ Agent 运行中…  2 分 14 秒                  │
│                                             │
│ ▾ 过程                                      │
│   读取 大纲/大纲.md                          │
│   读取 设定/人物设定.md                       │
│   读取 记忆/逐章摘要.md                       │
│   读取 记忆/伏笔台账.md          ← 3 条未回收  │
│   检索 正文/ 中「尺木缚锁」                   │
│   写作中…                                   │
│                                             │
│ ▾ 正文                                      │
│   白露把葫芦放在桌上时，那声轻响比往常…        │
│                                             │
│ ▾ 自检                                      │
│   ⚠ 藿藿已连续 6 章未出场                     │
│   ⚠ 伏笔「交易命途的代价」埋设于 第 004 章     │
│                                             │
│ [采纳到正文] [存入候选] [丢弃] [看会话]        │
└─────────────────────────────────────────────┘
```

这套 UI **大部分已存在**（候选区、装配面板、自检），L2 主要是把数据源换成 Agent 事件流。

---

# 五、实施优先级（按关键程度，不含工期）

| 序 | 事项 | 关键度 | 说明 |
|:----------|:--------------------|:--------------------|:--------------------------------------------------|
| 1 | **把全局技能库指向 `~/.dsh/skills` 并实测效果** | P0 | 零代码，先验证「有方法论」是否已解决大部分问题 |
| 2 | **写 `novel-app-layout` 适配技能** | P0 | 不做这个，L2 一定会表现为"又变笨了"（§3.4） |
| 3 | `agent_probe` + 设置页引擎开关 | P0 | 没有探测就没有可用的降级 |
| 4 | `agent_run` + 事件流接入候选区 | P0 | L2 主体 |
| 5 | 权限档位（只读/可写） | P0 | 安全底线，不能后补 |
| 6 | `--session-id` 绑定作品 | P1 | 决定跨章记忆好不好用 |
| 7 | 过程可视化（工具调用行） | P1 | 体验差异最大的一处 |
| 8 | 技能面板的「Agent 可用」列 | P2 | 便利性 |
| 9 | 「两者并存」模式 | P2 | 稳，但可后置 |

---

# 六、验收标准

**L1**
- [ ] 设置全局技能库为 `~/.dsh/skills` 后，技能面板出现 `continuation`、`long-memory` 等
- [ ] 禁用 `nature-*` / `xlsx` / `pptx` 后，AI 请求里不再包含它们
- [ ] 用「续写第 2 章」实测，产出比接入前**明显更贴合已有设定**

**L2**
- [ ] 未安装 DSH 时：Agent 选项置灰，应用行为与现在完全一致
- [ ] 安装 DSH 后：能检测到路径与版本，`[测试一次]` 返回正常结果
- [ ] 发起续写：候选区能看到工具调用过程与正文流式输出
- [ ] 同一作品第二次续写：Agent 记得前文（session 生效）
- [ ] **只读档位下，运行前后作品目录的文件哈希不变**
- [ ] 中途取消：进程被真正结束，不残留
- [ ] 断网 / DSH 报错：候选区保留已生成部分，错误可读

---

# 七、风险与注意

| 风险 | 说明 | 对策 |
|:--------------------|:--------------------|:------------------------------------------------------------|
| **目录约定不一致** | 见 §3.4，最容易表现为"AI 变笨" | 先做适配技能（P0-2） |
| **Agent 越权写文件** | 与「产出进候选区」原则冲突 | 默认只读；可写需显式开启 |
| **DSH 事件字段变动** | `--json` 是 CLI 契约，版本升级可能变 | 适配集中在一处；用 `dsh -V` 做版本门槛 |
| **子进程残留** | App 崩溃时 dsh 可能变孤儿进程 | 应用退出时统一 kill；Windows 用 Job Object 绑定 |
| **运行时间长** | 长篇续写可能数分钟 | 超时可设；期间允许取消；不阻塞其它操作 |
| **技能质量参差** | 44 个技能里大量与写作无关 | 启用制 + 分类标签 |
| **跨机不一致** | 换电脑 DSH 技能库不同 | 允许"导出作品时附带所需技能" |

---

# 八、附录：本次已实测的环境事实

| 项 | 值 |
|:------------|:----------------------------------------------------------------------------------------|
| DSH CLI | `E:\DSH\resources\runtime\cli\bin\dsh.cmd`（存在） |
| headless 入口 | `dsh --profile headless [--json] [--session-id <id>] <task>`（`--help` 实测） |
| headless profile | `~/.dsh/profiles/headless/`，由 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` 组成，patch 层为空 |
| 技能目录 | `C:\Users\刘运通\.dsh\skills\`（44 个），镜像 `E:\Worksplace\DSH-Worksplace\DSH-skill\` |
| 技能字段 | `name` 43、`description` 43、`whenToUse` 43、`allowed-tools` 15 |
| 应用技能格式 | `name` / `description` / `allowed-tools`（`src/core/skills.ts`） |
| 应用 AI 出网点 | `src-tauri/src/commands/ai.rs`（唯一出网文件） |
| 应用宿主适配 | `src/platform/aiBridge.ts` |
| 作品目录结构 | `大纲/ 设定/ 正文/ 记忆/ 技能/ 作品信息.md`（实测 `AI功能测试\测试作品·星轨`） |

> **一处未实测**：本文未真正执行一次 `dsh --profile headless "<task>"`（会产生 API 费用）。
> 开发第一步建议手动跑一次，用真实输出核对事件字段名，再写 Rust 侧的解析。
> 命令示例：
> ```powershell
> dsh --profile headless --json "读取当前目录的 大纲/大纲.md，用一句话概括这本小说要讲什么"
> ```
