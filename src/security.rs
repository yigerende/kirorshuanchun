//! 集中式安全层：token 生成 + 日志脱敏（移植自 Kiro-RS-Tool）。
//!
//! 统一所有「不该进日志的东西」的脱敏入口，避免脱敏逻辑散落各处、易漏。
//! - `secure_token_urlsafe`：OS CSPRNG 生成默认 API Key（替代非密码学安全的 fastrand）。
//! - `key_fingerprint`：SHA256 前 6 字节，日志只打指纹不打明文。
//! - `redact_header_value` / `is_sensitive_header`：统一脱敏敏感 header。
//! - `redact_proxy_url`：代理 URL 里的 user:pass 脱敏。
//! - `redact_text` / `body_log_summary`：请求体/文本里的 token 标记脱敏。

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

const REDACTED: &str = "[REDACTED]";

/// 用 OS CSPRNG 生成 URL-safe（无填充）随机 token；至少 16 字节熵。
pub fn secure_token_urlsafe(bytes_len: usize) -> String {
    let mut bytes = vec![0u8; bytes_len.max(16)];
    getrandom::fill(&mut bytes).expect("OS CSPRNG unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 密钥指纹：SHA256 前 6 字节的 hex（12 字符），供日志标识而不泄漏明文。
///
/// 作为脱敏工具面的一部分保留：kiro.rs 当前唯一打印明文密钥的点是首次启动的一次性
/// 密钥展示（操作者须据此登录，不可脱敏），故此函数暂无强制接线点，供后续审计日志使用。
#[allow(dead_code)]
pub fn key_fingerprint(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    hex::encode(&digest[..6])
}

/// 脱敏一个 header 值：敏感 header 整体遮蔽，其余仅遮蔽值里的 token 标记。
pub fn redact_header_value(name: &str, value: &str) -> String {
    if is_sensitive_header(name) {
        REDACTED.to_string()
    } else {
        redact_text(value)
    }
}

/// 是否为需整体遮蔽的敏感 header。
pub fn is_sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "x-amz-security-token"
            | "x-aws-ec2-metadata-token"
    )
}

/// 脱敏代理 URL 里的 `user:pass@`（仅当确有凭据时）。
pub fn redact_proxy_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return redact_text(url);
    };
    let Some((userinfo, host)) = rest.rsplit_once('@') else {
        return redact_text(url);
    };
    if userinfo.contains(':') {
        format!("{scheme}://{REDACTED}@{host}")
    } else {
        redact_text(url)
    }
}

/// 请求体日志摘要：只报字节数，不落内容。
///
/// 保留为脱敏工具面：kiro.rs 现有请求体日志已用 `truncate_for_log` 做调试截断，此函数
/// 供需要「完全不落内容、仅报大小」的日志点使用。
#[allow(dead_code)]
pub fn body_log_summary(body: &str) -> String {
    format!("[body redacted, {} bytes]", body.len())
}

/// 遮蔽文本里常见的 token 标记（Bearer / sk- / AKIA 等）之后的内容。
pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    for marker in [
        "Bearer ", "bearer ", "sk-", "sk_", "csk_", "ksk_", "AKIA", "ASIA",
    ] {
        out = redact_after_marker(&out, marker);
    }
    out
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find(marker) {
        out.push_str(&rest[..pos]);
        out.push_str(marker);
        out.push_str(REDACTED);
        let after = &rest[pos + marker.len()..];
        let end = after
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';' | ')' | ']'))
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_logs_redact_auth_headers_body_proxy_and_prompt() {
        assert_eq!(
            redact_header_value("Authorization", "Bearer sk-secret"),
            "[REDACTED]"
        );
        assert_eq!(
            body_log_summary("prompt").as_str(),
            "[body redacted, 6 bytes]"
        );
        assert_eq!(
            redact_proxy_url("http://user:pass@127.0.0.1:8080"),
            "http://[REDACTED]@127.0.0.1:8080"
        );
        assert!(!redact_text("Authorization: Bearer sk-secret").contains("sk-secret"));
    }

    #[test]
    fn proxy_url_without_credentials_is_not_mangled() {
        // 无凭据的代理 URL 不应被改写成 [REDACTED]@
        assert_eq!(
            redact_proxy_url("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn secure_token_uses_requested_entropy_and_fingerprint_is_short() {
        let a = secure_token_urlsafe(32);
        let b = secure_token_urlsafe(32);
        assert_ne!(a, b);
        assert!(a.len() >= 32);
        assert_eq!(key_fingerprint("secret").len(), 12);
    }
}
