// 桌面端进程入口。
//
// 这里刻意只留一行：所有装配逻辑都在 lib.rs 里，
// 这样 `cargo test`、将来的移动端入口、以及别的宿主都能复用同一个 run()。
//
// windows_subsystem = "windows" 让发布版不弹出那个黑色控制台窗口；
// debug 构建保留控制台，方便看 Rust 侧的 panic 与日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "desktop")]
fn main() {
    writer_lib::run()
}

/// 关掉 `desktop` feature 时（纯逻辑测试模式），GUI 入口不存在。
///
/// 这个分支不是为了给人用，只是为了 `cargo` 能把 bin 目标也编过 ——
/// `cargo test --no-default-features` 会连 bin 的测试目标一起编译。
#[cfg(not(feature = "desktop"))]
fn main() {
    eprintln!("这个可执行文件需要 desktop feature：cargo run --features desktop");
}
