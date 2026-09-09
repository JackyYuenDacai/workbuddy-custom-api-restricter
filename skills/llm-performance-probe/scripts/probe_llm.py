"""Fetch and archive existing textgen performance metrics; never run inference."""

import argparse
import csv
import hashlib
import html
import io
import json
import math
import os
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_BASE = 'http://127.0.0.1:5000'
MAX_RESPONSE_BYTES = 32 * 1024 * 1024


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def normalize_base(base):
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/', '/v1', '/v1/')):
        raise ValueError('Use an HTTP(S) server root or /v1 URL without credentials, query, or fragment.')
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')).rstrip('/')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError('Monitoring redirects are disabled. Specify the intended server directly.')


def fetch_backend(base, timeout=10, api_key=None):
    base = normalize_base(base)
    headers = {'Accept': 'application/json'}
    if api_key:
        headers['Authorization'] = 'Bearer ' + api_key
    request = urllib.request.Request(base + '/v1/internal/model/info', headers=headers, method='GET')
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=timeout) as response:
        payload = response.read(MAX_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError('Performance response exceeds 32 MiB; no partial snapshot was saved.')
    info = json.loads(payload)
    performance = info.get('performance') if isinstance(info, dict) else None
    if not isinstance(performance, dict) or not isinstance(performance.get('recent_requests'), list):
        raise ValueError('No recorded performance available. Check the loaded model/backend; do not run a benchmark.')
    if not all(isinstance(record, dict) for record in performance['recent_requests']):
        raise ValueError('Invalid request records in performance response.')
    return {'schema_version': 1, 'base': base, 'model_name': info.get('model_name'),
            'loader': info.get('loader'), 'captured_at': utc_now(), 'performance': performance}


def archive_key(entry):
    sequence = entry['metrics'].get('sequence')
    if entry.get('history_session') and isinstance(sequence, int) and not isinstance(sequence, bool):
        return (entry['base'], entry['history_session'], sequence)
    digest = hashlib.sha256(json.dumps(entry['metrics'], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return (entry['base'], entry.get('model_name'), digest)


def read_archive(path):
    entries = []
    with Path(path).open(encoding='utf-8') as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                if not isinstance(entry, dict) or not isinstance(entry.get('metrics'), dict) or not entry.get('base'):
                    raise ValueError('missing base or metrics')
            except (ValueError, TypeError) as error:
                raise ValueError(f'Invalid archive row {line_number}; preserve the file and inspect it.') from error
            entries.append(entry)
    return entries


class Archive:
    def __init__(self, path):
        self.path = Path(path)
        self.lock_path = self.path.with_name(self.path.name + '.lock')
        self.seen = set()
        self.latest = {}
        self.locked = False

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as error:
            raise ValueError('Archive is locked. Stop the other monitor; do not automatically delete its lock.') from error
        os.close(descriptor)
        self.locked = True
        try:
            for entry in read_archive(self.path) if self.path.exists() else []:
                self.remember(entry)
        except Exception:
            self.__exit__(None, None, None)
            raise
        return self

    def remember(self, entry):
        self.seen.add(archive_key(entry))
        sequence = entry['metrics'].get('sequence')
        if entry.get('history_session') and isinstance(sequence, int):
            session_key = (entry['base'], entry['history_session'])
            self.latest[session_key] = max(sequence, self.latest.get(session_key, 0))

    def append(self, data):
        history = data['performance'].get('history') or {}
        session_id = history.get('session_id')
        previous = self.latest.get((data['base'], session_id), 0)
        first = history.get('first_sequence')
        missing = max(0, first - previous - 1) if isinstance(first, int) and session_id else None
        added = 0
        with self.path.open('a', encoding='utf-8', newline='\n') as stream:
            for metrics in data['performance']['recent_requests']:
                entry = {'base': data['base'], 'model_name': data.get('model_name'),
                         'captured_at': data['captured_at'], 'history_session': session_id, 'metrics': metrics}
                if archive_key(entry) in self.seen:
                    continue
                stream.write(json.dumps(entry, ensure_ascii=False) + '\n')
                self.remember(entry)
                added += 1
            stream.flush()
            os.fsync(stream.fileno())
        return {'path': str(self.path), 'added': added, 'unique_records': len(self.seen),
                'unavailable_before_this_sample': missing,
                'identity': 'session/sequence' if session_id else 'legacy fingerprint (best effort)'}

    def __exit__(self, *args):
        if self.locked:
            self.lock_path.unlink()
            self.locked = False


def load_archive_data(path):
    seen = set()
    records = []
    sources = set()
    sequences_by_source = {}
    for entry in read_archive(path):
        key = archive_key(entry)
        if key in seen:
            continue
        seen.add(key)
        source = (entry['base'], entry.get('model_name'), entry.get('history_session'))
        sources.add(source)
        sequence = entry['metrics'].get('sequence')
        if source[2] and isinstance(sequence, int) and not isinstance(sequence, bool) and sequence > 0:
            sequences_by_source.setdefault(source, set()).add(sequence)
        records.append(dict(entry['metrics'], source_base=entry['base'], model_name=entry.get('model_name'),
                            history_session=entry.get('history_session'), captured_at=entry.get('captured_at')))
    coverage = []
    for source, sequences in sequences_by_source.items():
        first, last = min(sequences), max(sequences)
        coverage.append({'base': source[0], 'model_name': source[1], 'session_id': source[2],
                         'first_sequence': first, 'last_sequence': last, 'records': len(sequences),
                         'missing_before_first': first - 1,
                         'missing_between_first_and_last': last - first + 1 - len(sequences),
                         'missing_after_last': None})
    return {'schema_version': 1, 'base': None, 'model_name': 'Archive (possibly multiple sessions/models)',
            'captured_at': utc_now(), 'archive_source': str(path),
            'performance': {'recent_requests': records, 'archive_sources': len(sources),
                            'archive_coverage': coverage}}


def select_records(data, limit):
    performance = dict(data['performance'])
    records = performance['recent_requests']
    performance['available_records'] = len(records)
    performance['recent_requests'] = records[-limit:] if limit else list(records)
    performance['exported_records'] = len(performance['recent_requests'])
    return dict(data, performance=performance)


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def summary(records):
    def median(field):
        values = [number(record.get(field)) for record in records]
        values = [value for value in values if value is not None]
        return statistics.median(values) if values else None
    return {'records': len(records), 'completed': sum(record.get('completed') is True for record in records),
            'incomplete': sum(record.get('completed') is False for record in records),
            'median_first_output_s': median('time_to_first_output'),
            'median_prefill_s': median('time_prefill'),
            'median_decode_tokens_s': median('decode_tokens_per_second')}


def atomic_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix=path.name + '.', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def write_csv(data, path):
    records = data['performance']['recent_requests']
    columns = sorted({field for record in records for field in record})
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    for record in records:
        row = {}
        for field, value in record.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')):
                value = "'" + value
            row[field] = value
        writer.writerow(row)
    atomic_text(path, output.getvalue())


def render_chart(data, path, plot_limit=200):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    records = data['performance']['recent_requests'][-plot_limit:]
    figure, axes = plt.subplots(2, 2, figsize=(12, 7), constrained_layout=True)
    for axis, (field, label) in zip(axes.flat, (
            ('time_prefill', 'Prefill (s)'), ('decode_tokens_per_second', 'Decode (tokens/s)'),
            ('time_to_first_output', 'First visible output (s)'), ('draft_acceptance', 'Draft acceptance'))):
        values = [number(record.get(field)) for record in records]
        axis.plot(range(1, len(records) + 1), [value if value is not None else float('nan') for value in values])
        axis.set_title(label)
        axis.set_xlabel('Record index in displayed subset')
    figure.suptitle(f'Last {len(records)} of {len(data["performance"]["recent_requests"])} exported records; missing = gaps')
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(path, dpi=130)
    plt.close(figure)


def render_html(data, path):
    records = data['performance']['recent_requests']
    fields = ['sequence', 'job_id', 'recorded_at', 'model_name', 'history_session', 'completed',
              'prompt_tokens', 'new_tokens', 'emitted_tokens', 'time_enqueued', 'time_prefill',
              'time_generate', 'total_seconds', 'time_to_first_output', 'decode_tokens_per_second',
              'cached_tokens', 'draft_acceptance', 'image_cache_hits', 'image_cache_misses']
    def display(value):
        if value is None or isinstance(value, float) and not math.isfinite(value):
            return 'N/A'
        return html.escape(f'{value:.4f}' if isinstance(value, float) else str(value))
    cards = ''.join(f'<div><strong>{display(value)}</strong><br>{html.escape(key)}</div>'
                    for key, value in summary(records).items())
    headings = ''.join(f'<th>{field}</th>' for field in fields)
    rows = ''.join('<tr>' + ''.join(f'<td>{display(record.get(field))}</td>' for field in fields) + '</tr>'
                   for record in records)
    metadata = {key: value for key, value in data['performance'].items() if key != 'recent_requests'}
    page = ('<!doctype html><html lang="en"><meta charset="utf-8"><title>LLM performance monitor</title>'
            '<style>body{font:14px system-ui;margin:28px;color:#182333;background:#f5f7fb}'
            '.cards{display:flex;flex-wrap:wrap;gap:12px}.cards div{background:white;padding:16px;border-radius:8px}'
            'strong{font-size:24px}.table{overflow:auto}table{border-collapse:collapse;background:white}'
            'th,td{padding:8px;border:1px solid #dbe0e8;white-space:nowrap;text-align:right}'
            'th{background:#eaf0f9}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>'
            f'<h1>Recorded LLM performance</h1><p>{display(data.get("model_name"))} | {display(data.get("captured_at"))}</p>'
            '<p>Read-only observations, not a benchmark. Missing values are N/A, not zero. '
            'First visible output is not guaranteed to be exact first-token latency. '
            'Archive aggregates may mix models, sessions and prompt sizes; not an apples-to-apples speed comparison.</p>'
            f'<div class="cards">{cards}</div><h2>Retention and sampling</h2><pre>{html.escape(json.dumps(metadata, indent=2, ensure_ascii=False))}</pre>'
            f'<h2>All {len(records)} exported records</h2><div class="table"><table><thead><tr>{headings}</tr></thead>'
            f'<tbody>{rows}</tbody></table></div></html>')
    atomic_text(path, page)


def save_snapshot(data, args):
    data = select_records(data, args.limit)
    atomic_text(args.out, json.dumps(data, indent=2, ensure_ascii=False))
    if args.csv_out:
        write_csv(data, args.csv_out)
    if args.html:
        render_html(data, args.html_out)
    if args.chart:
        render_chart(data, args.png, args.plot_limit)
    report = summary(data['performance']['recent_requests'])
    report.update(history=data['performance'].get('history'), archive=data.get('archive'))
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default=DEFAULT_BASE)
    parser.add_argument('--backend', action='store_true', help='Compatibility alias; all modes are read-only.')
    parser.add_argument('--out', default='backend_perf.json')
    parser.add_argument('--archive', help='Append/deduplicate all retained jobs in a persistent JSONL archive.')
    parser.add_argument('--from-archive', help='Read an existing JSONL archive offline; no HTTP requests.')
    parser.add_argument('--watch', action='store_true', help='Poll for a bounded duration; never generate requests.')
    parser.add_argument('--duration', type=float, default=60, help='Watch duration in seconds (default 60).')
    parser.add_argument('--interval', type=float, default=5, help='Seconds between completed polls (minimum 1).')
    parser.add_argument('--timeout', type=float, default=10)
    parser.add_argument('--limit', type=int, default=0, help='Export latest N records; 0 exports all. Archive always receives all.')
    parser.add_argument('--api-key-env', default='TEXTGEN_API_KEY', help='Environment variable holding the API key, never printed.')
    parser.add_argument('--csv-out')
    parser.add_argument('--html', action='store_true', help='Generate a self-contained, zero-JavaScript HTML table/KPI report.')
    parser.add_argument('--html-out', default='textgen_perf_dashboard.html')
    parser.add_argument('--chart', action='store_true', help='Optional PNG charts; requires existing matplotlib.')
    parser.add_argument('--png', default='perf_chart.png')
    parser.add_argument('--plot-limit', type=int, default=200, help='Chart only the latest N rows, without truncating exports.')
    args = parser.parse_args(argv)
    if (not all(math.isfinite(value) for value in (args.duration, args.interval, args.timeout))
            or args.duration <= 0 or args.interval < 1 or args.timeout <= 0 or args.limit < 0 or args.plot_limit < 1):
        parser.error('Use positive finite duration/timeout, interval >= 1, limit >= 0 and plot-limit >= 1.')
    if args.from_archive and (args.watch or args.archive):
        parser.error('--from-archive cannot be combined with --watch or --archive.')
    outputs = [args.out] + ([args.csv_out] if args.csv_out else []) + ([args.html_out] if args.html else []) + ([args.png] if args.chart else [])
    paths = [Path(path).resolve() for path in outputs + ([args.archive] if args.archive else []) + ([args.from_archive] if args.from_archive else [])]
    if len(paths) != len(set(paths)):
        parser.error('Output and archive paths must be distinct; refusing to overwrite the archive.')
    if args.archive:
        archive_path = Path(args.archive).resolve()
        if archive_path.with_name(archive_path.name + '.lock') in paths:
            parser.error('Output paths must not overwrite the archive lock.')
    if args.from_archive:
        return save_snapshot(load_archive_data(args.from_archive), args)
    archive = Archive(args.archive) if args.archive else None
    try:
        if archive:
            archive.__enter__()
        deadline = time.monotonic() + args.duration
        while True:
            data = fetch_backend(args.base, args.timeout, os.environ.get(args.api_key_env))
            if archive:
                data['archive'] = archive.append(data)
            if not data['performance'].get('history', {}).get('session_id'):
                print('Warning: legacy server history; capacity/session identity unknown, archive deduplication is best effort. Previously evicted records cannot be recovered.', file=sys.stderr)
            save_snapshot(data, args)
            if not args.watch:
                return data
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return data
            time.sleep(min(args.interval, remaining))
            if time.monotonic() >= deadline:
                return data
    finally:
        if archive and archive.locked:
            archive.__exit__(None, None, None)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Monitoring stopped; previously saved data is preserved.', file=sys.stderr)
        raise SystemExit(130)
    except urllib.error.HTTPError as error:
        print(f'Monitoring GET failed: HTTP {error.code}. Check endpoint/authentication; no benchmark fallback.', file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError, ImportError) as error:
        print(f'Monitoring stopped: {error}', file=sys.stderr)
        raise SystemExit(1)
