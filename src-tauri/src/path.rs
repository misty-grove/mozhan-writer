//! 路径安全 —— 桌面端独有的攻击面。
//!
//! 浏览器宿主用的是 File System Access API，浏览器保证句柄不会跳出用户选定的目录；
//! 换到 Rust 之后，这层保证没有了：只要把前端给的字符串直接 join 到根目录上，
//! 一个 `..` 或一个绝对路径就能让"保存这一章"写到磁盘上任意位置。
//!
//! 所以约定是：**前端只能传「相对于作品根目录的片段数组」**，
//! 由这里统一校验后才允许落到文件系统上。所有命令都必须走这个入口。
//!
//! 规则与 `src/core/degrade.ts` 的 `normalizeRelPath` 对齐 ——
//! 同一份规矩在降级沙盒里已经跑了一年，两边不该有两套说法。

use crate::error::{AppError, Result};
use std::path::{Path, PathBuf};

/// 片段个数上限。作品是"卷/章"两层，64 层足够，同时挡住构造出来的深路径。
const MAX_SEGMENTS: usize = 64;
/// 单个片段长度上限。Windows 单段上限是 255 个 UTF-16 码元，这里留足余量。
const MAX_SEG_LEN: usize = 200;

/// Windows 保留设备名。作者完全可能想给一章起名「CON」，
/// 但 Windows 上它根本创建不出来 —— 与其让 IO 抛一个费解的英文错误，不如直说。
#[cfg(windows)]
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 日志/报错里露出名字时截断一下，别让一个超长名字刷屏
fn preview(s: &str) -> String {
    let mut out: String = s.chars().take(24).collect();
    if s.chars().count() > 24 {
        out.push('…');
    }
    out
}

/// Windows 专属规则。分开写是为了在 macOS / Linux 上构建时不会误伤合法文件名
/// （比如 `第1章：归途.md` 里的全角冒号没问题，但半角 `:` 在 Windows 上是数据流语法）。
#[cfg(windows)]
fn check_platform_specific(seg: &str) -> Result<()> {
    if seg.contains(':') {
        return Err(AppError::path(format!("Windows 的文件名里不能有冒号：{}", preview(seg))));
    }
    if seg.chars().any(|c| "<>\"|?*".contains(c)) {
        return Err(AppError::path(format!(
            "文件名里不能有 < > \" | ? * 这些字符：{}",
            preview(seg)
        )));
    }
    // 结尾的空格或点会被 Windows 静默吃掉，导致"明明保存了却打不开"，必须在入口挡住
    if seg.ends_with(' ') || seg.ends_with('.') {
        return Err(AppError::path(format!("名字不能以空格或点结尾：{}", preview(seg))));
    }
    let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(AppError::path(format!(
            "「{}」是 Windows 的保留设备名，换成别的吧",
            preview(seg)
        )));
    }
    Ok(())
}

#[cfg(not(windows))]
fn check_platform_specific(_seg: &str) -> Result<()> {
    Ok(())
}

/// 校验单个路径片段（也可以单独用来校验 `rename` 的新名字）
pub fn check_segment(seg: &str) -> Result<()> {
    if seg.is_empty() {
        return Err(AppError::path("路径里出现了空名字"));
    }
    if seg.chars().count() > MAX_SEG_LEN {
        return Err(AppError::path(format!("名字太长：{}", preview(seg))));
    }
    if seg == "." || seg == ".." {
        return Err(AppError::path(format!("路径里不能出现「{seg}」")));
    }
    if seg.contains('\0') {
        return Err(AppError::path("路径里不能出现空字符"));
    }
    // 片段里出现分隔符 = 想越过一层目录，直接拒绝而不是帮忙规整
    if seg.contains('/') || seg.contains('\\') {
        return Err(AppError::path(format!("名字里不能有路径分隔符：{}", preview(seg))));
    }
    // 控制字符在多数文件系统上非法，而且能污染界面与日志
    if seg.chars().any(|c| c.is_control()) {
        return Err(AppError::path(format!("名字里不能有控制字符：{}", preview(seg))));
    }
    check_platform_specific(seg)
}

