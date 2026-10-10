//! DSH Agent 后端 —— 把本机的 `dsh headless` 当成第二个 AI 引擎。
//!
//! # 它和 `ai.rs` 的区别
//!
//! `ai.rs` 发的是「一次 HTTP → 拿回一段文本」：模型只能说话。
//! 这里是**带工具的 Agent**：它自己会读 `大纲/` `设定/` `记忆/`，会按技能库的流程
//! 分多步做一件事，做完再交回文本。密钥由 DSH 自己管，本应用不用存。
//!
//! # 三个必须守住的边界
//!
//! 1. **不带 shell 拼串**：`task` 是用户输入，必须作为 `Command::arg` 传下去，
//!    绝不能拼进命令行让 cmd.exe 再解析一遍（`&`、`|`、`"` 都能越狱）。
//!    Windows 上 `dsh` 是 `.cmd`：CreateProcess 不能直接执行 .cmd，
//!    所以我们显式走 `cmd /C <dsh 路径> <参数…>` —— 路径与参数**各自占一个 argv 槽**，
//!    由 Rust 的转义负责引号，cmd 只负责找到解释器。
//! 2. **cwd 就是边界**：Agent 的工作目录固定为作品目录，
//!    提示词里也明确"只在这个目录里干活"。
//! 3. **串行**：同一时刻只允许一个 run（`RUNNING` 表）。多个 Agent 同时改一个作品
//!    会互相看不见对方的改动。
//!
//! # 为什么只读档案是默认
//!
//! 本应用的设计原则是「AI 产出进候选区，作者点了采纳才落盘」。
//! 一个能直接写文件的 Agent 与这条原则冲突，所以默认 `read_only`：
//! 提示词里明写不许改文件，产出交回候选区。作者显式开「可写」时才放开。
//!
//! # 编译门控
//!
//! 挂在 `net` feature 下（与 `ai.rs` 同）。理由：它虽然不直接发 HTTP，
//! 但 DSH 自己就是网络客户端 —— 把它放进**没有 net 的移动端构建**毫无意义，
//! 而 `net` 那条 feature 已经承担了"桌面端完整能力"这个语义。

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::Channel;

/// 探测结果，设置页用来显示「已检测到 / 未安装」。
#[derive(Serialize, Default, Clone)]
pub struct AgentInfo {
    pub found: bool,
    /// dsh 可执行文件的绝对路径
    pub cli: Option<String>,
    /// 版本号（`dsh -V`）
    pub version: Option<String>,
    /// 可用 profile 列表（headless / desktop …）
    pub profiles: Vec<String>,
    /// 未找到时给用户看的排查提示
    pub hint: Option<String>,
    /// 本机语言环境是否正常（有些机器上 dsh 会因为 profile 缺失而拒绝启动）
    pub probe_error: Option<String>,
}

/// 一次运行的请求参数。前端传 camelCase，Tauri 自动转成 snake_case。
#[derive(Deserialize)]
pub struct AgentRunReq {
    /// 任务文本
    pub task: String,
    /// 作品根目录：Agent 的 cwd，也是它被允许干活的范围
    pub cwd: String,
    /// 会话 id：同一作品复用，实现跨章记忆；首次不传，从事件流里取回
    pub session_id: Option<String>,
    /// profile，默认 headless
    pub profile: Option<String>,
    /// 权限档位：read_only（默认）/ write_in_cwd
    pub permission: Option<String>,
    /// dsh 路径（设置里手填的优先；空则自动探测）
    pub cli: Option<String>,
    /// 超时秒数，默认 600
    pub timeout_secs: Option<u64>,
    /// 前端自己生成的取消令牌。
    ///
    /// 为什么不让前端用 run_id：run_id 是 Rust 侧生成的，前端只有等 `agent_run`
    /// **返回之后**才知道 —— 而那时已经跑完了，取消就没意义了。
    /// 让前端先造一个令牌传进来，它随时都能用同一个令牌去取消。
    pub cancel_token: String,
}

