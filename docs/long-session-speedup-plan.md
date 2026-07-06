# 长会话提速方案（P0 已落地；P1 经基准否决）

> **结论更新 2026-07-04：P0 已实现并合入（重转换循环 12→2）；P1 增量缓存已实现→基准证明无收益（0.7–1.0x，反而略慢）→已完全回退。**
> 详见文末「P1 基准否决记录」。以下 P1 设计保留作历史。

> 目标：消灭 kiro.rs 长会话"越往后越慢"的根因，同时**逐字节**保持现有输出行为，不破坏三条稳定性铁律。

## 背景与实证（三家对比）

对 kiro.rs / Kiro-Go / cursor2api 三个 Kiro/Cursor 代理实现做了代码级对比，锁定 kiro.rs 长会话变慢的真实根因。延迟拆成三部分：

| | 成分 | 随会话增长 | 能否消除 |
|---|---|---|---|
| **A** | 分发前 CPU：`convert_request` 多趟 O(n) 扫描 **× 重转换最多 12 次**，且**无跨请求缓存**（每轮从零全量转换） | ✅ 跨会话 **O(n²)** | ✅ 可解（本方案） |
| **B** | 每流固定 TCP+TLS 握手 ~100–300ms | ❌ 固定 | 保留（稳定性支柱） |
| **C** | 上游 AWS Q 对 payload 做 prefill 才吐首 token | ✅ 随 payload 大小 | ❌ 物理下限 |

用户感受到的"后续越来越慢"**主要是 A**——在本机、同步阻塞首 token、且是 O(n²)。这部分与稳定性、保真度**完全无关**，是纯浪费。

## 三条稳定性铁律（不可破坏）

kiro.rs 的"不断开/不降智"来自三个不变量，任何提速方案都必须保留：

1. **每流全新连接**：`http_client.rs::build_streaming_client` 设 `pool_max_idle_per_host=0`，且 `pool_idle=15s < AWS ALB ~60s`。躲开 ALB 掐空闲连接导致的中途断流（流已回 200 无法重试）。
2. **truncate-before-convert**：`payload_truncate.rs` 先裁**原始 Anthropic 消息**再转换，让 `converter::convert_request` 的三趟配对清理（孤立 tool_result/tool_use 移除、非邻接 tool_use 移除）**永远最后跑** → 输出永远配对合法 → 不触发上游 400 `Invalid message sequence`。（Kiro-Go 激进扁平化打断工具链正是其"工具/会话中途断开"的根源。）
3. **read-timeout 每字节重置**：`http_client.rs` `read_timeout=300s`，收到任一字节即重置 → 大上下文长 prefill 静默不被误杀。

## 决策记录（已锁定）

- 范围：**P0 + P1**（根治 O(n²)）
- P1 缓存粒度：**按会话 conversation_id + 轮内容哈希**
- P1 缓存层：**只缓存局部重活**（正确性优先；配对清理/去重每轮重跑）
- P1 淘汰：**LRU 条数上限 + TTL**
- P1 开关：**环变量 `KIRO_RS_CONV_CACHE`，默认开**（异常可零代码回滚）
- 截断行为：**640KB 完全冻结**，不改语义/阈值/占位符
- 验证：**本地基准 + 单测**（traces.db 本地空；生产 154 live 不碰）
- 落地顺序：**先 P0，验证后再 P1**

---

## P0 — 消灭重转换循环

### 现状
`payload_truncate.rs::convert_within_limit`（当前 :121-161）在 payload 超 640KB 时，进入 `for _ in 0..MAX_TRIM_ITERS`（=12）循环，每次迭代都：
1. `converted_payload_bytes(&result)` 重新序列化测字节；
2. 估算要丢几轮 → `drop_oldest_turns`；
3. **`convert_request(payload)` 整轮重转换**。

即超限时把整个历史重转最多 12 遍。Kiro-Go（`translator.go` 单趟）和 cursor2api（token 预算一次）都无此坑。

### 改法（预算一次，最坏 2 次转换）
保留 truncate-before-convert，改为：
1. `convert_request` 一次，同时在 `build_history` 顺带累加每个 segment 的序列化字节贡献（见 P1，两步共用 segment 化改造）。
2. 若超预算：用字节贡献表**单趟**从最旧往前累加，一次算出应丢的轮数 → `drop_oldest_turns` 一次到位。
3. **只再 `convert_request` 一次**（丢轮后配对清理需重跑以保证合法）。

最坏 2 次转换替代原 2–12 次。丢轮仍在转换前、配对清理仍最后跑 → 输出仍合法，行为不变。

### 风险
极低。纯计算重排，无行为变化。等价性单测 + 转换次数断言护栏。

### P0 单测 / 基准
- 断言：任意超限 fixture 下 `convert_request` 调用次数 ≤ 2。
- 断言：P0 改造前后产出的序列化 Kiro body **逐字节相等**（对 640KB 触发/未触发两类 fixture）。
- 基准：5/20/50/100/200 轮历史的 `prepare_kiro_request` 耗时，确认超限场景不再线性于迭代次数。

---

## P1 — 增量转换缓存（解 O(n²)）

### 核心正确性约束（务必理解）
"转换第 N 轮"**不是**只依赖第 N 轮内容的纯函数，有两处跨轮依赖：
1. **配对清理**（converter.rs:540-550）：第 N 轮 tool_use 是否保留，取决于后续轮有无紧邻 tool_result → 尾部新增可回溯改写早期轮。
2. **图片 SHA256 去重**（converter.rs:1187,1203,1220）：第 N 轮图片算不算重复，取决于其**前面所有轮**是否出现同图；truncate 丢早期轮会让后面图片从"占位"变回"首现"。

