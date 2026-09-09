---
name: llm-performance-probe
description: 测量本地运行中的 LLM 推理服务（OpenAI 兼容 /v1/completions，如 textgen + ExLlamaV3）的性能数据：首 token 延迟(TTFT)、端到端/流式 tokens/s、prompt 缓存命中、后端细粒度指标（prefill/generate 时间、draft 接受率、图片 embedding 缓存）。三种模式：打流量探针、读服务自己记录的后台请求 performance 全量数据、渲染 matplotlib 图表。当用户要求"测 LLM 性能/吞吐/延迟""跑性能探针/benchmark""看看推理服务快不快""获取 LLM performance 数据""看 textgen 后台请求数据/画性能图表"且目标是一个已在本机运行的本地模型服务时触发。
agent_created: true
---

# LLM Performance Probe

测量**本地正在运行**的 LLM 推理服务的真实性能，不改任何模型配置，纯通过 API 打流量采样。专为 textgen + ExLlamaV3（OpenAI 兼容 `/v1/completions`）这类服务设计，但脚本已参数化，可指向任意同接口服务。

## 适用前提

- 本地有一个**正在运行**的推理服务，默认 `http://127.0.0.1:5000`，暴露 `/v1/completions`（OpenAI 兼容）。
- 服务必须已加载模型（先探 `/v1/models` 确认在线）。
- 需要 Python 3.9+；跑 `--verify` 需要 `Pillow`（用于生成测试图片）；跑 `--chart` 需要 `matplotlib`。

## 使用步骤

1. **确认服务在线**（必做，避免对着死端口跑）：
   ```bash
   curl -s -m 5 http://127.0.0.1:5000/v1/models
   ```
   应返回模型列表 JSON。若不通，先让用户启动服务或改 `--base`。

2. **跑性能探针**（核心，默认 6 组用例：短代码冷/热、短散文、贪心、9k 代码冷/热）：
   ```bash
   python scripts/probe_llm.py --base http://127.0.0.1:5000 --out result.json
   ```
   加 `--long` 追加 42k / 107k 长上下文用例（注意：长上下文冷启动 TTFT 可能几十秒，属正常）。

3. **（可选）跑后端细粒度指标验证**：
   ```bash
   python scripts/probe_llm.py --base http://127.0.0.1:5000 --verify --out verify.json
   ```
   需要 `Pillow`。会读取 `/v1/internal/model/info` 的 `performance.recent_requests`，拿到 `time_prefill`/`time_generate`/`cached_tokens`/`accepted_draft_tokens`/`image_cache_hits` 等，并断言图片 embedding 缓存与 prompt 前缀缓存生效。

4. **（可选）读服务自己记录的后台请求 performance（不打流量）**：
   ```bash
   python scripts/probe_llm.py --base http://127.0.0.1:5000 --backend --out backend_perf.json
   ```
   直接读 `/v1/internal/model/info` 的 `performance` 全量数据：`recent_requests`（每条含 `time_prefill`/`time_generate`/`time_to_first_output`/`decode_tokens_per_second`/`cached_tokens`/`draft_acceptance`/`image_cache_hits` 等）+ `image_cache` + `drafting` + `max_chunk_size` + 模型配置。**这是"获取后台已发生请求数据"的首选**，不产生任何合成流量。

5. **（可选）渲染图表**：在 `--backend` 基础上加 `--chart`：
   ```bash
   python scripts/probe_llm.py --backend --chart --out backend_perf.json --png perf_chart.png
   ```
   生成 2×2 matplotlib 仪表盘（时间分解堆叠柱、decode 吞吐、TTFT、draft 接受率+缓存命中），需 `matplotlib`。图表标签用英文（避免中文字体缺失）。

6. **（可选）渲染自包含 HTML 仪表盘（推荐，交互查看）**：在 `--backend` 基础上加 `--html`：
   ```bash
   python scripts/probe_llm.py --backend --html --out backend_perf.json --html-out textgen_perf_dashboard.html
   ```
   产出**单个自包含 HTML**：2×3 matplotlib 仪表盘渲染成 PNG 以 base64 内嵌 + 6 个 KPI 卡片 + **每条请求实测数据表**（25 行真实 HTML）。**零 JavaScript**，因此在**不执行 JS 的查看器**（如 WorkBuddy 内嵌预览面板、`file://` 直开）里图表和表格都能正常显示。需 `matplotlib`。
   > ⚠️ 关键坑：若在预览面板里用 `<canvas>`/Chart.js 画图表，JS 不执行 → 图表空白、表格无行。务必用本模式（生成时预渲染 PNG + 真实 HTML 行），不要在 HTML 里写 `<script>`。

7. **汇报结果**：把 TTFT、tokens/s、缓存命中、draft 接受率整理成表格给用户，把 `textgen_perf_dashboard.html`（首选）或 `perf_chart.png` 用 present_files 展示，并给出"冷启动慢 vs 缓存命中快"的解读。

## 关键指标解读

| 指标 | 含义 | 关注点 |
|------|------|--------|
| `ttft_s` | 首 token 延迟 | 冷启动高（含 prefill）；热缓存应骤降 |
| `end_to_end_tps` | 总 tokens/s（含 prefill） | 长 prompt 首次请求会很低 |
| `post_first_output_tps_approx` | 流式吞吐 | 反映真实 decode 速度，更稳定 |
| `cached_tokens` | 命中的缓存 token 数 | 重复请求应显著 > 0 |
| `accepted_draft_tokens` / `draft_acceptance` | 投机解码接受率 | 反映 drafter 质量 |
| `image_cache_hits/misses` | 图片 embedding 缓存 | 重复图应 hit=1 |

**核心规律**：短上下文常能跑到 ~180 tok/s；长上下文首次请求被 prefill 拖到 10-30 tok/s，但**重复（缓存命中）后可回升到 100+ tok/s**。优化重点通常是"保持 prompt 前缀稳定 + 缓存图片 embedding"。

## 资源

- `scripts/probe_llm.py` — 自包含探针，四种模式：
  - 默认：吞吐/延迟探针（`--long` 加长上下文）
  - `--verify`：后端细粒度指标 + 图片缓存断言（需 Pillow）
  - `--backend`：读服务记录的后台请求 performance 全量数据（**不打流量**）
  - `--backend --chart`：额外渲染 matplotlib 2×2 仪表盘 PNG（需 matplotlib）
  - `--backend --html`：额外渲染**自包含 HTML 仪表盘**（图表 base64 内嵌 + 真实 HTML 表格行，**零 JS**，内嵌预览面板可用）（需 matplotlib）
  - 参数：`--base` / `--out` / `--png` / `--html-out`

## 故障排查

- **连接被拒**：服务没起或端口不对 → 用 `--base` 指定正确地址，或让用户启动服务。
- **`--verify` 报缺模块**：`pip install Pillow`。
- **`--chart` 报缺模块**：`pip install matplotlib`。
- **`/v1/internal/model/info` 404**：该服务不是 textgen 或未开启 internal 端点 → `--backend`/`--verify` 不可用，只用吞吐探针。
- **后台数据里某条 `prompt_tokens=None` / `emitted_tokens=1`**：是服务内部非业务请求（如健康检查），正常现象，画图时可忽略。
- **长上下文卡很久**：正常，prefill 耗时随上下文线性增长；耐心等或去掉 `--long`。