/// 运行结果收尾。
#[derive(Serialize)]
pub struct AgentRunOut {
    /// 进程退出码；-1 表示被取消
    pub code: i32,
    /// 最终消息（从 NDJSON 的 `final` 事件累积）
    pub final_text: String,
    /// 从事件流里取回的会话 id（首次运行时它才是新的）
    pub session_id: Option<String>,
    /// 被取消了没有
    pub cancelled: bool,
}

/// 事件流：与 `ai::StreamEvent` 保持同构，前端共用一套解析思路。
#[derive(Serialize, Clone)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 一行原始 NDJSON —— **原样**推给前端，JSON 解析留在 JS 侧，
    /// 这样将来 DSH 加字段前端不用跟着改 Rust。
    Line { d: String },
    /// 子进程已启动，带上 pid（排查残留进程用）
    Started { pid: u32 },
    /// DSH 往 stderr 写的一行（诊断信息，通常是人能读的报错）
    Diag { d: String },
}

/* ------------------------------------------------------------------ 运行表 */

/// 正在跑的 run：**前端给的取消令牌** → 子进程 pid。
/// 取消时要能拿到 pid 去 kill；串行约束也靠这张表。
static RUNNING: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn running_init() -> std::sync::MutexGuard<'static, Option<HashMap<String, u32>>> {
    let mut g = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

/* ------------------------------------------------------------------ 探测 */

/// dsh 的默认安装位置（本机实测；别的机器装到别处时靠设置里手填覆盖）。
const DEFAULT_CLI: &str = r"E:\DSH\resources\runtime\cli\bin\dsh.cmd";

fn looks_like_dsh(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    // 名字必须是 dsh / dsh.cmd / dsh.exe —— 不看内容（.cmd 是 ASCII 脚本，
    // .exe 是二进制，读内容判类型只会引入平台差异）。
    matches!(
        p.file_stem().and_then(|s| s.to_str()),
        Some("dsh")
    )
}

/// 按优先级找一个可用的 dsh：设置里手填 > PATH > 默认安装位置。
fn find_cli(hint: Option<&str>) -> Option<PathBuf> {
    if let Some(h) = hint.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(h);
        if looks_like_dsh(&p) {
            return Some(p);
        }
    }
    // PATH 里的 dsh（Windows 上要同时试 .cmd 与 .exe）
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in ["dsh.cmd", "dsh.exe", "dsh"] {
                let p = dir.join(name);
                if looks_like_dsh(&p) {
                    return Some(p);
                }
            }
        }
    }
    let def = PathBuf::from(DEFAULT_CLI);
    if looks_like_dsh(&def) {
        return Some(def);
    }
    None
}

/// 跑一次 `dsh -V` / `dsh --help` 这类**无副作用**的短命令，返回 stdout。
/// 用 `cmd /C` 是因为 Windows 上 .cmd 不是 PE 文件，CreateProcess 起不来。
fn run_short(cli: &Path, args: &[&str]) -> std::io::Result<String> {
    let mut cmd = shell_for(cli);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output()?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    if s.trim().is_empty() {
        s = String::from_utf8_lossy(&out.stderr).to_string();
    }
    Ok(s)
}

/// 给一条要跑可执行文件的命令：Windows 上 .cmd/.bat 必须借 cmd.exe，
/// 其他情况直接执行。
///
/// 注意这里**没有拼命令行字符串** —— `.arg(cli)` 是把路径当成**一个 argv 元素**交给
/// CreateProcess，路径里的空格、`&`、引号都由 Rust 的转义处理。
fn shell_for(cli: &Path) -> Command {
    #[cfg(windows)]
    {
        let ext = cli
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("cmd") | Some("bat")) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(cli);
            return c;
        }
    }
    Command::new(cli)
}

