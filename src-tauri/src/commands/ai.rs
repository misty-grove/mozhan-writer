//! AI 网络桥 —— **整个应用唯一的出网点**。
//!
//! # 为什么 HTTP 要收进 Rust 做，而不是让前端直接 fetch
//!
//! 桌面端的页面源是 `tauri://localhost`，向 `api.deepseek.com` 这类第三方发请求
//! 属于跨域：除非服务商自己回了 CORS 头，否则一律被浏览器安全模型拦下，
//! 表现为 `Failed to fetch` —— 作者老老实实填了 Key 也用不了。
//! 所以 AI 请求统一走这里；顺带的收益是：
//!
//! - **审计面只有这一个文件**：想确认"这软件往外发了什么"，读完本文件就有答案；
//! - 前端 `core/ai.ts` 只管拼协议（OpenAI 兼容格式），不感知宿主差异；
//! - 浏览器宿主仍然走自己的 fetch（见 `src/platform/aiBridge.ts`），那里受 CORS
//!   限制是浏览器规则使然，界面上有说明。
//!
//! # 安全约定
//!
//! - URL 只接受 `http(s)`，其余一律 `AppError::Path` 拒掉（防止被塞进 `file://` 之类）；
//! - 本模块不做任何持久化：Key 在内存里用完即弃，不落盘、不打日志。
//!
//! # 代理规则
//!
//! 系统代理**照用**（要出国访问 API 的人离不开它），但**本机地址一律直连** ——
//! 详见 [`netutil::is_loopback`](crate::netutil::is_loopback)。

use crate::error::{AppError, Result};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;

/// 一次 HTTP 调用的最终结果。流式过程中间数据走 [`StreamEvent`]，这里只收尾。
#[derive(Serialize)]
pub struct HttpOut {
    /// HTTP 状态码。约定 **0 = 请求根本没发出去**（网络层失败），原因在 body 里。
    pub status: u16,
    pub body: String,
}

fn assert_http_url(url: &str) -> Result<()> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(())
    } else {
        Err(AppError::path(format!(
            "AI 请求地址必须是 http(s) 链接，收到的是：{url}"
        )))
    }
}

fn client(connect_secs: u64, total_secs: u64, url: &str) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(connect_secs))
        .timeout(std::time::Duration::from_secs(total_secs));
    if crate::netutil::is_loopback(url) {
        // 直连：不让系统代理插手本机地址（理由见 netutil::is_loopback）
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| AppError::Io(format!("HTTP 客户端初始化失败：{e}")))
}

/// 拉模型列表（`GET /v1/models`），设置页「测试连接」用。
#[tauri::command]
pub async fn ai_models(url: String, api_key: String) -> Result<HttpOut> {
    assert_http_url(&url)?;
    let cli = client(15, 30, &url)?;
    let resp = cli
        .get(&url)
        .bearer_auth(&api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::Io(format!("网络请求失败：{e}")))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Ok(HttpOut { status, body })
}

/// 流式对话过程中推给前端的事件。
/// `serde(tag)` 序列化成 `{"t":"delta","d":"…"}` / `{"t":"status","status":200}`。
#[derive(Serialize, Clone)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum StreamEvent {
    /// 一行 SSE 数据（已去掉 `data:` 前缀；`[DONE]` 也原样给，前端自己认）。
    Delta { d: String },
    /// 响应头已到，告知 HTTP 状态码（非 200 时前端可以直接走错误分支）。
    Status { status: u16 },
}

/// 流式对话（`POST /v1/chat/completions`，`stream: true`）。
///
/// SSE 的每个 `data:` 行**原样**推给前端 —— JSON 解析留在 JS 侧做，
/// 这样两个宿主（Rust 桥 / 浏览器 fetch）共享同一套解析代码，不会各写一份然后漂移。
#[tauri::command]
pub async fn ai_chat(
    url: String,
    api_key: String,
    body: String,
    on_event: Channel<StreamEvent>,
) -> Result<HttpOut> {
    assert_http_url(&url)?;
    let cli = client(20, 600, &url)?;
    let resp = cli
        .post(&url)
        .bearer_auth(&api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("网络请求失败：{e}")))?;
    let status = resp.status().as_u16();
    let _ = on_event.send(StreamEvent::Status { status });
    if status != 200 {
        // 错误响应体（服务商的 JSON 报错）整个带回给前端展示
        let text = resp.text().await.unwrap_or_default();
        return Ok(HttpOut { status, body: text });
    }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(format!("读取流式响应失败：{e}")))?;
        buf.extend_from_slice(&chunk);
        // 按行切；最后一段可能是半行，留在 buf 里等下一个 chunk
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            emit_sse_line(&line, &on_event);
        }
    }
    if !buf.is_empty() {
        emit_sse_line(&buf, &on_event);
    }
    Ok(HttpOut {
        status,
        body: String::new(),
    })
}

fn emit_sse_line(line: &[u8], ch: &Channel<StreamEvent>) {
    let s = String::from_utf8_lossy(line);
    let s = s.trim();
    if !s.starts_with("data:") {
        return; // 心跳注释行、事件头等一律忽略
    }
    let payload = s["data:".len()..].trim();
    if payload.is_empty() {
        return;
    }
    let _ = ch.send(StreamEvent::Delta {
        d: payload.to_string(),
    });
}
