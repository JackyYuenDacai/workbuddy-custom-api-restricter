---
name: local-qwen-performance
description: 获取本机 Qwen 的 TextGen/ExLlamaV3 性能统计和 NVIDIA GPU 遥测，用于查询 token/s、首段输出延迟、排队/prefill/decode 耗时、缓存、MTP 草稿接受率及近期速度变化。读取已有统计，不发起推理压测，不用于推理/编程能力评测。
---

# 本地 Qwen 性能

使用随技能安装的只读脚本获取数据，不依据记忆报告当前速度。

## 获取数据

在技能目录下执行：

```powershell
node scripts/collect.cjs
```

工作目录不同则使用脚本绝对路径。WorkBuddy 用户级默认安装路径示例：

```powershell
node "$env:USERPROFILE/.workbuddy/skills/local-qwen-performance/scripts/collect.cjs"
```

若 `node` 不在 PATH，使用本机已安装 Node 的绝对路径；不要为查性能自动安装软件。

用户要求观察变化时，可进行一次有界采样：

```powershell
node scripts/collect.cjs --samples 3 --interval 2
```

该命令每两秒抓取一次，共三次，逐行输出 JSON。默认一次；最多十次、总等待不超过三十秒。不要未经用户要求启动持续后台监控。

## 数据来源与路由

- 被观测模型必须为 `Qwen3.8-27B-EXL3-3.5bpw`；不一致时报告 `model_mismatch`，不要将其他模型统计归给 Qwen。
- 性能接口为 TextGen 的 `GET http://127.0.0.1:5000/v1/internal/model/info`。这是只读遥测，不是推理请求。
- WorkBuddy 的推理地址仍为 **`http://127.0.0.1:8317/v1`**；8317 当前没有转发内部统计端点。不得为读取统计把推理改到 5000。
- GPU 数据来自本机 `nvidia-smi`，可能包含其他程序占用，并不等于 Qwen 独占用量。
- 脚本不读取聊天、日志或 WorkBuddy 密钥文件，只输出允许的数值字段。接口需要认证时，用执行环境中的 `TEXTGEN_METRICS_API_KEY`，不要把密钥写进技能、命令参数或回复。

## 正确解释结果

1. `sampled_at` 是采集时刻，不是最近生成完成时间。当前后端没有给每条请求附时间戳，无法断言“这是刚刚这一轮”。
2. 后端只在请求结束/中止时追加历史，最多 32 条。`latest_finished_request.completed=false` 表示已结束但未正常完成，**不是正在生成**；正在进行的生成还不在历史中。
3. `latest_completed_request.decode_tokens_per_second` 是引擎 decode 速度；`end_to_end_tokens_per_second` 是 `new_tokens / total_seconds`，不要混用。
4. `time_to_first_output_seconds` 是后端产生首段非空输出的延迟近似值，不是 WorkBuddy 客户端严格首 token 延迟。它不包含完整代理、网络、工具和 UI 耗时。
5. `window.weighted_decode_tokens_per_second` 为有效完成请求的总 token 数除以总 decode 秒数；不是各次速度的简单平均，也不是并发系统总吞吐。比较时说明样本数、输出长度、缓存和图片处理差异。
6. `drafting.mode=mtp` 表示模型内置多 token 预测分支，即使没有另行加载小模型，也可出现 draft acceptance；`external` 才指外部草稿模型；`none` 则为未启用。不能只凭接受率字段猜模式。
7. 草稿接受率是 `accepted / (accepted + rejected)`；尝试数为 0 时为 `null`，不是 0%。缓存命中率也只能在有效分母下计算。
8. `history_changed_since_previous_sample=false` 只表示本次没有观察到新的结束记录，不表示模型停机或速度为 0。首次采样为 `null`。

## 回复方式与边界

通常用中文简要报告：模型、采集时间、最近完成请求的 decode/端到端速度、首段输出/排队/prefill 延迟、近期样本数，以及 GPU 利用率/显存/温度；有需要再解释缓存与 MTP。缺失数值写“未提供”，不要填 0 或编造。

`no_history` 表示还没有可用历史，`metrics_unavailable` 表示此加载器未提供统计；连接失败、401/403 或 GPU 工具缺失时说明具体缺失项。可以重试一次只读采集，不自动扫描端口、绕过鉴权或读取凭据文件。

默认不发起 `/chat/completions` 压测、不切换/重载模型、不调整 draft、缓存、GPU 功率或时钟。用户另外要求优化时，先解释证据和建议，修改需有相应授权。此技能不等同于推理、编程能力 benchmark。