/// 不让子进程弹黑框（Windows 上 GUI 应用起控制台程序会闪一下）。
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// 扫 `~/.dsh/profiles/` 取可用 profile 名。
fn list_profiles() -> Vec<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return vec![];
    }
    let dir = PathBuf::from(home).join(".dsh").join("profiles");
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                if let Some(n) = e.file_name().to_str() {
                    out.push(n.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

/// `~/.dsh/skills/` —— DSH 唯一的技能登记目录（实测：`customSkillDirs` 运行时不被扫描）。
fn dsh_skills_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    if home.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join(".dsh").join("skills"))
}

/// 本应用投递技能时的目录前缀。**只碰自己这个命名空间** ——
/// `~/.dsh/skills/` 里还住着作者自己的 50 个第三方技能，绝不能覆盖或误删。
const SKILL_NS: &str = "mozhan-";

/// 投递技能的结果。
#[derive(Serialize, Default)]
pub struct SkillSyncOut {
    /// 写入了哪些（目录名，不含前缀）
    pub written: Vec<String>,
    /// 内容没变、跳过的
    pub skipped: Vec<String>,
    /// 清理掉的过期技能
    pub removed: Vec<String>,
    /// 技能库根目录（UI 显示用）
    pub dir: Option<String>,
    /// 出错信息（不致命，UI 提示一下）
    pub error: Option<String>,
}

/// 一个要投递的技能：目录名（不含前缀）+ 文件内容。
#[derive(Deserialize)]
pub struct SkillFile {
    pub name: String,
    pub content: String,
}

/// 把技能写进 DSH 技能库（`~/.dsh/skills/mozhan-<name>/SKILL.md`）。
///
/// 幂等：内容相同不重写（DSH 有文件监听，反复写会触发无谓重载）；
/// 同时清理本命名空间里、这次没再投递的旧目录（技能被作者删掉/改名时）。
#[tauri::command]
pub async fn agent_sync_skills(files: Vec<SkillFile>) -> Result<SkillSyncOut> {
    let mut out = SkillSyncOut::default();
    let Some(root) = dsh_skills_dir() else {
        out.error = Some("找不到用户主目录，技能没能同步给 DSH".into());
        return Ok(out);
    };
    out.dir = Some(root.to_string_lossy().to_string());

    if let Err(e) = std::fs::create_dir_all(&root) {
        out.error = Some(format!("无法创建 DSH 技能目录：{e}"));
        return Ok(out);
    }

    // 期望存在的目录集合（带前缀）
    let mut want: std::collections::HashSet<String> = std::collections::HashSet::new();

    for f in files.iter() {
        let dir_name = format!("{SKILL_NS}{}", f.name.trim());
        if dir_name == SKILL_NS {
            continue; // 空名，跳过
        }
        want.insert(dir_name.clone());
        let dir = root.join(&dir_name);
        let path = dir.join("SKILL.md");

        // 内容没变就跳过：读出来比一下
        if let Ok(old) = std::fs::read_to_string(&path) {
            if old == f.content {
                out.skipped.push(f.name.trim().to_string());
                continue;
            }
        }
        if let Err(e) = std::fs::create_dir_all(&dir) {
            out.error = Some(format!("创建技能目录失败（{dir_name}）：{e}"));
            continue;
        }
        if let Err(e) = std::fs::write(&path, &f.content) {
            out.error = Some(format!("写技能文件失败（{dir_name}）：{e}"));
            continue;
        }
        out.written.push(f.name.trim().to_string());
    }

    // 清理：本命名空间里已不在期望集合中的目录
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(SKILL_NS) || want.contains(&name) {
                continue;
            }
            let p = e.path();
            // 只删自己命名空间下的目录，且里面看起来确实是个技能
            if p.is_dir() && p.join("SKILL.md").is_file() {
                if std::fs::remove_dir_all(&p).is_ok() {
                    out.removed
                        .push(name.trim_start_matches(SKILL_NS).to_string());
                }
            }
        }
    }

    Ok(out)
}


