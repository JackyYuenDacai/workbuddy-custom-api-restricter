#!/usr/bin/env python3
"""
probe_llm.py - Measure running local LLM inference service performance.

Usage:
    python probe_llm.py [--base http://127.0.0.1:5000] [--long] [--verify] [--out result.json]
    python probe_llm.py --backend [--chart] [--out backend.json] [--png chart.png]

Modes:
    (default)  Throughput/latency probe: 6 cases (short code cold/repeat, prose,
               greedy, 9k code cold/repeat). --long adds 42k / 107k long-context.
    --verify   Backend fine-grained metrics via /v1/internal/model/info
               performance.recent_requests. Requires Pillow.
    --backend  Read the server's OWN recorded request performance from
               /v1/internal/model/info (recent_requests + image_cache + drafting
               + max_chunk_size + model config). No synthetic traffic. Optionally
               --chart renders a matplotlib dashboard PNG.

Does NOT change any model config; pure read/sampling.
"""
import argparse
import base64
import io
import json
import time
import urllib.request
from pathlib import Path

DEFAULT_BASE = "http://127.0.0.1:5000"


def _http(base, path, payload=None, timeout=240):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def check_online(base):
    try:
        models = _http(base, "/v1/models", timeout=5)
        ids = [m.get("id") for m in models.get("data", [])]
        print("[online] %s -> models: %s" % (base, ids), flush=True)
        return True
    except Exception as e:
        print("[offline] cannot reach %s: %s" % (base, e), flush=True)
        return False


def probe(base, label, prompt, temperature):
    payload = {
        "prompt": prompt, "max_tokens": 512, "temperature": temperature,
        "top_k": 20, "top_p": 0.95, "min_p": 0, "repetition_penalty": 1,
        "seed": 42, "stream": True, "stream_options": {"include_usage": True},
    }
    req = urllib.request.Request(base + "/v1/completions", json.dumps(payload).encode(),
                                 {"Content-Type": "application/json"})
    start = time.perf_counter()
    first = last = None
    usage, chunks = {}, 0
    with urllib.request.urlopen(req, timeout=300) as resp:
        for line in resp:
            if not line.startswith(b"data: "):
                continue
            raw = line[6:].strip()
            if raw == b"[DONE]":
                break
            event = json.loads(raw)
            if event.get("usage"):
                usage = event["usage"]
            if any(c.get("text") for c in event.get("choices", [])):
                last = time.perf_counter()
                first = first or last
                chunks += 1
    end = time.perf_counter()
    tokens = usage.get("completion_tokens", 0)
    row = dict(
        label=label, temperature=temperature, usage=usage, chunks=chunks,
        ttft_s=round(first - start, 3) if first else None,
        total_s=round(end - start, 3),
        end_to_end_tps=round(tokens / (end - start), 2) if end > start else None,
        post_first_output_tps_approx=round(tokens / (last - first), 2)
        if first and last > first else None,
    )
    print(json.dumps(row), flush=True)
    return row


_NOTE = ("# Project note {i}: cache entries have a key, value, and access timestamp; "
         "test eviction and updates.\n")


def run_throughput(base, long_ctx):
    code = ("# Python implementation of an LRU cache with type hints, detailed docstrings, "
            "and a comprehensive unittest suite.\nfrom collections import OrderedDict\n")
    prose = ("A detailed tutorial on how a compiler works, covering lexical analysis, "
             "parsing, type checking, IR, optimization, and machine code generation.\n\n1. Lexical analysis\n")
    long_code = "".join(_NOTE.format(i=i) for i in range(350)) + code
    cases = [
        ("code_cold", code, 0.6), ("code_repeat", code, 0.6),
        ("prose", prose, 0.6), ("code_greedy", code, 0.0),
        ("long_code_cold", long_code, 0.6), ("long_code_repeat", long_code, 0.6),
    ]
    if long_ctx:
        for label, count in [("42k", 1600), ("107k", 4000)]:
            prompt = "".join(_NOTE.format(i=i) for i in range(count)) + code
            cases.extend([(label + "_code_first", prompt, 0.6), (label + "_code_repeat", prompt, 0.6)])
    return [probe(base, lbl, pr, temp) for lbl, pr, temp in cases]


