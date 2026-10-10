//! 桌面端外壳的装配处。
//!
//! 想给应用加一个新的原生能力，只需要三步：
//!   1. 在 `commands/` 下写一个函数并标上 `#[tauri::command]`；
//!   2. 在下面的 `generate_handler!` 里加一行；
//!   3. 前端按 `invoke('命令名', { 参数 })` 调用（参数名用 camelCase）。
//! 详细约定见 `commands/mod.rs` 的模块注释。
//!
//! # 为什么这里到处是 `#[cfg(feature = "desktop")]`
//!
//! 这不是洁癖，是被 Windows 逼出来的。只要二进制链接了 tauri（实际是 tao），
//! 它就会导入 comctl32 v6 独有的 `SetWindowSubclass` / `TaskDialogIndirect`。
//! 而 **测试目标拿不到应用清单**（清单只通过 `cargo:rustc-link-arg-bins` 挂给 exe），
//! Windows 于是回落到系统自带的 comctl32 v5 —— 那两个符号不存在，
//! 测试进程一启动就 `0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND)`。
//!
//! 结论：想 `cargo test`，就必须让被测试的代码里没有 tao。
//! 于是把 tauri 相关的一切收进 `desktop` feature（默认开启），
//! 纯逻辑（path / fsops / error）永远可用。跑逻辑测试时：
//!
//! ```text
//! cargo test --no-default-features
//! ```

pub mod error;
pub mod fsops;
pub mod path;

#[cfg(feature = "desktop")]
pub mod commands;

/// 全部原生命令的唯一清单。
///
/// 刻意不藏进宏里：这张表就是"前端能调用什么"的完整答案，
/// 评审的人应该能在两秒内看完全部能力面。
#[cfg(feature = "desktop")]
macro_rules! invoke_handler {
    () => {
        tauri::generate_handler![
            // AI 网络桥（桌面端专属，见 commands/mod.rs 的说明）
            #[cfg(feature = "net")]
            commands::ai::ai_models,
            #[cfg(feature = "net")]
            commands::ai::ai_chat,
            // 原生目录选择器（移动端没有，见 commands/fs.rs 的说明）
            #[cfg(not(mobile))]
            commands::fs::fs_pick_dir,
            commands::fs::fs_list_dir,
            commands::fs::fs_exists,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_mkdir,
            commands::fs::fs_remove,
            commands::fs::fs_rename,
            commands::fs::fs_copy_dir,
            commands::fs::fs_perm,
            commands::host::app_host_info,
        ]
    };
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 原生目录选择器。只在 Rust 侧调用，所以不需要给前端开 dialog 权限。
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(invoke_handler!())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
