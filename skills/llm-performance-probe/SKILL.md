---
name: llm-performance-probe
description: 只读获取本地 LLM/textgen 已记录的请求性能，限时轮询监控，导出 JSON/CSV/HTML 和持久 JSONL 历史。用于查看 prefill、解码速度、首次输出延迟、缓存与投机接受率；不生成测试请求、不跑 benchmark、不修改模型配置。
metadata:
  agent_created: "true"
---

# LLM Performance Monitor

保留原技能名称和 `scripts/probe_llm.py` 路径以兼容现有调用，但**所有模式现在都是读取已有数据**。

## 边界与选择

- 唯一在线接口是 `GET /v1/internal/model/info`。绝不调用 completions/chat/completions、构造测试 prompt/图片、预热、清空缓存或用重复请求验证缓存。旧 `--verify`、`--long` 已删除，不能作为回退。
- 使用用户指定服务；本机默认 `http://127.0.0.1:5000`。监控端口不等于 WorkBuddy 的推理路由，不能因此修改模型 API、批准规则或配置。接口 404/401/无 performance 时说明限制，不扫描端口或制造推理流量。
- 默认抓取一次；只有用户要求监控时才限时轮询，不启动常驻后台进程。用户停止时退出，保留已保存数据。
- 通过可用 Bash 工具调用现有 Python 3.9+；路径含空格须引用，使用技能目录实际绝对路径。JSON/CSV/HTML 仅用标准库；PNG 才需要现有 matplotlib，缺少时仍可交付其他格式，不自动安装依赖。
- 凭据从环境变量 `TEXTGEN_API_KEY` 或 `--api-key-env` 指定的变量读取，不放入命令参数、报告或截图。脚本拒绝 URL 内嵌凭据和 HTTP 重定向。

## 抓取与归档

先确定用户要“当前保留的全部记录”“最近 N 条”还是“持续收集”，以及工作区内的输出位置。默认全部导出，终端只显示汇总，避免把几千条记录塞回模型上下文。

一次抓取全部保留记录，生成零 JS、无需外部资源的 HTML 数据表/KPI：

```bash
python "<skill_dir>/scripts/probe_llm.py" --base http://127.0.0.1:5000 --out backend_perf.json --csv-out jobs.csv --html --html-out textgen_perf_dashboard.html
```

用户要求监控 5 分钟时，每 5 秒读取一次，并持久归档：

```bash
python "<skill_dir>/scripts/probe_llm.py" --watch --duration 300 --interval 5 --archive jobs.jsonl --out latest_perf.json
```

单次也可加 `--archive jobs.jsonl`。后续继续用同一路径按来源服务 + 模型加载会话 + sequence 去重，模型重载后 job_id 重复不会覆盖旧记录。归档不受后端 4096 条上限影响，但只能保存实际观察到的记录。相同归档一次只运行一个监控器；遇到锁文件先检查是否已有进程，不自动删除锁。

离线读取**整份归档**，不连接模型：

```bash
python "<skill_dir>/scripts/probe_llm.py" --from-archive jobs.jsonl --out all_jobs.json --html --html-out all_jobs.html
```

`--limit 100` 仅截取输出最近 100 条，不限制归档接收；默认 `--limit 0` 不截取。可加 `--chart --png perf_chart.png`，PNG 默认只画最近 200 条（`--plot-limit` 可调），JSON/CSV/HTML 不因此丢行。`--backend` 是兼容旧命令的无副作用别名。完整指标解释见 [数据口径](references/metrics.md)。

## 历史边界与交付

- 更新后的 ExLlamaV3 默认在内存保留 **4096 条已结束/取消请求**，可由启动参数 `--exl3-performance-history N` 指定正整数容量；本技能仅报告该参数，不自动改配置或重启模型。
- 使用 `performance.history` 中的 capacity/retained/total_recorded/dropped/session_id/first_sequence/last_sequence 判断覆盖范围；不能硬编码“总共只有 32 个任务”。更新前运行中的旧进程仍可能只返回 32 条，需要用户重启 textgen 才加载新代码。
- 已被旧进程丢弃、重载前未归档，或两次采样间被覆盖的记录不能通过此接口恢复。归档报告 `unavailable_before_this_sample` 的缺口，旧接口身份缺失时明确为 best-effort 去重，不能宣称无损。
- 没有新完成记录不等于服务停机；进行中任务不在此历史里。有限轮询的耗时还受每次 HTTP timeout 影响；采样失败非零退出，不以旧文件冒充刚获取的数据。
- 汇报实际记录数、保留容量、时间范围/会话、取消与缺失值、归档新增数和缺口。缺值写 N/A，不当 0，不预设“健康检查”而删除异常记录。
- 交付可访问的输出文件；HTML 是静态表格，不承诺实时刷新或交互图。不要把性能数据上传外部服务。
