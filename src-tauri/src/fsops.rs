//! 纯文件操作 —— 不依赖 Tauri，可以直接拿真实目录做测试。
//!
//! 为什么单独一层：`commands/fs.rs` 里绝大部分代码是"把参数转成路径、把结果转成 JSON"的粘合，
//! 真正容易出错、也最值得验证的是下面这些细节 ——
//! 原子写入会不会留垃圾、删除只读文件会不会失败、目录树复制会不会丢层。
//! 把它们从命令层摘出来，`tests/fs_ops.rs` 才能在真磁盘上跑断言。

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};

/// 写入中的临时文件后缀。
///
/// 名字形如 `.第001章.md.wrtmp`：以点开头 + 固定后缀。
/// - 以 `.wrtmp` 结尾 → 被 `is_internal` 挡住，永远不会出现在目录列表里；
/// - 名字由**目标文件推出来** → 崩在写一半也只会留下一个，下次写入顺手覆盖，不会越积越多；
/// - 和目标同目录 → 同一卷上 rename 才是原子的。
pub const WRITE_TMP_SUFFIX: &str = ".wrtmp";

/// 宿主不往目录列举里暴露的名字。**必须与前端 `src/platform/types.ts` 的
/// `INTERNAL_NAMES` 逐字一致** —— 三个宿主（桌面 Rust / 浏览器 / 内存沙盒）
/// 对同一条规则各写各的，是这类应用最难查的 bug 来源：换台机器就"偶尔多出东西"，
/// 或者更糟，某个内容目录被某一侧悄悄藏起来。
const INTERNAL_NAMES: &[&str] = &[".snapshots", ".git"];

/// 是不是宿主内部物（不进目录列表）。
///
/// 这里**刻意不是**「凡是 `.` 开头就藏」——那个写法看着利落，但是错的：
/// 作品里有一个正经内容目录叫 `大纲/.mdAI文件/`（`core/context.ts` 要读它，
/// README 的数据模型里有它），点开头只是排版习惯，不是"内部物"。
/// 按点前缀一律藏，后果是备份少收三个文件、资料面板里那个目录凭空消失，而且**静默**。
///
/// 所以是「显式名单 + 我们自己的临时后缀」。动这个函数之前先想清楚：
/// 藏掉的每一个名字，都是作者再也看不到、备份也带不走的内容。
pub fn is_internal(name: &str) -> bool {
    INTERNAL_NAMES.contains(&name) || name.ends_with(WRITE_TMP_SUFFIX)
}

pub fn tmp_path_for(target: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    if let Some(f) = target.file_name() {
        name.push(f);
    }
    name.push(WRITE_TMP_SUFFIX);
    target.with_file_name(name)
}

/// 原子写入：先写临时文件，再 rename 覆盖目标。
///
/// 为什么值得多这一步：写作软件手里是作者的稿子。
/// 直接 `fs::write` 会先截断再写，进程正好死在中间就**变成半截文件** ——
/// 一部长篇里丢一章，是这类软件最不可原谅的失败。
/// 同目录内 rename 在同一卷上是原子的，最坏情况也只是留下一个临时文件。
pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = tmp_path_for(target);
    // 上次崩在写一半时留下的同名临时文件，先清掉（不存在也无所谓）
    let _ = fs::remove_file(&tmp);
    fs::write(&tmp, bytes).map_err(|e| AppError::from_io("写入临时文件", &tmp, e))?;
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::from_io("提交写入", target, e));
    }
    Ok(())
}

/// 读文本，行为与浏览器的 `Blob.text()` 对齐：
/// - 非法 UTF-8 用替换字符兜住而不是报错（作者可能用记事本存过 GBK）；
/// - 去掉 UTF-8 BOM —— 记事本会加 BOM，浏览器会自动去掉，不去掉的话
///   卷首会莫名多一个看不见的字符，字数统计和检索都会跟着错。
pub fn read_text(p: &Path) -> Result<String> {
    let bytes = fs::read(p).map_err(|e| AppError::from_io("读取文件", p, e))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// 清掉只读属性。
/// Windows 上一个只读文件能让整个 remove_dir_all 半途而废，报出来的错还很难懂。
pub fn clear_readonly(p: &Path) {
    if let Ok(md) = fs::symlink_metadata(p) {
        if md.permissions().readonly() {
            let mut perm = md.permissions();
            perm.set_readonly(false);
            let _ = fs::set_permissions(p, perm);
        }
    }
}

/// 递归删除，顺带处理只读属性。
pub fn remove_tree(p: &Path) -> std::io::Result<()> {
    clear_readonly(p);
    if p.is_dir() {
        for entry in fs::read_dir(p)? {
            let entry = entry?;
            remove_tree(&entry.path())?;
        }
        // 目录自己的只读属性要在子项清完之后再清一次（顺序反了会白清）
        clear_readonly(p);
        fs::remove_dir(p)
    } else {
        fs::remove_file(p)
    }
}

/// 删除，但"本来就没有"算成功。
///
/// 这是 `fs().remove` 的语义：它表达的是"让这个东西不存在"，
/// 而不是"删除一个存在的文件"。与浏览器宿主保持一致，调用方不用自己先 exists 判断。
pub fn remove_if_exists(p: &Path) -> Result<()> {
    if !p.exists() {
        return Ok(());
    }
    remove_tree(p).map_err(|e| AppError::from_io("删除", p, e))
}

pub fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst).map_err(|e| AppError::from_io("创建目录", dst, e))?;
        let rd = fs::read_dir(src).map_err(|e| AppError::from_io("读取目录", src, e))?;
        for entry in rd {
            let entry = entry.map_err(|e| AppError::from_io("读取目录项", src, e))?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::from_io("创建目录", parent, e))?;
        }
        fs::copy(src, dst).map_err(|e| AppError::from_io("复制文件", src, e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 内部文件命名规则() {
        assert!(is_internal(".snapshots"));
        assert!(is_internal(".git"));
        assert!(is_internal(".第001章.md.wrtmp"));
        assert!(!is_internal("第001章.md"));
        assert!(!is_internal("正文"));
    }

    /// 回归：`大纲/.mdAI文件/` 是**内容**目录，不是内部物。
    ///
    /// 这条断言是拿一次真实事故换来的：隐藏规则一度写成「凡是 `.` 开头就藏」，
    /// 于是桌面宿主会把 `大纲/.mdAI文件/` 整个藏掉 —— 备份层少收三个文件、
    /// 资料面板里那个目录凭空消失，而且不报任何错。
    #[test]
    fn 点开头的内容目录不算内部文件() {
        assert!(!is_internal(".mdAI文件"));
        assert!(!is_internal(".设定草稿.md"));
        // 但内部名单里的照旧要藏，别为了修上面这条把规则整个删了
        assert!(is_internal(".snapshots"));
    }

    #[test]
    fn 临时文件名由目标推出来且同目录() {
        let t = if cfg!(windows) {
            PathBuf::from(r"C:\work\正文\第001章.md")
        } else {
            PathBuf::from("/work/正文/第001章.md")
        };
        let tmp = tmp_path_for(&t);
        assert_eq!(tmp.file_name().unwrap().to_string_lossy(), ".第001章.md.wrtmp");
        // 必须同目录 —— 跨目录 rename 就不是原子的了
        assert_eq!(tmp.parent(), t.parent());
        assert!(is_internal(tmp.file_name().unwrap().to_string_lossy().as_ref()));
    }
}