def _image_messages(image):
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return [{"role": "user", "content": [
        {"type": "image_url", "image_url": {
            "url": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}}]}]


def run_verify(base):
    from PIL import Image, ImageDraw
    results = []

    def complete(label, prompt, messages=None, limit=256):
        payload = dict(prompt=prompt, max_tokens=limit, temperature=0.6, top_k=20, top_p=0.95,
                       min_p=0, repetition_penalty=1, seed=42, stream=False, add_bos_token=False)
        if messages is not None:
            payload["messages"] = messages
        start = time.perf_counter()
        resp = _http(base, "/v1/completions", payload)
        stats = _http(base, "/v1/internal/model/info")["performance"]["recent_requests"][-1]
        row = dict(label=label, elapsed_seconds=round(time.perf_counter() - start, 3),
                   usage=resp["usage"], metrics=stats,
                   output=resp["choices"][0]["text"])
        print(json.dumps({k: v for k, v in row.items() if k != "output"}), flush=True)
        return row

    current = _http(base, "/v1/internal/model/info")
    _http(base, "/v1/internal/model/load",
          {"model_name": current["model_name"],
           "args": {"exl3_max_chunk_size": current["performance"]["max_chunk_size"]}})
    results.append(complete("text_512",
        "# Python implementation of an LRU cache with type hints, detailed docstrings, "
        "and a comprehensive unittest suite.\nfrom collections import OrderedDict\n", limit=512))

    image = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(image).rectangle((64, 64, 448, 448), fill="red")
    messages = _image_messages(image)
    context = "".join("Project note %d: cache entries have keys, values and access times.\n" % i
                      for i in range(200))
    prompt = context + "Describe the image, then explain how an LRU cache works in detail.\n"
    first = complete("image_first", prompt, messages)
    repeat = complete("image_repeat", prompt, messages)
    results += [first, repeat]
    image.putpixel((0, 0), (0, 0, 0))
    changed = complete("image_changed", prompt, _image_messages(image))
    results.append(changed)
    print("[verify] done", flush=True)
    return results


# ---------- Backend recorded-data reader ----------
def read_backend(base):
    """Read the server's own recorded performance data (no synthetic traffic)."""
    info = _http(base, "/v1/internal/model/info")
    perf = info.get("performance", {})
    data = {
        "model_name": info.get("model_name"),
        "base": base,
        "captured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "performance": {
            "recent_requests": perf.get("recent_requests", []),
            "image_cache": perf.get("image_cache"),
            "drafting": perf.get("drafting"),
            "max_chunk_size": perf.get("max_chunk_size"),
        },
        "config": {k: info[k] for k in
                   ("model_name", "ctx_size", "quant_type", "flash_attn", "batch_size")
                   if k in info},
    }
    reqs = data["performance"]["recent_requests"]
    print("[backend] model=%s recent_requests=%d" % (data["model_name"], len(reqs)), flush=True)
    for i, r in enumerate(reqs):
        print("  [%d] prompt=%s emitted=%s ttft=%s prefill=%s gen=%s tok/s=%s cached=%s" % (
            i, r.get("prompt_tokens"), r.get("emitted_tokens"),
            round(r.get("time_to_first_output") or 0, 3),
            round(r.get("time_prefill") or 0, 3),
            round(r.get("time_generate") or 0, 3),
            round(r.get("decode_tokens_per_second") or 0, 1),
            r.get("cached_tokens")), flush=True)
    return data


