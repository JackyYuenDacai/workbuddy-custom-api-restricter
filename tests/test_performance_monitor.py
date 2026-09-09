import contextlib
import copy
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/llm-performance-probe/scripts/probe_llm.py'
SPEC = importlib.util.spec_from_file_location('performance_monitor', SCRIPT)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


def snapshot(first=1, last=80, session='session-a'):
    records = [{'sequence': sequence, 'job_id': sequence - 1, 'completed': True,
                'prompt_tokens': 526, 'new_tokens': 80, 'time_prefill': 0.393,
                'decode_tokens_per_second': 80.68} for sequence in range(first, last + 1)]
    return {'base': 'http://127.0.0.1:5000', 'model_name': 'test-model', 'captured_at': monitor.utc_now(),
            'performance': {'recent_requests': records, 'history': {'session_id': session, 'capacity': 4096,
                            'first_sequence': first, 'last_sequence': last, 'total_recorded': last}}}


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_fetch_uses_only_get_with_no_prompt_and_preserves_all_fields(self):
        data = snapshot()
        data['performance']['extra_metric'] = {'value': 123}
        response = Mock()
        response.read.return_value = json.dumps(data).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(monitor.urllib.request, 'build_opener', return_value=opener):
            result = monitor.fetch_backend('http://127.0.0.1:5000/v1', api_key='test-secret')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), 'GET')
        self.assertEqual(request.full_url, 'http://127.0.0.1:5000/v1/internal/model/info')
        self.assertIsNone(request.data)
        self.assertEqual(len(result['performance']['recent_requests']), 80)
        self.assertEqual(result['performance']['extra_metric'], {'value': 123})
        self.assertNotIn('test-secret', json.dumps(result))

    def test_credentials_and_redirects_are_rejected(self):
        for base in ('http://user:pass@localhost:5000', 'file:///tmp/data', 'http://localhost:5000/?key=secret'):
            with self.subTest(base=base), self.assertRaises(ValueError):
                monitor.normalize_base(base)
        with self.assertRaisesRegex(ValueError, 'redirects'):
            monitor.NoRedirect().redirect_request(None, None, 302, None, {}, 'http://other/')

    def test_default_mode_is_one_read_only_fetch_and_old_benchmarks_are_removed(self):
        with patch.object(monitor, 'fetch_backend', return_value=snapshot()) as fetch, contextlib.redirect_stdout(io.StringIO()):
            monitor.main(['--out', str(self.root / 'snapshot.json')])
        fetch.assert_called_once()
        self.assertEqual(len(json.loads((self.root / 'snapshot.json').read_text())['performance']['recent_requests']), 80)
        for option in ('--verify', '--long'):
            with patch.object(monitor, 'fetch_backend') as fetch, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    monitor.main([option])
                fetch.assert_not_called()

    def test_archive_grows_beyond_retention_and_deduplicates_across_restarts(self):
        archive_path = self.root / 'jobs.jsonl'
        with monitor.Archive(archive_path) as archive:
            self.assertEqual(archive.append(snapshot(1, 80))['added'], 80)
            self.assertEqual(archive.append(snapshot(50, 150))['added'], 70)
            self.assertEqual(archive.append(snapshot(50, 150))['added'], 0)
        with monitor.Archive(archive_path) as archive:
            self.assertEqual(archive.append(snapshot(120, 200))['added'], 50)
            self.assertEqual(archive.append(snapshot(1, 2, 'session-b'))['added'], 2)
        self.assertEqual(len(monitor.read_archive(archive_path)), 202)
        data = monitor.load_archive_data(archive_path)
        self.assertEqual(len(data['performance']['recent_requests']), 202)
        self.assertEqual(data['performance']['archive_sources'], 2)
        self.assertFalse(archive_path.with_name('jobs.jsonl.lock').exists())

    def test_archive_reports_missing_jobs_instead_of_inventing_them(self):
        with monitor.Archive(self.root / 'jobs.jsonl') as archive:
            self.assertEqual(archive.append(snapshot(69, 100))['unavailable_before_this_sample'], 68)
            result = archive.append(snapshot(105, 110))
            self.assertEqual(result['unavailable_before_this_sample'], 4)
            self.assertEqual(result['unique_records'], 38)
        coverage = monitor.load_archive_data(self.root / 'jobs.jsonl')['performance']['archive_coverage'][0]
        self.assertEqual(coverage['missing_before_first'], 68)
        self.assertEqual(coverage['missing_between_first_and_last'], 4)
        self.assertIsNone(coverage['missing_after_last'])

    def test_archive_can_exceed_the_4096_record_server_capacity(self):
        archive_path = self.root / 'large.jsonl'
        with monitor.Archive(archive_path) as archive:
            archive.append(snapshot(1, 4096))
            result = archive.append(snapshot(2049, 6144))
        self.assertEqual(result['unique_records'], 6144)
        self.assertEqual(result['unavailable_before_this_sample'], 0)
        self.assertEqual(len(monitor.read_archive(archive_path)), 6144)

    def test_legacy_archive_is_explicitly_best_effort(self):
        data = snapshot(1, 2)
        data['performance'].pop('history')
        for record in data['performance']['recent_requests']:
            record.pop('sequence')
        with monitor.Archive(self.root / 'legacy.jsonl') as archive:
            result = archive.append(data)
            self.assertIn('best effort', result['identity'])
            self.assertIsNone(result['unavailable_before_this_sample'])
            self.assertEqual(archive.append(data)['added'], 0)

    def test_archive_lock_prevents_competing_writers(self):
        archive_path = self.root / 'jobs.jsonl'
        with monitor.Archive(archive_path):
            with self.assertRaisesRegex(ValueError, 'locked'):
                with monitor.Archive(archive_path):
                    self.fail('Second writer must not acquire the archive')
        self.assertFalse(archive_path.with_name('jobs.jsonl.lock').exists())

    def test_corrupted_archive_is_not_overwritten_and_lock_is_released(self):
        archive_path = self.root / 'jobs.jsonl'
        archive_path.write_text('{invalid', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Invalid archive row'):
            with monitor.Archive(archive_path):
                self.fail('Corrupt archive must not open')
        self.assertEqual(archive_path.read_text(), '{invalid')
        self.assertFalse(archive_path.with_name('jobs.jsonl.lock').exists())

    def test_export_limit_does_not_limit_archive_or_modify_original(self):
        data = snapshot(1, 100)
        original = copy.deepcopy(data)
        with patch.object(monitor, 'fetch_backend', return_value=data), contextlib.redirect_stdout(io.StringIO()):
            monitor.main(['--archive', str(self.root / 'jobs.jsonl'), '--limit', '40', '--out', str(self.root / 'latest.json')])
        exported = json.loads((self.root / 'latest.json').read_text())
        self.assertEqual(len(exported['performance']['recent_requests']), 40)
        self.assertEqual(len(monitor.read_archive(self.root / 'jobs.jsonl')), 100)
        self.assertEqual(data['performance'], original['performance'])

    def test_offline_mode_never_contacts_server(self):
        archive_path = self.root / 'jobs.jsonl'
        with monitor.Archive(archive_path) as archive:
            archive.append(snapshot())
        with patch.object(monitor, 'fetch_backend') as fetch, contextlib.redirect_stdout(io.StringIO()):
            monitor.main(['--from-archive', str(archive_path), '--out', str(self.root / 'offline.json')])
        fetch.assert_not_called()

    def test_output_cannot_overwrite_archive(self):
        target = str(self.root / 'jobs.jsonl')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            monitor.main(['--archive', target, '--out', target])
        self.assertFalse(Path(target).exists())
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            monitor.main(['--archive', target, '--out', target + '.lock'])

    def test_watch_is_bounded_and_saves_unique_jobs(self):
        clock = [0.0]
        def sleep(seconds):
            clock[0] += seconds
        with patch.object(monitor.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(monitor.time, 'sleep', side_effect=sleep), \
                patch.object(monitor, 'fetch_backend', side_effect=[snapshot(1, 80), snapshot(1, 90), snapshot(1, 100)]) as fetch, \
                contextlib.redirect_stdout(io.StringIO()):
            monitor.main(['--watch', '--duration', '5', '--interval', '2', '--archive', str(self.root / 'jobs.jsonl'),
                          '--out', str(self.root / 'latest.json')])
        self.assertEqual(fetch.call_count, 3)
        self.assertEqual(clock[0], 5)
        self.assertEqual(len(monitor.read_archive(self.root / 'jobs.jsonl')), 100)

    def test_missing_values_are_not_zero_and_html_escapes_untrusted_fields(self):
        data = snapshot(1, 120)
        data['model_name'] = '<script>alert(1)</script>'
        data['performance']['recent_requests'][0]['job_id'] = '<img src=x onerror=alert(1)>'
        monitor.render_html(data, self.root / 'report.html')
        page = (self.root / 'report.html').read_text(encoding='utf-8')
        self.assertNotIn('<script>', page)
        self.assertNotIn('<img ', page)
        self.assertIn('&lt;script&gt;', page)
        self.assertEqual(page.count('<tr>'), 121)
        self.assertIn('N/A', page)
        report = monitor.summary([{'time_prefill': None}, {'time_prefill': float('nan')}, {'time_prefill': 4}])
        self.assertEqual(report['median_prefill_s'], 4)
        self.assertIsNone(report['median_decode_tokens_s'])

    def test_csv_neutralizes_formula_strings_but_preserves_numbers(self):
        data = snapshot(1, 1)
        data['performance']['recent_requests'][0].update(job_id='=1+1', example_number=-2)
        monitor.write_csv(data, self.root / 'jobs.csv')
        row = next(monitor.csv.DictReader(io.StringIO((self.root / 'jobs.csv').read_text())))
        self.assertEqual(row['job_id'], "'=1+1")
        self.assertEqual(row['example_number'], '-2')

    def test_unavailable_metrics_fail_without_benchmark_fallback(self):
        response = Mock()
        response.read.return_value = b'{"model_name":"no-model"}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        with patch.object(monitor.urllib.request, 'build_opener', return_value=opener), self.assertRaisesRegex(ValueError, 'No recorded performance'):
            monitor.fetch_backend(monitor.DEFAULT_BASE)
        opener.open.assert_called_once()


if __name__ == '__main__':
    unittest.main()
