//! 出网相关的**纯函数**。
//!
//! 刻意不依赖 `tauri` / `reqwest`：`cargo test --no-default-features` 是本项目
//! 唯一的 Rust 测试入口（带 `desktop` 会跟 tauri 打架），放在这里才真的跑得到。
//! 依赖重的那部分（真正发请求）在 `commands/ai.rs`。

/// 目标地址是不是**本机**（回环）。
///
/// 为什么要单独判这一类：作者如果开着 Clash 之类的系统代理，环境变量里会有
/// `HTTP_PROXY`，而 reqwest 默认认这个变量 —— 于是连 `http://127.0.0.1:11434`
/// （本地模型端点，Ollama / LM Studio 都是这个形态）也会被塞进代理，
/// 代理连不上就直接失败，界面上看着像「软件坏了」，其实只是走了不该走的路。
///
/// 所以：**远程地址照用代理，本机地址一律直连**（浏览器也是这个规矩）。
pub fn is_loopback(url: &str) -> bool {
    // 取 authority 段：去掉 scheme、userinfo，截到第一个 / ? # 为止
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.trim().to_ascii_lowercase();

    // IPv6 带方括号：[::1] 或 [::1]:11434
    if let Some(inner) = host.strip_prefix('[') {
        let ip = inner.split(']').next().unwrap_or("");
        return ip.parse::<std::net::Ipv6Addr>().map(|ip| ip.is_loopback()).unwrap_or(false);
    }
    // 去掉端口再判
    let host = host.rsplit_once(':').map_or(host.as_str(), |(h, _)| h);
    if host == "::1" || host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    // 交给标准库判，不要自己 starts_with("127.")：
    // `127.0.0.1.evil.example.com` 会被这种土法匹配误判成本机（于是绕过代理直连外部域名）。
    host.parse::<std::net::Ipv4Addr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::is_loopback;

    /// 本机地址的常见写法，一条都不能漏判 —— 漏了就会被系统代理劫走。
    #[test]
    fn loopback_is_recognized() {
        for u in [
            "http://127.0.0.1:11434/v1/chat/completions",
            "http://127.0.0.1/v1/models",
            "http://localhost:7860/v1/chat/completions",
            "https://localhost/v1/models",
            "http://[::1]:11434/v1/chat/completions",
            "http://user:pw@127.0.0.1:8080/v1/models",
        ] {
            assert!(is_loopback(u), "应当认作本机：{u}");
        }
    }

    /// 远程地址必须走代理（要出国访问 API 的人离不开），不能误判成本机。
    ///
    /// 里面特意放了一个「主机名里带 127.」的域名：土法字符串匹配的经典误伤。
    #[test]
    fn remote_is_not_loopback() {
        for u in [
            "https://api.deepseek.com/v1/chat/completions",
            "http://127.0.0.1.evil.example.com/v1/models",
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            "http://192.168.1.10:8080/v1/models",
        ] {
            assert!(!is_loopback(u), "不应认作本机：{u}");
        }
    }
}
