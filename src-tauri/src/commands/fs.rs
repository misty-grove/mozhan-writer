//! 文件系统命令 —— 与前端 `src/platform/types.ts` 的 `FsAdapter` 接口一一对应。
//!
//! 这一层只做三件事：**校验路径 → 调用 `crate::fsops` → 把结果交给 Tauri 序列化**。
//! 真正的文件操作都在 `fsops` 里，那里可以脱离 Tauri 直接拿真磁盘做测试。
//!
//! 行为刻意与浏览器宿主（`src/platform/fsAccessAdapter.ts`）对齐：
//! 同样的隐藏规则、"删除不存在的目标算成功"、同样的 BOM 处理。
//! 两个宿主行为不一致是这类应用最难查的 bug 来源 —— 换个环境就"偶尔出错"。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
// 只有 fs_pick_dir 用到（移动端没那条命令）
#[cfg(not(mobile))]
use tauri::Manager;
// 原生目录选择器：安卓/iOS 上没有（`blocking_pick_folder` 在移动端的 dialog 插件里不存在），
// 移动端改走「作品库」（见 commands/host.rs）。所以这两样都跟着 cfg 走。
#[cfg(not(mobile))]
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::fsops;
use crate::path;

/// 与前端 `DirRef` 对应。
/// `id` 在这里就是绝对路径，但前端只把它当**不透明句柄**用（不解析、不拼字符串）。
#[derive(Debug, Serialize, Deserialize)]
pub struct DirRef {
    pub id: String,
    pub name: String,
}

/// 与前端 `DirEntry` 对应
#[derive(Debug, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    /// "file" | "dir"
    pub kind: String,
}

#[cfg(not(mobile))]
fn dir_ref(p: &Path) -> DirRef {
    DirRef {
        name: p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string_lossy().into_owned()),
        id: p.to_string_lossy().into_owned(),
    }
}

/* ---------------------------------------------------------------- 命令 */

/// 前端 `fs().pickDir()` 的对应体：弹原生目录选择器。
///
/// 用 `blocking_` 版本是有意的：它不能在主线程上调用（会自己等自己），
/// 而 `async` 命令跑在线程池里，所以这里阻塞是安全的 ——
/// 比手搭 channel 收发少一层出错的可能。
///
/// 移动端没有这条命令：那边由 `app_host_info` 给出作品库根目录，
/// 前端不会再向用户要一个文件夹。
#[cfg(not(mobile))]
#[tauri::command]
pub async fn fs_pick_dir(app: tauri::AppHandle, title: Option<String>) -> Result<Option<DirRef>> {
    let default = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let picked = app
        .dialog()
        .file()
        .set_directory(default)
        .set_title(title.unwrap_or_else(|| "选择作品目录".to_string()))
        .blocking_pick_folder();
    let Some(file_path) = picked else {
        // 用户点了取消 —— 走 `Ok(None)`，不是错误
        return Ok(None);
    };
    match file_path.as_path() {
        Some(p) => Ok(Some(dir_ref(p))),
        None => Err(AppError::path("目录选择器返回了无法识别的路径")),
    }
}