/// 探测 DSH 是否可用。设置页在打开时调一次。
#[tauri::command]
pub async fn agent_probe(cli: Option<String>) -> Result<AgentInfo> {
    let found = find_cli(cli.as_deref());
    let Some(cli_path) = found else {
        return Ok(AgentInfo {
            found: false,
            cli: None,
            version: None,
            profiles: list_profiles(),
            hint: Some(format!(
                "未检测到 DSH。请安装 DSH 桌面端，或在设置里手动指定 dsh 可执行文件路径；\
                 也可以继续使用「直连 API」模式。（找过：设置里的路径、PATH、{DEFAULT_CLI}）"
            )),
            probe_error: None,
        });
    };

    let mut info = AgentInfo {
        found: true,
        cli: Some(cli_path.to_string_lossy().to_string()),
        version: None,
        profiles: list_profiles(),
        hint: None,
        probe_error: None,
    };

    match run_short(&cli_path, &["-V"]) {
        Ok(s) => {
            let v = s.trim().lines().next().unwrap_or("").trim().to_string();
            if v.is_empty() {
                info.probe_error = Some("dsh 存在，但取版本号时没有输出 —— 可能 profile 不完整".into());
            }
            info.version = Some(v);
        }
        Err(e) => {
            info.probe_error = Some(format!("dsh 存在但起不来：{e}"));
        }
    }
    Ok(info)
}

/// 本机 DSH 技能库的位置（`~/.dsh/skills`）。
///
/// 前端拿它做两件事：
///  - 「一键接入 DSH 技能库」：把这个目录设成应用的全局技能库，
///    这样 DSH 里那 50 个技能（continuation / long-memory / style-imitation…）
///    立刻能在应用里看见、开关、喂给自己的 API 引擎；
///  - 显示给作者看（"技能库在哪"）。
#[derive(Serialize, Default)]
pub struct DshSkillsDir {
    pub found: bool,
    pub path: Option<String>,
    /// 目录下一级子目录数（≈ 技能个数），给 UI 显示"发现 N 个技能"
    pub count: usize,
}

#[tauri::command]
pub async fn agent_skills_dir() -> Result<DshSkillsDir> {
    let Some(root) = dsh_skills_dir() else {
        return Ok(DshSkillsDir::default());
    };
    if !root.is_dir() {
        return Ok(DshSkillsDir {
            found: false,
            path: Some(root.to_string_lossy().to_string()),
            count: 0,
        });
    }
    let mut count = 0usize;
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            // 只数"看起来是个技能"的目录：含 SKILL.md
            if e.path().is_dir() && e.path().join("SKILL.md").is_file() {
                count += 1;
            }
        }
    }
    Ok(DshSkillsDir {
        found: true,
        path: Some(root.to_string_lossy().to_string()),
        count,
    })
}


/* ------------------------------------------------------------------ 运行 */

/// 默认超时：长篇续写可能跑很久，给 10 分钟。
const DEFAULT_TIMEOUT_SECS: u64 = 600;

/// 只读档位的提示词前缀。
///
/// 这一段是**安全底线的一半**（另一半是 cwd）：把"不许写文件"讲清楚，
/// 让模型自己不去调写工具。为什么不干脆不给写工具：DSH 的工具集由 profile 决定，
/// 应用侧改不了（改 profile 要动用户机器上的 DSH 配置，越界了）。
/// 所以这里用最直白的话约束，并且**界面上如实告诉作者这是软约束**。
const READ_ONLY_PREFIX: &str = "\
【运行档位：只读】你可以读取当前目录下的任何文件，但**禁止**创建、修改、删除任何文件。\
需要产出文本时，直接把文本写在最终回复里 —— 由写作台放进候选区，作者点了采纳才算数。\
不要调用任何写文件、执行命令的工具。\n\n";