def render_chart(data, png_path):
    """Render a matplotlib dashboard from backend data. English labels (font-safe)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    reqs = data["performance"]["recent_requests"]
    if not reqs:
        print("[chart] no recent_requests to plot", flush=True)
        return None
    n = len(reqs)
    labels = ["req%d" % i for i in range(n)]
    ttft = [r.get("time_to_first_output") or 0 for r in reqs]
    prefill = [r.get("time_prefill") or 0 for r in reqs]
    gen = [r.get("time_generate") or 0 for r in reqs]
    queue = [r.get("time_enqueued") or 0 for r in reqs]
    tps = [r.get("decode_tokens_per_second") or 0 for r in reqs]
    cached = [r.get("cached_tokens", 0) for r in reqs]
    draft = [r.get("draft_acceptance") or 0 for r in reqs]

    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    fig.suptitle("Textgen backend - recent request performance (%s)" % data.get("model_name"),
                 fontsize=14, fontweight="bold")

    # (1) Time breakdown stacked bars
    ax = axes[0][0]
    x = range(n)
    ax.bar(x, prefill, label="prefill", color="#4c72b0")
    ax.bar(x, gen, bottom=prefill, label="generate", color="#dd8452")
    ax.bar(x, queue, bottom=[p + g for p, g in zip(prefill, gen)], label="queue", color="#55a868")
    ax.set_yscale("log")
    ax.set_ylabel("seconds (log)")
    ax.set_title("Time breakdown per request")
    ax.set_xticks(list(x)); ax.set_xticklabels(labels)
    ax.legend(fontsize=8)

    # (2) decode tok/s
    ax = axes[0][1]
    ax.bar(x, tps, color="#4c72b0")
    for i, v in enumerate(tps):
        ax.text(i, v, "%.0f" % v, ha="center", va="bottom", fontsize=8)
    ax.set_ylabel("decode tokens/s")
    ax.set_title("Decode throughput")
    ax.set_xticks(list(x)); ax.set_xticklabels(labels)

    # (3) TTFT
    ax = axes[1][0]
    ax.bar(x, ttft, color="#c44e52")
    for i, v in enumerate(ttft):
        ax.text(i, v, "%.2f" % v, ha="center", va="bottom", fontsize=8)
    ax.set_yscale("log")
    ax.set_ylabel("first-token latency (s, log)")
    ax.set_title("Time to first output")
    ax.set_xticks(list(x)); ax.set_xticklabels(labels)

    # (4) draft acceptance + cached tokens
    ax = axes[1][1]
    x2 = [i - 0.2 for i in x]
    x3 = [i + 0.2 for i in x]
    ax.bar(x2, draft, width=0.4, label="draft acceptance", color="#4c72b0")
    ax2 = ax.twinx()
    ax2.bar(x3, cached, width=0.4, label="cached tokens", color="#8172b3")
    ax.set_ylabel("draft acceptance")
    ax2.set_ylabel("cached tokens")
    ax.set_title("Speculative drafting & cache hits")
    ax.set_xticks(list(x)); ax.set_xticklabels(labels)
    l1, lb1 = ax.get_legend_handles_labels()
    l2, lb2 = ax2.get_legend_handles_labels()
    ax.legend(l1 + l2, lb1 + lb2, fontsize=8)

    ic = data["performance"].get("image_cache") or {}
    dr = data["performance"].get("drafting") or {}
    footer = ("image_cache: %s entries / %.1f MB | drafting: %s max=%s | max_chunk=%s" % (
        ic.get("entries", "?"), (ic.get("bytes", 0) / 1048576.0),
        dr.get("mode", "?"), dr.get("max_tokens", "?"),
        data["performance"].get("max_chunk_size", "?")))
    fig.text(0.5, 0.01, footer, ha="center", fontsize=9, color="#555")

    fig.tight_layout(rect=[0, 0.03, 1, 0.96])
    fig.savefig(png_path, dpi=110)
    plt.close(fig)
    print("[chart] saved %s" % png_path, flush=True)
    return png_path


def render_html(data, html_path):
    """Render a SELF-CONTAINED HTML dashboard (matplotlib charts embedded as
    base64 PNG + real HTML table rows). ZERO JavaScript, so it renders correctly
    in viewers/preview panels that do NOT execute JS (e.g. WorkBuddy inline preview).
    Requires matplotlib."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import rcParams

    reqs = data["performance"]["recent_requests"]
    if not reqs:
        print("[html] no recent_requests to plot", flush=True)
        return None
    model = data.get("model_name", "")
    captured = data.get("captured_at", "")
    n = len(reqs)

    p = [r.get("prompt_tokens") or 0 for r in reqs]
    e = [r.get("emitted_tokens") or 0 for r in reqs]
    ttft = [r.get("time_to_first_output") for r in reqs]
    pre = [r.get("time_prefill") or 0 for r in reqs]
    gen = [r.get("time_generate") or 0 for r in reqs]
    tps = [r.get("decode_tokens_per_second") or 0 for r in reqs]
    cached = [r.get("cached_tokens") or 0 for r in reqs]
    draft = [(r.get("draft_acceptance") or 0) * 100 for r in reqs]
    comp = [r.get("completed", True) for r in reqs]

    tps_valid = [t for t, c in zip(tps, comp) if c and t > 0]
    avg_tps = sum(tps_valid) / len(tps_valid) if tps_valid else 0
    max_tps = max(tps_valid) if tps_valid else 0
    max_tps_idx = tps.index(max_tps) if tps_valid else 0
    ttft_cached = [t for t, c in zip(ttft, comp) if c and t is not None and t < 5]
    avg_ttft_cached = sum(ttft_cached) / len(ttft_cached) if ttft_cached else 0
    max_ctx = max(p)
    max_cache = max(cached)
    draft_valid = [x for x, c in zip(draft, comp) if c and x > 0]
    avg_draft = sum(draft_valid) / len(draft_valid) if draft_valid else 0

    BG, PANEL, GRID = "#0f172a", "#1e293b", "#334155"
    TXT, SUB = "#e2e8f0", "#94a3b8"
    BLUE, ORANGE, GREEN, RED, PURPLE, YELLOW = "#3b82f6", "#f97316", "#4ade80", "#f87171", "#a855f7", "#fbbf24"
    rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": PANEL, "savefig.facecolor": BG,
        "text.color": TXT, "axes.edgecolor": GRID, "axes.labelcolor": SUB,
        "xtick.color": SUB, "ytick.color": SUB, "grid.color": GRID,
        "grid.linewidth": 0.5, "font.size": 9,
    })

    fig, axes = plt.subplots(2, 3, figsize=(16, 9.5))
    fig.subplots_adjust(left=0.05, right=0.98, top=0.90, bottom=0.08, hspace=0.45, wspace=0.35)
    x = list(range(n))
    tick = x[::3]
    ticklabel = ["R%d" % i for i in tick]

    ax = axes[0][0]
    ax.bar(x, tps, color=[GREEN if t > 100 else (YELLOW if t > 80 else RED) for t in tps])
    ax.set_title("Decode Throughput (tok/s)", color=TXT, fontsize=11, loc="left")
    ax.set_xticks(tick); ax.set_xticklabels(ticklabel); ax.grid(axis="y")
    ax.set_ylim(0, max(tps) * 1.15)

    ax = axes[0][1]
    ax.bar(x, [(t if t is not None else 0.001) for t in ttft],
           color=[RED if (t or 0) > 5 else BLUE for t in ttft])
    ax.set_yscale("log"); ax.set_ylim(0.01, 200)
    ax.set_title("Time to First Output (log, sec)", color=TXT, fontsize=11, loc="left")
    ax.set_xticks(tick); ax.set_xticklabels(ticklabel); ax.grid(axis="y")

    ax = axes[0][2]
    pre_p = [max(v, 0.001) for v in pre]
    gen_p = [max(v, 0.001) for v in gen]
    ax.bar(x, pre_p, color=BLUE, label="Prefill")
    ax.bar(x, gen_p, bottom=pre_p, color=ORANGE, label="Generate")
    ax.set_yscale("log"); ax.set_ylim(0.001, 200)
    ax.set_title("Time Breakdown (Prefill+Gen, log)", color=TXT, fontsize=11, loc="left")
    ax.set_xticks(tick); ax.set_xticklabels(ticklabel); ax.grid(axis="y")
    ax.legend(loc="upper right", facecolor=PANEL, edgecolor=GRID, labelcolor=TXT, fontsize=8)

    ax = axes[1][0]
    ax.plot(x, draft, color=YELLOW, marker="o", markersize=3, linewidth=1.5)
    ax.set_ylim(0, 100)
    ax.set_title("Draft Acceptance Rate (%)", color=TXT, fontsize=11, loc="left")
    ax.set_xticks(tick); ax.set_xticklabels(ticklabel); ax.grid(axis="y")

    ax = axes[1][1]
    w = 0.26
    ax.bar([i - w for i in x], p, width=w, color=BLUE, label="Prompt")
    ax.bar(x, cached, width=w, color=PURPLE, label="Cached")
    ax.bar([i + w for i in x], e, width=w, color=GREEN, label="Output")
    ax.set_title("Prompt / Cached / Output Tokens", color=TXT, fontsize=11, loc="left")
    ax.set_xticks(tick); ax.set_xticklabels(ticklabel); ax.grid(axis="y")
    ax.legend(loc="upper left", facecolor=PANEL, edgecolor=GRID, labelcolor=TXT, fontsize=8)

    ax = axes[1][2]
    ax.bar(x, e, color=GREEN)
    ax.set_title("Emitted Tokens per Request", color=TXT, fontsize=11, loc="left")
    ax.set_xticks(tick); ax.set_xticklabels(ticklabel); ax.grid(axis="y")
    ax.set_ylim(0, max(e) * 1.15)

    fig.suptitle("Textgen Backend Performance  |  %s  |  %s  |  %d requests" % (model, captured, n),
                 color=TXT, fontsize=14, y=0.975)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100)
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode("ascii")
    plt.close(fig)
    img_tag = '<img src="data:image/png;base64,%s" style="width:100%%;border-radius:10px;">' % b64

    rows = []
    for i, r in enumerate(reqs):
        pt = r.get("prompt_tokens")
        tt = r.get("time_to_first_output")
        c = r.get("cached_tokens")
        dr = (r.get("draft_acceptance") or 0) * 100
        c_tps = r.get("decode_tokens_per_second") or 0
        completed = r.get("completed", True)
        if not completed:
            status = '<span class="badge badge-hot">ABORT</span>'
        elif (tt or 0) > 5:
            status = '<span class="badge badge-cold">COLD</span>'
        else:
            status = '<span class="badge badge-ok">CACHED</span>'
        tps_color = GREEN if c_tps > 100 else (YELLOW if c_tps > 80 else RED)
        pt_s = "{:,}".format(pt) if pt else "\u2014"
        tt_s = "{:.2f}".format(tt) if tt is not None else "\u2014"
        c_s = "{:,}".format(c) if c else "\u2014"
        rows.append(
            "<tr><td>%d</td><td>%s</td>"
            "<td class='num'>%s</td><td class='num'>%d</td>"
            "<td class='num'>%s</td><td class='num'>%.2f</td>"
            "<td class='num'>%.2f</td><td class='num' style='color:%s'>%.1f</td>"
            "<td class='num'>%s</td><td class='num'>%.1f%%</td><td>%s</td></tr>"
            % (i, r.get("job_id", ""), pt_s, r.get("emitted_tokens", 0), tt_s,
               r.get("time_prefill") or 0, r.get("time_generate") or 0,
               tps_color, c_tps, c_s, dr, status))
    table_body = "\n".join(rows)

    kpi = f"""
<div class="kpi-row">
<div class="kpi"><div class="label">Avg Decode Speed</div><div class="value" style="color:{GREEN}">{avg_tps:.1f}</div><div class="unit">tokens/s</div></div>
<div class="kpi"><div class="label">Max Decode Speed</div><div class="value" style="color:{GREEN}">{max_tps:.1f}</div><div class="unit">tok/s (R{max_tps_idx})</div></div>
<div class="kpi"><div class="label">Avg TTFT (cached)</div><div class="value" style="color:{BLUE}">{avg_ttft_cached:.2f}</div><div class="unit">seconds</div></div>
<div class="kpi"><div class="label">Max Context</div><div class="value" style="color:{RED}">{max_ctx:,}</div><div class="unit">prompt tokens</div></div>
<div class="kpi"><div class="label">Max Cache Hit</div><div class="value" style="color:{PURPLE}">{max_cache:,}</div><div class="unit">cached tokens</div></div>
<div class="kpi"><div class="label">Avg Draft Accept</div><div class="value" style="color:{YELLOW}">{avg_draft:.1f}%</div><div class="unit">MTP mode</div></div>
</div>
"""

    CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