#[tauri::command]
pub fn fs_list_dir(root: String, path: Vec<String>) -> Result<Vec<DirEntry>> {
    let dir = path::join_checked(&root, &path)?;
    let rd = fs::read_dir(&dir).map_err(|e| AppError::from_io("读取目录", &dir, e))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| AppError::from_io("读取目录项", &dir, e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if fsops::is_internal(&name) {
            continue;
        }
        let kind = if entry.path().is_dir() { "dir" } else { "file" };
        out.push(DirEntry {
            name,
            kind: kind.to_string(),
        });
    }
    // 目录在前、同类按名字排。前端还会再排一次，这里排是为了让两个宿主看起来一致
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

#[tauri::command]
pub fn fs_exists(root: String, path: Vec<String>) -> Result<bool> {
    // 空路径就是根目录自己，它当然存在（前端也会用 `path: []` 问"作品还在不在"）
    Ok(path::join_checked(&root, &path)?.exists())
}

#[tauri::command]
pub fn fs_read_file(root: String, path: Vec<String>) -> Result<String> {
    let p = path::join_checked_nonempty(&root, &path, "读取文件")?;
    fsops::read_text(&p)
}

#[tauri::command]
pub fn fs_write_file(root: String, path: Vec<String>, content: String) -> Result<()> {
    let p = path::join_checked_nonempty(&root, &path, "写入")?;
    if p.is_dir() {
        return Err(AppError::path(format!(
            "「{}」是一个目录，不能当文件写",
            p.display()
        )));
    }
    // 中间层如果是文件，create_dir_all 会失败并给出费解的报错，先自己说清楚
    if let Some(parent) = p.parent() {
        if parent.exists() && !parent.is_dir() {
            return Err(AppError::path(format!("「{}」的上级不是目录", p.display())));
        }
        fs::create_dir_all(parent).map_err(|e| AppError::from_io("创建目录", parent, e))?;
    }
    fsops::atomic_write(&p, content.as_bytes())
}

#[tauri::command]
pub fn fs_mkdir(root: String, path: Vec<String>) -> Result<()> {
    let p = path::join_checked(&root, &path)?;
    fs::create_dir_all(&p).map_err(|e| AppError::from_io("创建目录", &p, e))
}

#[tauri::command]
pub fn fs_remove(root: String, path: Vec<String>) -> Result<()> {
    // join_checked_nonempty 挡住"删掉作品根目录自己"—— 前端不会这么干，但命令层不该留这个口子
    let p = path::join_checked_nonempty(&root, &path, "删除")?;
    fsops::remove_if_exists(&p)
}

#[tauri::command]
pub fn fs_rename(root: String, path: Vec<String>, new_name: String) -> Result<()> {
    let from = path::join_checked_nonempty(&root, &path, "重命名")?;
    // 新名字同样要过校验：它会被当成路径用，不能夹带分隔符或 `..`
    path::check_segment(&new_name)?;
    if !from.exists() {
        return Err(AppError::not_found(format!(
            "要重命名的目标不存在：{}",
            from.display()
        )));
    }
    let to = from.with_file_name(&new_name);
    if to == from {
        return Ok(());
    }
    if to.exists() {
        return Err(AppError::path(format!("「{new_name}」已经存在，换个名字吧")));
    }
    match fs::rename(&from, &to) {
        Ok(()) => Ok(()),
        // 跨盘符重命名会直接失败。这里退化成「复制 + 删除」，
        // 而不是把一句系统英文丢给作者（浏览器宿主本来就是这么做的，行为也对得上）。
        Err(_) => {
            fsops::copy_tree(&from, &to)?;
            fsops::remove_if_exists(&from)
        }
    }
}

#[tauri::command]
pub fn fs_copy_dir(
    root: String,
    from: Vec<String>,
    dst_root: String,
    to_parent: Vec<String>,
    to_name: String,
) -> Result<()> {
    // 注意：`from` 允许为空 —— 前端「作品另存为 / 备份一份」传的就是 []，
    // 意思是"把整个作品根目录复制过去"。这里不能顺手拒掉。
    let src = path::join_checked(&root, &from)?;
    if !src.exists() {
        return Err(AppError::not_found(format!("要复制的内容不存在：{}", src.display())));
    }
    path::check_segment(&to_name)?;
    let dst_parent = path::join_checked(&dst_root, &to_parent)?;
    let dst = dst_parent.join(&to_name);
    if dst.exists() {
        return Err(AppError::path(format!("目标「{}」已经存在", dst.display())));
    }
    // 复制到自己里面会无限递归（src 是 dst 的祖先时），先挡住
    if dst.starts_with(&src) {
        return Err(AppError::path("不能把目录复制到它自己里面"));
    }
    fsops::copy_tree(&src, &dst)
}

/// 前端 `fs().checkPermission()` 的对应体。
/// 桌面端没有"授权"这个概念（能选到就说明有权限），只回答根目录还在不在。
#[tauri::command]
pub fn fs_perm(root: String) -> Result<String> {
    Ok(if Path::new(&root).exists() {
        "granted".to_string()
    } else {
        "denied".to_string()
    })
}
