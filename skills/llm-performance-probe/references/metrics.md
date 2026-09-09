# 性能数据口径

所有指标来自业务运行已产生的记录，不是合成 benchmark。比较时按模型加载会话、完成状态、prompt 大小、缓存与 drafting 条件分组；不同请求的中位数只用于描述，不能证明优化因果。

| 字段 | 含义与限制 |
| --- | --- |
| started_at / recorded_at | 后端 UTC 开始/记录完成时间；旧后端可能没有 |
| captured_at | 监控器采样时间，不是请求发生时间 |
| sequence + history.session_id | 模型加载会话内按记录顺序递增的唯一身份；job_id 可在重载后复用 |
| completed | true 为收到正常结束事件；false 为结束但未正常完成，不是“正在生成” |
| prompt_tokens / cached_tokens | 同一后端 job 的 prompt 与复用 token 数；不依赖可能受并发影响的外层 console context |
| time_enqueued | 排队耗时，不能当 prefill |
| time_prefill | 后端报告的 prompt 处理耗时；短长上下文、缓存和实现会影响，不能假定严格线性 |
| time_generate / decode_tokens_per_second | 后端生成时间/速度；不等于包含排队和 prefill 的端到端速度 |
| time_to_first_output | 包装器收到首次非空可见输出的延迟，可能含排队、编码与输出缓冲；不是严格逐 token TTFT |
| total_seconds | 包装器本次请求总耗时，不是 GPU kernel 时间 |
| new_tokens / emitted_tokens | 后端新 token 计数与包装器已收到 token 计数；取消或缓冲时可能不同，不混用口径 |
| accepted_draft_tokens / rejected_draft_tokens / draft_acceptance | 本请求投机接受情况；无尝试应为 N/A，不写 0% |
| image_cache_hits / image_cache_misses / image_seconds | 本请求图片处理指标；image_cache 顶层对象是采样时的共享缓存状态 |
| drafting / max_chunk_size | 采样时模型设置，不应套用到归档内另一模型会话 |

可在字段均有效时额外计算：
- 未缓存 prompt 的有效处理速率 = (prompt_tokens - cached_tokens) / time_prefill，要求时间 > 0 且 0 <= cached <= prompt。它是派生比率，不是纯 kernel 吞吐。
- 端到端速率 = new_tokens / total_seconds，优先仅用于正常完成且计数有效的记录。
- prompt 缓存比例 = cached_tokens / prompt_tokens，要求 prompt > 0。

不要填补缺失时间为零、固定宣称某模型应达到 180 tok/s，或用任意高阈值自动判断故障。长 prefill 且 cached=0 时，可描述为本次未复用缓存；仅凭这条记录不能确认是前缀变化、重载、淘汰还是模型缓存机制导致。

JSON 保留后端 performance 的全部字段。CSV 导出每条 job 的所有键；HTML 展示常用列但每条记录都有一行。取消/缺指标记录仍保留。JSONL 跨采样和重载积累，需显式 --from-archive 才汇总所有历史；latest_perf.json 只是最近一次成功采样的快照。
