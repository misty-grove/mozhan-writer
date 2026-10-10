//! 真实磁盘上的契约测试。
//!
//! 这些断言在内存里测不出来：原子写入会不会留下临时文件、崩溃留下的残留会不会被清掉、
//! 删除只读文件会不会失败、目录树复制会不会丢层、记事本的 BOM 有没有被吃掉 ——
//! 都只有在真的文件系统上跑才算数。
//!
//! 它们同时守着一条项目级约定：桌面端与浏览器宿主的**行为必须一致**
//! （同样的隐藏规则、"删除不存在的目标算成功"、同样的 BOM 处理）。
//! 两个宿主表现不同，是这类应用最难查的一类 bug。

use std::fs;
use std::path::{Path, PathBuf};

use writer_lib::fsops;
use writer_lib::path;

/// 每个用例一个独立目录。测试是并行跑的，共用目录会互相踩。
/// `std::env::temp_dir()` 会尊重 TMP/TEMP，所以构建脚本里把它指到工作区盘时，
/// 这些临时文件也不会落到 C 盘。
fn sandbox(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("writer-it-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).expect("建测试目录失败");
    base
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .expect("列目录失败")
        .map(|e| e.expect("读目录项失败").file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[test]
fn 写入后目录里只剩目标文件不留临时文件() {
    let root = sandbox("atomic");
    let target = root.join("第001章 雪夜.md");
    fsops::atomic_write(&target, "夜里下雪了。".as_bytes()).expect("写入失败");
    assert_eq!(fs::read_to_string(&target).unwrap(), "夜里下雪了。");
    assert_eq!(
        names(&root),
        vec!["第001章 雪夜.md".to_string()],
        "目录里出现了多余的（临时）文件"
    );
}

#[test]
fn 重复写入会覆盖旧内容() {
    let root = sandbox("overwrite");
    let target = root.join("正文.md");
    fsops::atomic_write(&target, "第一版".as_bytes()).unwrap();
    fsops::atomic_write(&target, "第二版".as_bytes()).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "第二版");
    assert_eq!(names(&root).len(), 1);
}

#[test]
fn 崩在写一半留下的临时文件会被下次写入清掉() {
    let root = sandbox("stale-tmp");
    let target = root.join("正文.md");
    let stale = fsops::tmp_path_for(&target);
    fs::write(&stale, "半截内容").unwrap();
    fsops::atomic_write(&target, "完整内容".as_bytes()).unwrap();
    assert!(!stale.exists(), "上次残留的临时文件没有被清掉");
    assert_eq!(names(&root), vec!["正文.md".to_string()]);
}

#[test]
fn 删除不存在的目标算成功() {
    let root = sandbox("remove-idempotent");
    assert!(fsops::remove_if_exists(&root.join("根本没有这个文件")).is_ok());
}

#[test]
fn 递归删掉整棵目录树() {
    let root = sandbox("remove-tree");
    fs::create_dir_all(root.join("正文/子目录")).unwrap();
    fs::write(root.join("正文/子目录/a.md"), "x").unwrap();
    fsops::remove_if_exists(&root.join("正文")).unwrap();
    assert!(!root.join("正文").exists());
}

#[cfg(windows)]
#[test]
fn 只读文件也删得掉() {
    let root = sandbox("readonly");
    let f = root.join("只读.md");
    fs::write(&f, "x").unwrap();
    let mut perm = fs::metadata(&f).unwrap().permissions();
    perm.set_readonly(true);
    fs::set_permissions(&f, perm).unwrap();
    fsops::remove_if_exists(&f).expect("只读文件删除失败（Windows 上的经典坑）");
    assert!(!f.exists());
}

#[test]
fn 复制目录树保留嵌套结构() {
    let root = sandbox("copy");
    let src = root.join("src");
    fs::create_dir_all(src.join("正文")).unwrap();
    fs::create_dir_all(src.join("设定/人物")).unwrap();
    fs::write(src.join("正文/第001章.md"), "正文").unwrap();
    fs::write(src.join("设定/人物/梓叶.md"), "设定").unwrap();
    let dst = root.join("dst");
    fsops::copy_tree(&src, &dst).unwrap();
    assert_eq!(fs::read_to_string(dst.join("正文/第001章.md")).unwrap(), "正文");
    assert_eq!(fs::read_to_string(dst.join("设定/人物/梓叶.md")).unwrap(), "设定");
}

#[test]
fn 读取时去掉记事本加的_bom() {
    let root = sandbox("bom");
    let f = root.join("带BOM.md");
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("正文".as_bytes());
    fs::write(&f, &bytes).unwrap();
    // 浏览器宿主的 Blob.text() 会自动去掉 BOM；桌面端必须一致，
    // 否则卷首会混进一个看不见的字符，字数和检索都会跟着错。
    assert_eq!(fsops::read_text(&f).unwrap(), "正文");
}

#[test]
fn 非法utf8不会让读取失败() {
    let root = sandbox("gbk");
    let f = root.join("gbk.md");
    // GBK 编码的「中文」两字：不是合法 UTF-8
    fs::write(&f, [0xD6, 0xD0, 0xCE, 0xC4]).unwrap();
    let text = fsops::read_text(&f).expect("读失败会直接报错，而浏览器是拿替换字符兜住的");
    assert!(!text.is_empty());
}

#[test]
fn 路径校验挡得住越界写入() {
    let root = sandbox("traversal");
    let r = root.to_str().unwrap();
    let s = |v: &str| vec![v.to_string()];
    // 这是桌面端的安全底线：浏览器宿主靠浏览器保证不越出用户选的目录，
    // 换成 Rust 之后只能自己挡。任何一条漏了，就等于给了"写到磁盘任意位置"的能力。
    assert!(path::join_checked(r, &s("..")).is_err());
    assert!(path::join_checked(r, &s("正文/../../x")).is_err());
    assert!(path::join_checked(r, &["正文".to_string(), "..".to_string()]).is_err());
    assert!(path::join_checked(r, &s("")).is_err());
    assert!(path::join_checked(".", &s("正文")).is_err(), "相对根目录必须被拒绝");
    // 正常的作品路径要照常通过
    assert!(path::join_checked(r, &["正文".to_string(), "第001章 雪夜.md".to_string()]).is_ok());
}
