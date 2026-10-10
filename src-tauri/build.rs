//! 构建脚本。
//!
//! 交给 `tauri_build` 完成：生成权限清单、把图标/版本信息/应用清单编译进 Windows 资源。
//!
//! # 为什么不是无脑调 `tauri_build::build()`
//!
//! `build()` 内部会读 `DEP_TAURI_DEV`（由 `tauri` crate 的构建脚本写下 `cargo:dev` 指令），
//! 读不到就直接 panic：
//!
//! ```text
//! missing `cargo:dev` instruction, please update tauri to latest
//! ```
//!
//! 而 `cargo test --no-default-features` 恰恰**不编译 tauri**（见 Cargo.toml 的 `desktop` feature），
//! 于是这条指令不存在，构建脚本先炸在 `build()` 里，纯逻辑测试根本跑不到。
//!
//! 所以：只有在 `desktop` feature 打开时才跑 tauri 的资源生成。
//! 关掉 GUI 时构建脚本什么都不做，`cargo:rerun-if-changed` 也不用挂 ——
//! 那种模式下产物只取决于 `.rs` 源码本身。

fn main() {
    // 这是 cargo 给构建脚本传 feature 的固定命名：feature 名大写、`-`→`_`、加 `CARGO_FEATURE_` 前缀。
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_none() {
        return;
    }
    tauri_build::build()
}