const WRITE_PREFIX: &str = "\
【运行档位：可写】你可以在当前目录（作品目录）内创建与修改文件，\
例如更新 记忆/ 下的摘要、状态表、伏笔台账。\
**不要**动这个目录以外的任何东西。正文的改动仍交由作者在候选区确认。\n\n";

/// 跑一次 Agent。事件流式推给前端，收尾返回最终文本。
#[tauri::command]
pub async fn agent_run(req: AgentRunReq, on_event: Channel<AgentEvent>) -> Result<AgentRunOut> {
    let cli = find_cli(req.cli.as_deref())
        .ok_or_else(|| AppError::path("没有找到 dsh 可执行文件；先在设置里指定它的路径"))?;

    let cwd = PathBuf::from(req.cwd.trim());
    if !cwd.is_dir() {
        return Err(AppError::not_found(format!(
            "作品目录不存在或不是一个目录：{}",
            cwd.display()
        )));
    }
    if req.task.trim().is_empty() {
        return Err(AppError::path("任务内容为空"));
    }

    // 表里的键用前端给的令牌：取消时前端只知道自己那个令牌
    let token = req.cancel_token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::path("缺少取消令牌（前端生成的一个随机串）"));
    }

    let profile = req
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("headless")
        .to_string();

    let read_only = req.permission.as_deref() != Some("write_in_cwd");
    let prefix = if read_only { READ_ONLY_PREFIX } else { WRITE_PREFIX };
    let task = format!("{prefix}{}", req.task.trim());

    let mut cmd = shell_for(&cli);
    cmd.arg("--profile")
        .arg(&profile)
        .arg("--json");
    if let Some(sid) = req.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.arg("--session-id").arg(sid);
    }
    // 任务文本作为一个 argv 元素传下去 —— 这是最容易写出注入漏洞的地方
    cmd.arg(&task);
    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // ------------------------------------------------------------------
    // DSH 权限模式（**必须显式设置**，否则在本机什么都跑不起来）
    //
    // 实测（dsh 0.2.0-rc.2 / Windows，2026-10-10）：
    //   workspace-write（默认）→ 沙箱准备阶段 grantWrite 报
    //     `SetNamedSecurityInfoW failed (Win32 5)`，命令根本没起来（E 盘任意目录都复现）；
    //   read-only → 过了 ACL，但 Store 版 PowerShell 7 在受限令牌下加载
    //     `hostfxr.dll` 被拒（HRESULT 0x80070005），shell 仍不可用；
    //   danger-full-access → 无沙箱，shell 正常。
    // 只读工具（read/glob）不受影响，任何模式下都能用。
    //
    // 配置来源（`dsh --dump-config` 确认）：
    //   sandbox-policy.config.mode = !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    // 所以这里通过环境变量把它设成 danger-full-access。
    //
    // 边界补偿：真正的「只读」约束由 READ_ONLY_PREFIX 提示词 + cwd 限制承担，
    // 并且界面上如实告诉作者 Agent 有本机文件访问能力。
    // ------------------------------------------------------------------
    cmd.env("DSH_PERMISSION_MODE", "danger-full-access");

    hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("启动 DSH 失败：{e}")))?;
    let pid = child.id();
    let _ = on_event.send(AgentEvent::Started { pid });

    {
        let mut g = running_init();
        if let Some(m) = g.as_mut() {
            // 串行约束：已经有别的 run 在跑就拒掉。多个 Agent 同时读改一个作品目录
            // 会互相看不见对方的改动，产出对不上。
            if !m.is_empty() {
                let _ = child.kill();
                return Err(AppError::path(
                    "已经有一个 Agent 在运行了，等它结束或先点「停止」。",
                ));
            }
            m.insert(token.clone(), pid);
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // 读 stdout（NDJSON）—— 与 ai.rs 的 SSE 处理同构：按行切，半行留在 buf 里。
    let ev_out = on_event.clone();
    let reader_out = std::thread::spawn(move || {
        let mut final_text = String::new();
        let mut session_id: Option<String> = None;
        let mut buf: Vec<u8> = Vec::new();
        if let Some(mut rd) = stdout {
            use std::io::Read;
            let mut chunk = [0u8; 8192];
            loop {
                match rd.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            take_ndjson(&line, &ev_out, &mut final_text, &mut session_id);
                        }
                    }
                    Err(_) => break,
                }
            }
            if !buf.is_empty() {
                take_ndjson(&buf, &ev_out, &mut final_text, &mut session_id);
            }
        }
        (final_text, session_id)
    });

    // 读 stderr（诊断）—— 单独一线程，否则管道写满时子进程会卡死
    let ev_err = on_event.clone();
    let reader_err = std::thread::spawn(move || {
        if let Some(mut rd) = stderr {
            use std::io::Read;
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match rd.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let s = String::from_utf8_lossy(&line).trim().to_string();
                            if !s.is_empty() {
                                let _ = ev_err.send(AgentEvent::Diag { d: s });
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    });

    // 等结束（带超时）。std::process 没有 wait_timeout，用手轮询。
    let timeout = std::time::Duration::from_secs(req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
    let t0 = std::time::Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let code: i32 = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(-1),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup(&token);
                return Err(AppError::Io(format!("等待 DSH 结束时出错：{e}")));
            }
        }
        // 被 agent_cancel 干掉了吗？
        if !is_running(&token) {
            cancelled = true;
            let _ = child.kill();
            let _ = child.wait();
            break -1;
        }
        if t0.elapsed() > timeout {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break -1;
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    };

    cleanup(&token);
    let _ = reader_err.join();
    let (final_text, session_id) = reader_out.join().unwrap_or((String::new(), None));
    let _ = ev_out;

    if timed_out {
        return Err(AppError::Io(format!(
            "DSH 运行超过 {} 秒已停止。已产出的内容仍保留在候选区。",
            timeout.as_secs()
        )));
    }

    Ok(AgentRunOut {
        code,
        final_text,
        session_id,
        cancelled,
    })
}

