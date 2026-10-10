//! 原生命令清单（桌面端对前端的全部能力面）。
//!
//! # 怎么加一个新命令
//!
//! 1. 在 `commands/` 下新建（或复用）一个模块，写函数并标 `#[tauri::command]`：
//!
//!    ```ignore
//!    #[tauri::command]
//!    pub fn fs_something(root: String, path: Vec<String>) -> Result<String> {
//!        let p = crate::path::join_checked(&root, &path)?;  // 路径一律走校验
//!        // ...
//!    }
//!    ```
//!
//! 2. 在 `lib.rs` 的 `tauri::generate_handler![...]` 里加一行；
//! 3. 前端用 `invoke('fs_something', { root, path })` 调用。
//!
//! # 三条必须遵守的约定
//!
//! - **参数名**：Rust 用 snake_case 写，前端传 camelCase（Tauri v2 默认就做这层转换）。
//!   所以 Rust 侧叫 `new_name`，前端写 `{ newName }`。
//! - **返回值**：必须是可 JSON 序列化的；错误统一用 `crate::error::AppError`
//!   （序列化成一句中文，前端 `e?.message || e` 两种取法都能用）。
//! - **路径**：永远收「根目录 + 相对片段数组」，**绝不收拼好的绝对路径**。
//!   拼接必须经过 `crate::path::join_checked`，否则一个 `..` 就能写到磁盘任意位置。

// AI 网络桥只在桌面端编译（原因见 Cargo.toml 的 `net` feature 注释：
// 它带的 native-tls 在安卓上会拖出 OpenSSL 交叉编译）。
#[cfg(feature = "net")]
pub mod ai;
// DSH Agent 后端：把本机的 dsh headless 当第二个 AI 引擎（带工具、能读写作品目录）。
// 与 ai.rs 同挂 net：DSH 自己就是网络客户端，放进"没有 net 的移动端构建"没有意义。
#[cfg(feature = "net")]
pub mod agent;
pub mod fs;
pub mod host;
