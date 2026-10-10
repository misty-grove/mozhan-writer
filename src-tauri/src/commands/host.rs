//! 宿主信息：告诉前端「你现在跑在什么上面」。
//!
//! 为什么要有这条命令：安卓上没有目录选择器。
//! - WebView（哪怕是 Chromium）在 Android 上不提供 `showDirectoryPicker`；
//! - Tauri 的 dialog 插件在移动端也不给文件夹选择（只有消息框）。
//!
//! 所以移动端不能走「请选一个文件夹」这条路，得换成**作品库**：
//! 应用自己有一个专属目录，里面的每个子目录就是一部作品。
//! 这个目录的位置只有宿主知道，因此由这里告诉前端。
//!
//! 桌面端（Windows / macOS / Linux）依旧返回 `worksRoot: null`，
//! 前端照旧弹目录选择器 —— 那边选哪个盘、哪个文件夹都随作者。

use serde::Serialize;

// `app.path()` 来自 Manager trait。只在移动端需要（桌面端用不到作品库），
// 跟着 cfg 走，免得桌面端出现"未使用的 import"。
#[cfg(mobile)]
use tauri::Manager;

// 同理：AppError 只有移动端那条分支在构造它
#[cfg(mobile)]
use crate::error::AppError;
use crate::error::Result;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// "android" | "ios" | "windows" | "macos" | "linux"
    pub platform: &'static str,
    /// 移动端（没有目录选择器，走作品库）
    pub is_mobile: bool,
    /// 作品库根目录的绝对路径。桌面端为 `null`（那边作者自己挑文件夹）。
    pub works_root: Option<String>,
    /// 作品库在界面上的名字（绝对路径太长，也不该直接甩给作者看）
    pub works_root_name: Option<String>,
    /// 备份 zip 的落点。移动端把备份放这儿，桌面端为 null（那边作者自己选）。
    pub export_dir: Option<String>,
    /// 导出后给作者看的一句说明（桌面端为 null）
    pub export_hint: Option<String>,
}

fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

// 桌面端那两个 `= None` 的初值永远不会被读到（移动端分支一定覆盖它），
// 编译器会把它当成"赋值后未读" —— 是 cfg 造成的假警报。
#[allow(unused_assignments)]
#[tauri::command]
pub fn app_host_info(app: tauri::AppHandle) -> Result<HostInfo> {
    let is_mobile = cfg!(mobile);

    // 只有移动端那条分支会给它们赋值；桌面端两个都是 None 直接返回，
    // 于是编译器会好心提醒"不需要 mut" —— 那是 cfg 造成的假警报。
    #[allow(unused_mut)]
    let mut works_root: Option<String> = None;
    #[allow(unused_mut)]
    let mut export_dir: Option<String> = None;
    #[cfg(mobile)]
    {
        // 为什么挑「文档目录」而不是应用私有目录：
        // 安卓上 `document_dir()` 是 `getExternalFilesDir(DIRECTORY_DOCUMENTS)` ——
        // 不用申请任何存储权限就能读写，而且**作者能在文件管理器里翻到**。
        // 而 `app_data_dir()`（内部的 /data/user/0/<pkg>）作者根本看不见，卸载还一起没了。
        // 真拿不到再退回私有目录：能写总比不能写好，界面上会给出真实路径。
        let base = app
            .path()
            .document_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| AppError::Io(format!("拿不到应用存储目录：{e}")))?;
        let root = base.join("works");
        std::fs::create_dir_all(&root)
            .map_err(|e| AppError::Io(format!("创建作品库失败（{}）：{e}", root.display())))?;
        works_root = Some(root.to_string_lossy().into_owned());

        // 备份的落点：安卓不给应用往公共「下载」里直接写文件（要 MediaStore/SAF），
        // 但 getExternalFilesDir(DOWNLOADS) 是自己家的，免权限且作者能找到 —— 够用。
        export_dir = app
            .path()
            .download_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
    }
    let _ = app;

    Ok(HostInfo {
        platform: platform(),
        is_mobile,
        works_root,
        works_root_name: if is_mobile { Some("作品库".to_string()) } else { None },
        export_dir,
        export_hint: if is_mobile {
            Some("备份会放进应用的下载目录，用文件管理器能翻到".to_string())
        } else {
            None
        },
    })
}