因此**只有 turn-local 的重活可缓存**，跨轮的配对清理 + 去重判定必须每轮重跑（但它们是廉价指针遍历/HashSet 查表，非瓶颈）。

### 缓存接缝：`build_history` 的 segment 级
把 `build_history`（converter.rs:1128-1229）重构为产出**有序 segment 列表**。`convert_request` 步骤 8-14（配对清理、`collect_history_tool_names`、组装 `ConversationState`）**照旧每轮重跑**。

```
ConvCache: LRU<conversation_id, Vec<Segment>>
Segment {
    turn_hash: u64,            // 该 run 原始 Anthropic 内容的哈希
    messages: Vec<KiroMessage>,// 已构建 + 已 resize、但【未做 dedup】
    image_hashes: Vec<String>, // 本 segment 图片的 SHA256，供组装时 dedup
    bytes: usize,              // 转换后字节贡献（P0 单趟预算复用）
}
```

- key：`conversation_id`（已从 `metadata.user_id` 提取，converter.rs:499-504）。
- 淘汰：LRU 条数上限 + TTL，env 可调（默认约 500 会话 / 空闲 10 分钟）。
- 开关：`KIRO_RS_CONV_CACHE`，默认开；关闭时走原全量路径，零行为差异。

### 前缀链命中（append-only 常态）
新请求顺序比对每轮 `turn_hash` 与缓存 segment 列表 → 取最长匹配前缀直接复用其 `messages`；**首个不匹配处起**重转换尾部。改历史/换分支自动在该处失效重转，正确兜底。

### 图片去重正确性（关键设计点：resize 与 dedup 分离）
- 缓存存**已 resize 但未 dedup**的图片 + hash（resize 只依赖图片自身字节，是纯函数、也是真正的重活）。
- dedup 下沉到**组装时的廉价 pass**：顺序走 segment 维护 `image_dedup` HashSet，命中换占位符，否则保留。
- 结果：缓存单元变成**纯 turn-local**，truncate 丢轮后 dedup 在组装时重新正确计算 → **逐字节等于现状**，不损命中率。
- 需要的重构：把 `merge_user_messages` 里"resize + dedup 判定"拆成两步（resize 进缓存，dedup 判定在组装）。这是 P1 的主要结构改动，也是最需小心的点。

### 复杂度账
- 命中前缀：每轮 = 廉价 O(n) 组装/清理走一趟 + 贵的 O(Δ) 只转新轮。
- 跨会话：从"O(n²) 重活"降到"O(n²) 轻活 + O(n) 重活"。第 100 轮与第 5 轮分发前开销基本持平。

### P1 单测 / 基准（零回归护栏）
- **等价性（最重要）**：对 fixture 集合断言 **缓存开 vs 关产出的序列化 Kiro body 逐字节相等**。fixture 覆盖：纯文本长会话 / 含工具链 / 含重复图片 / 触发 640KB 截断 / 改中间轮 / 换分支 / conversation_id 缺失（无 user_id）。
- 配对合法性：复用现有断言，确保无孤立 tool_use。
- 基准：第 N 轮增量转换耗时**不随 N 线性增长**；开/关两条曲线对比。

---

## 交付顺序

1. **P0**：`convert_within_limit` 改单趟预算 + 单测 + 基准 → 立竿见影、零风险，先合入验证。
2. **P1**：`build_history` segment 化 + resize/dedup 分离 + `ConvCache` + 等价性单测 + 基准。
3. 全套 `cargo test` + `cargo build --release` 零告警。

## 诚实的边界（能否完美）

- **"随会话变慢"（A）**：P0+P1 后**接近完美解决**——分发前开销不再随轮次累积，且零行为变化。
- **单个巨型请求的绝对首 token（C）**：**不能归零**——上游对 640KB 做 prefill 是物理地板（上游无真 prompt cache，每轮全量 prefill）。但 C 不随轮次累积，治好 O(n²) 后用户几乎无感。
- Kiro-Go 的"快"有一半靠丢用户不肯丢的历史换来（断链 + 降智），那种快本就不要。


---

## P1 基准否决记录（2026-07-04）

P1 增量转换缓存已完整实现（`conversion_cache` 模块 + `build_history` run 化 + 5 个逐字节等价性单测全过，证明缓存开/关输出**完全一致**、不降智不断链）。但 release 基准显示**无收益**：

| 历史深度 | convert（缓存关） | convert（缓存开，前缀命中） | 结果 |
|---|---|---|---|
| 20 轮 | 77µs | 74µs | ~1.0x |
| 50 | 149µs | 211µs | 0.7x（更慢） |
| 100 | 294µs | 379µs | 0.8x（更慢） |
| 200 | 613µs | 737µs | 0.8x（更慢） |

**根因（不可修）**：安全复用缓存前缀必须**哈希入参消息**以检测编辑（`hash_run` 遍历内容，O(bytes)），且 clone 缓存结构也是 O(bytes)——二者合计 ≈ `convert_request` 本身成本。Claude Code 不发稳定的 per-turn ID，无更便宜的 key。

**更大的事实**：convert @200 轮仅 **0.6ms**，分发前 CPU 从来不是墙钟瓶颈。真正的长会话延迟是 **C——上游对 640KB payload 做 prefill（秒级）**，P0/P1 都碰不到（除非丢历史，已被否）。

**决定**：撤掉 P1，只保留 **P0**（`payload_truncate.rs`：超限时重转换 12→2，worst ~7ms→~1.2ms，逐字节等价，570 测试通过）。P1 代码全部回退，converter.rs/mod.rs 干净无残留。
