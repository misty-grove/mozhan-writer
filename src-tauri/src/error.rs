//! 统一错误类型。
//!
//! 为什么不用 `Result<T, String>`：
//! - 前端要能区分「路径不合法」（绝不降级、必须让用户看见）与「文件不存在」（可以当正常情况处理）；
//! - 命令层要能给错误补上上下文（哪个路径、什么操作），而不是把 io::Error 的英文原文甩出去。
//!
//! 序列化成字符串，前端拿到的就是一句可直接展示的中文，`e?.message || e` 两条路都能兜住。

use serde::{Serialize, Serializer};
use std::fmt;
use std::path::Path;

#[derive(Debug)]
pub enum AppError {
    /// 前端传来的路径/名字不合法（越界、绝对路径、非法字符…）。
    /// 这类错误**绝不静默降级**：宁可报错，也不能把稿子写到别的地方去。
    Path(String),
    /// 目标不存在。多数场景下这是正常情况（比如 remove 一个已经没了的文件）。
    NotFound(String),
    /// 其他 IO 失败，已带上「什么操作 + 哪个路径」的上下文。
    Io(String),
}

impl AppError {
    pub fn path(msg: impl Into<String>) -> Self {
        AppError::Path(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }

    pub fn io(what: &str, path: &Path, err: std::io::Error) -> Self {
        AppError::Io(format!("{what}失败（{}）：{err}", path.display()))
    }

    /// FileNotFound / NotFound 在 Windows 与 Unix 上是不同的错误码，统一在这里判断。
    pub fn from_io(what: &str, path: &Path, err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("{what}失败（{}）：文件或目录不存在", path.display()))
        } else {
            AppError::io(what, path, err)
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Path(m) | AppError::NotFound(m) | AppError::Io(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        // 注意用全路径 std::result::Result：本模块下面的 `Result<T>` 别名把它遮蔽了，
        // 而 Serialize 要求返回的是 Serializer 自己的错误类型。
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
