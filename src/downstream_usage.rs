//! 最终返回给下游客户端的 usage 兼容策略。
//!
//! 仅在响应序列化边界把值为 0 的输入 Token 替换为非零值。内部计费、请求日志、
//! trace、缓存拆桶和原始上游数据均不得调用本模块改写。

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU8, AtomicU32, Ordering};

pub const MAX_REPLACEMENT_TOKENS: u32 = 1_000_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownstreamInputTokenMode {
    Fixed,
    Random,
}

impl Default for DownstreamInputTokenMode {
    fn default() -> Self {
        Self::Fixed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownstreamInputTokenSettings {
    pub mode: DownstreamInputTokenMode,
    pub fixed: u32,
    pub random_min: u32,
    pub random_max: u32,
}

pub struct DownstreamInputTokenPolicy {
    mode: AtomicU8,
    fixed: AtomicU32,
    random_min: AtomicU32,
    random_max: AtomicU32,
}

impl Default for DownstreamInputTokenPolicy {
    fn default() -> Self {
        Self::new(DownstreamInputTokenSettings {
            mode: DownstreamInputTokenMode::Fixed,
            fixed: 1,
            random_min: 1,
            random_max: 1,
        })
    }
}

impl DownstreamInputTokenPolicy {
    pub fn new(settings: DownstreamInputTokenSettings) -> Self {
        let settings = normalize_settings(settings);
        Self {
            mode: AtomicU8::new(mode_code(settings.mode)),
            fixed: AtomicU32::new(settings.fixed),
            random_min: AtomicU32::new(settings.random_min),
            random_max: AtomicU32::new(settings.random_max),
        }
    }

    pub fn settings(&self) -> DownstreamInputTokenSettings {
        DownstreamInputTokenSettings {
            mode: mode_from_code(self.mode.load(Ordering::Relaxed)),
            fixed: self.fixed.load(Ordering::Relaxed),
            random_min: self.random_min.load(Ordering::Relaxed),
            random_max: self.random_max.load(Ordering::Relaxed),
        }
    }

    pub fn configure(&self, settings: DownstreamInputTokenSettings) {
        let settings = normalize_settings(settings);
        // 先写数值、最后切模式，避免并发读到新模式和旧范围的组合。
        self.fixed.store(settings.fixed, Ordering::Relaxed);
        self.random_min
            .store(settings.random_min, Ordering::Relaxed);
        self.random_max
            .store(settings.random_max, Ordering::Relaxed);
        self.mode.store(mode_code(settings.mode), Ordering::Release);
    }

    /// 为一条响应生成一次 0 值替代数。调用方应在构造响应时保存并复用该值，
    /// 以保证同一 SSE 响应的 message_start 和 message_delta 一致。
    pub fn zero_replacement(&self) -> i32 {
        let settings = self.settings();
        let value = match settings.mode {
            DownstreamInputTokenMode::Fixed => settings.fixed,
            DownstreamInputTokenMode::Random => {
                let span = settings
                    .random_max
                    .saturating_sub(settings.random_min)
                    .saturating_add(1);
                settings.random_min + fastrand::u32(..span.max(1))
            }
        };
        value.max(1).min(MAX_REPLACEMENT_TOKENS) as i32
    }
}

fn normalize_settings(mut settings: DownstreamInputTokenSettings) -> DownstreamInputTokenSettings {
    settings.fixed = settings.fixed.clamp(1, MAX_REPLACEMENT_TOKENS);
    settings.random_min = settings.random_min.clamp(1, MAX_REPLACEMENT_TOKENS);
    settings.random_max = settings.random_max.clamp(1, MAX_REPLACEMENT_TOKENS);
    if settings.random_min > settings.random_max {
        settings.random_max = settings.random_min;
    }
    settings
}

fn mode_code(mode: DownstreamInputTokenMode) -> u8 {
    match mode {
        DownstreamInputTokenMode::Fixed => 0,
        DownstreamInputTokenMode::Random => 1,
    }
}

fn mode_from_code(code: u8) -> DownstreamInputTokenMode {
    if code == 1 {
        DownstreamInputTokenMode::Random
    } else {
        DownstreamInputTokenMode::Fixed
    }
}

static POLICY: LazyLock<DownstreamInputTokenPolicy> =
    LazyLock::new(DownstreamInputTokenPolicy::default);

pub fn policy() -> &'static DownstreamInputTokenPolicy {
    &POLICY
}

/// 仅替换严格等于 0 的值；正数和负数保持原样。
pub fn replace_zero(input_tokens: i32, zero_replacement: i32) -> i32 {
    if input_tokens == 0 {
        zero_replacement.max(1)
    } else {
        input_tokens
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_mode_only_replaces_zero() {
        let policy = DownstreamInputTokenPolicy::new(DownstreamInputTokenSettings {
            mode: DownstreamInputTokenMode::Fixed,
            fixed: 7,
            random_min: 1,
            random_max: 9,
        });
        let replacement = policy.zero_replacement();
        assert_eq!(replace_zero(0, replacement), 7);
        assert_eq!(replace_zero(42, replacement), 42);
        assert_eq!(replace_zero(-1, replacement), -1);
    }

    #[test]
    fn random_mode_stays_inside_inclusive_range() {
        let policy = DownstreamInputTokenPolicy::new(DownstreamInputTokenSettings {
            mode: DownstreamInputTokenMode::Random,
            fixed: 1,
            random_min: 5,
            random_max: 8,
        });
        for _ in 0..200 {
            assert!((5..=8).contains(&policy.zero_replacement()));
        }
    }
}