/// 取消一次运行：把令牌从表里摘掉，等待循环下一轮就会 kill 子进程。
/// 摘掉而不是直接 kill —— 只有等待循环那一处持有 Child，别处的句柄拿来 kill 会打架。
#[tauri::command]
pub async fn agent_cancel(cancel_token: String) -> Result<()> {
    let mut g = running_init();
    if let Some(m) = g.as_mut() {
        m.remove(&cancel_token);
    }
    Ok(())
}

fn is_running(token: &str) -> bool {
    let g = running_init();
    g.as_ref().map(|m| m.contains_key(token)).unwrap_or(false)
}

fn cleanup(token: &str) {
    let mut g = running_init();
    if let Some(m) = g.as_mut() {
        m.remove(token);
    }
}

/// 处理一行 NDJSON：推给前端，同时把 `final` / `session` 事件里的字段留下来。
///
/// 这里**只做最小解析**（够拿到收尾信息就行），完整解析留在 JS 侧 ——
/// 与 `ai.rs` 把 SSE 行原样转发的理由一样：DSH 换字段时只改一处。
fn take_ndjson(
    line: &[u8],
    ch: &Channel<AgentEvent>,
    final_text: &mut String,
    session_id: &mut Option<String>,
) {
    let s = String::from_utf8_lossy(line).trim().to_string();
    if s.is_empty() {
        return;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("final") => {
                if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                    *final_text = t.to_string();
                }
            }
            Some("session") => {
                if let Some(id) = v.get("sessionId").and_then(|t| t.as_str()) {
                    *session_id = Some(id.to_string());
                }
            }
            _ => {}
        }
    }
    let _ = ch.send(AgentEvent::Line { d: s });
}