h1 { font-size: 22px; margin-bottom: 4px; color: #f8fafc; }
.subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 20px; }
.kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
.kpi { background: #1e293b; border-radius: 10px; padding: 14px; border: 1px solid #334155; }
.kpi .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
.kpi .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
.kpi .unit { font-size: 11px; color: #64748b; }
.chart-wrap { background: #1e293b; border-radius: 10px; padding: 14px; border: 1px solid #334155; margin-bottom: 24px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { background: #334155; padding: 8px 6px; text-align: left; color: #cbd5e1; }
td { padding: 7px 6px; border-bottom: 1px solid #33415533; }
tr:hover td { background: #33415533; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
.badge-hot { background: #dc262633; color: #f87171; }
.badge-cold { background: #3b82f633; color: #60a5fa; }
.badge-ok { background: #16a34a33; color: #4ade80; }
.section-title { font-size: 15px; font-weight: 600; margin: 20px 0 10px; color: #f1f5f9; }
.footer { margin-top: 20px; text-align: center; color: #475569; font-size: 11px; }
"""

    template = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Textgen Performance Dashboard</title>
<style>__CSS__</style>
</head>
<body>
<h1>Textgen Backend Performance Dashboard</h1>
<div class="subtitle">Model: __MODEL__ &nbsp;|&nbsp; Captured: __CAPTURED__ &nbsp;|&nbsp; __N__ requests &nbsp;|&nbsp; 自包含（零 JS，图表为内嵌 PNG）</div>
__KPI__
<div class="chart-wrap">__IMG__</div>
<div class="section-title">Request Details（每条请求实测数据）</div>
<table>
<thead><tr><th>#</th><th>Job</th><th>Prompt</th><th>Output</th><th>TTFT(s)</th><th>Prefill(s)</th><th>Gen(s)</th><th>tok/s</th><th>Cached</th><th>Draft%</th><th>Status</th></tr></thead>
<tbody>
__TABLE__
</tbody>
</table>
<div class="footer">Generated by llm-performance-probe skill | Roroky</div>
</body>
</html>"""

    html = (template
            .replace("__CSS__", CSS)
            .replace("__MODEL__", model)
            .replace("__CAPTURED__", captured)
            .replace("__N__", str(n))
            .replace("__KPI__", kpi)
            .replace("__IMG__", img_tag)
            .replace("__TABLE__", table_body))
    Path(html_path).write_text(html, encoding="utf-8")
    print("[html] saved %s (%d bytes, %d rows, zero JS)" % (html_path, len(html), len(rows)), flush=True)
    return html_path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--long", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--backend", action="store_true",
                    help="Read server's recorded request performance (no synthetic traffic)")
    ap.add_argument("--chart", action="store_true",
                    help="With --backend: render a matplotlib dashboard PNG")
    ap.add_argument("--html", action="store_true",
                    help="With --backend: render a SELF-CONTAINED HTML dashboard "
                         "(charts embedded as base64 PNG + real table rows, ZERO JS; "
                         "renders in viewers that don't execute JS, e.g. WorkBuddy preview)")
    ap.add_argument("--html-out", default=None, help="HTML output path (default textgen_perf_dashboard.html)")
    ap.add_argument("--png", default=None, help="Chart output path (default perf_chart.png)")
    ap.add_argument("--out", default=None, help="JSON output path")
    args = ap.parse_args()
    if not check_online(args.base):
        raise SystemExit(1)

    if args.backend:
        data = read_backend(args.base)
        out = Path(args.out) if args.out else Path("backend_perf.json")
        out.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        print("[saved] %s" % out, flush=True)
        if args.chart:
            png = Path(args.png) if args.png else Path("perf_chart.png")
            render_chart(data, str(png))
        if args.html:
            html_out = Path(args.html_out) if args.html_out else Path("textgen_perf_dashboard.html")
            render_html(data, str(html_out))
    elif args.verify:
        results = run_verify(args.base)
        out = Path(args.out) if args.out else Path("perf_result.json")
        out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        print("[saved] %s" % out, flush=True)
    else:
        results = run_throughput(args.base, args.long)
        out = Path(args.out) if args.out else Path("perf_result.json")
        out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        print("[saved] %s" % out, flush=True)


if __name__ == "__main__":
    main()