/// 把「作品根目录 + 相对片段」解析成一个受控的绝对路径。
///
/// `root` 必须来自原生目录选择器（也就是绝对路径）；相对路径会让操作悄悄落到
/// 进程当前目录上，那是我们最不想要的一种"能用但危险"。
pub fn join_checked(root: &str, segs: &[String]) -> Result<PathBuf> {
    if root.is_empty() {
        return Err(AppError::path("作品根目录为空"));
    }
    let root_path = Path::new(root);
    if !root_path.is_absolute() {
        return Err(AppError::path(format!(
            "作品根目录必须是绝对路径：{}",
            preview(root)
        )));
    }
    if segs.len() > MAX_SEGMENTS {
        return Err(AppError::path(format!("路径层级过深（超过 {MAX_SEGMENTS} 层）")));
    }

    let mut out = root_path.to_path_buf();
    for seg in segs {
        check_segment(seg)?;
        out.push(seg);
    }

    // 纵深防御：就算上面某条规则将来被改坏了，这里也拦住"跑出作品目录"。
    // Path::starts_with 是按路径分量比较的，'C:\a\b' 不会误判成以 'C:\a\bc' 开头。
    if !out.starts_with(root_path) {
        return Err(AppError::path("路径越出了作品目录"));
    }
    Ok(out)
}

/// 要求至少有一个片段的版本。
/// 用在"删掉根目录自己"这种事上 —— 前端不会这么干，但命令层不该留这个口子。
pub fn join_checked_nonempty(root: &str, segs: &[String], what: &str) -> Result<PathBuf> {
    if segs.is_empty() {
        return Err(AppError::path(format!("{what}必须指定具体的目标，不能是整个作品目录")));
    }
    join_checked(root, segs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[cfg(windows)]
    const ROOT: &str = r"C:\work\我的书";

    #[cfg(not(windows))]
    const ROOT: &str = "/work/我的书";

    #[test]
    fn 正常路径能拼出来() {
        let p = join_checked(ROOT, &segs(&["正文", "第001章 归途.md"])).unwrap();
        assert!(p.ends_with("第001章 归途.md"));
        assert!(p.starts_with(ROOT));
    }

    #[test]
    fn 空片段被拒绝() {
        assert!(join_checked(ROOT, &segs(&["正文", ""])).is_err());
        assert!(join_checked(ROOT, &segs(&[""])).is_err());
    }

    #[test]
    fn 上跳被拒绝() {
        // 这一条是整个模块存在的理由
        assert!(join_checked(ROOT, &segs(&[".."])).is_err());
        assert!(join_checked(ROOT, &segs(&["正文", "..", "..", "Windows"])).is_err());
        assert!(join_checked(ROOT, &segs(&["."])).is_err());
    }

    #[test]
    fn 夹带分隔符被拒绝() {
        assert!(join_checked(ROOT, &segs(&["正文/..\\x"])).is_err());
        assert!(join_checked(ROOT, &segs(&["a/b"])).is_err());
        assert!(join_checked(ROOT, &segs(&["a\\b"])).is_err());
    }

    #[test]
    fn 控制字符被拒绝() {
        assert!(join_checked(ROOT, &segs(&["正文\u{0}x"])).is_err());
        assert!(join_checked(ROOT, &segs(&["正文\nx"])).is_err());
    }

    #[test]
    fn 相对根目录被拒绝() {
        assert!(join_checked(".", &segs(&["正文"])).is_err());
        assert!(join_checked("", &segs(&["正文"])).is_err());
        assert!(join_checked("作品目录", &segs(&["正文"])).is_err());
    }

    #[test]
    fn 超长片段被拒绝() {
        let long = "字".repeat(MAX_SEG_LEN + 1);
        assert!(join_checked(ROOT, &segs(&[long.as_str()])).is_err());
    }

    #[test]
    fn 层级过深被拒绝() {
        let deep = vec!["卷".to_string(); MAX_SEGMENTS + 1];
        assert!(join_checked(ROOT, &deep).is_err());
    }

    #[test]
    fn 不允许动根目录自己() {
        assert!(join_checked_nonempty(ROOT, &[], "删除").is_err());
        assert!(join_checked_nonempty(ROOT, &segs(&["正文"]), "删除").is_ok());
    }

    #[test]
    fn 中文与全角符号正常通过() {
        // 作者真的会这么起名，不能因为"看起来像特殊字符"就拦下来
        assert!(join_checked(ROOT, &segs(&["第01卷 归途", "第001章：雪夜.md"])).is_ok());
        assert!(join_checked(ROOT, &segs(&["设定", "梓叶（主角）.md"])).is_ok());
    }

    #[test]
    #[cfg(windows)]
    fn windows_保留名与非法字符被拒绝() {
        assert!(join_checked(ROOT, &segs(&["CON"])).is_err());
        assert!(join_checked(ROOT, &segs(&["nul.md"])).is_err());
        assert!(join_checked(ROOT, &segs(&["正文", "第001章.md"])).is_ok());
        assert!(join_checked(ROOT, &segs(&["a:b"])).is_err());
        assert!(join_checked(ROOT, &segs(&["a?b"])).is_err());
        assert!(join_checked(ROOT, &segs(&["结尾有点."])).is_err());
        assert!(join_checked(ROOT, &segs(&["结尾有空格 "])).is_err());
    }
}
