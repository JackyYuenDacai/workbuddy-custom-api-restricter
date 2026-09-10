"""Local QCE API client. No QQ injection, database decryption or UI automation.

CLI accepts one JSON request on stdin; results contain metadata, not messages.
QCE_BASE_URL defaults to http://127.0.0.1:40653. Authentication is read from
QCE_TOKEN_FILE or QCE_TOKEN, never from a tool argument or printed in errors.
"""
from datetime import date, datetime, time, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

CHINA = timezone(timedelta(hours=8))
DEFAULT_ROOT = Path(__file__).resolve().parents[3] / 'qq-message-exports'
MAX_RESPONSE = 8 * 1024 * 1024


class ExportError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ExportError('QCE redirect refused; configure its direct loopback address')


def base_url(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', '::1', 'localhost')
            or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise ExportError('QCE_BASE_URL must be a plain HTTP loopback origin, without credentials or path')
    try:
        port = parsed.port or 80
    except ValueError:
        raise ExportError('Invalid QCE port') from None
    if not 1 <= port <= 65535:
        raise ExportError('Invalid QCE port')
    # Normalize localhost to a literal so DNS cannot route the token elsewhere.
    host = '[::1]' if parsed.hostname == '::1' else '127.0.0.1'
    return f'http://{host}:{port}'


def interval(start, end):
    """Date-only end is an inclusive calendar day; timed end is exclusive."""
    def parse(value, is_end):
        if not isinstance(value, str) or len(value) > 40:
            raise ExportError('Dates must be ISO strings')
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            day = date.fromisoformat(value)
            if is_end:
                day += timedelta(days=1)
            return datetime.combine(day, time(), CHINA)
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            raise ExportError('Timed values require an explicit UTC offset, e.g. +08:00')
        if dt.microsecond:
            raise ExportError('Use whole seconds; fractional timestamps are not supported')
        return dt
    try:
        first, last = parse(start, False), parse(end, True)
    except (ValueError, OverflowError):
        raise ExportError('Invalid ISO date or timestamp') from None
    if first >= last or first.year < 2000:
        raise ExportError('Expected a nonempty interval starting in year 2000 or later')
    return {
        'start_inclusive': first.isoformat(), 'end_exclusive': last.isoformat(),
        'timezone_for_dates': 'UTC+08:00',
        # QCE standard export uses inclusive end; QQ timestamps have second resolution.
        'startTime': int(first.timestamp()), 'endTime': int(last.timestamp()) - 1,
    }


def numeric_id(value, label='ID'):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{3,19}', value):
        raise ExportError(f'{label} must be a decimal string of 4-20 digits')
    return value


class Client:
    def __init__(self, url=None, token=None, root=None, timeout=12):
        self.url = base_url(url or os.environ.get('QCE_BASE_URL', 'http://127.0.0.1:40653'))
        if token is None:
            token_file = os.environ.get('QCE_TOKEN_FILE')
            if token_file:
                try:
                    token = Path(token_file).read_text(encoding='utf-8').strip()
                except OSError:
                    raise ExportError('Cannot read QCE_TOKEN_FILE; set a private local token file') from None
            else:
                token = os.environ.get('QCE_TOKEN', '')
        if '\n' in token or '\r' in token:
            raise ExportError('Invalid authentication token format')
        self.token = token
        self.root = Path(root or os.environ.get('QCE_EXPORT_ROOT', DEFAULT_ROOT)).resolve()
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, route, payload=None):
        if not route.startswith('/api/') or '://' in route:
            raise ExportError('Unsupported API route')
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.url + route, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ExportError('QCE response exceeds metadata size limit')
            body = json.loads(raw)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise ExportError('QCE authentication rejected; configure QCE_TOKEN_FILE locally') from None
            raise ExportError(f'QCE returned HTTP {error.code}; check its local UI for details') from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            raise ExportError('QCE connection failed or timed out. Check the local service; a submitted export may still exist') from None
        except (ValueError, UnicodeError):
            raise ExportError('QCE returned invalid JSON or an incompatible API') from None
        if not isinstance(body, dict) or body.get('success') is not True or 'data' not in body:
            raise ExportError('QCE API did not report success; inspect the local QCE UI')
        return body['data']

    def status(self):
        info = self.request('GET', '/api/system/info')
        if not isinstance(info, dict) or not isinstance(info.get('napcat'), dict):
            raise ExportError('Incompatible QCE system-info schema')
        napcat = info['napcat']
        return {'base_url': self.url, 'name': info.get('name'), 'version': info.get('version'),
                'mode': info.get('mode'), 'online': napcat.get('online') is True,
                'account_uin': napcat.get('selfInfo', {}).get('uin'),
                'ready': info.get('mode') != 'standalone' and napcat.get('online') is True}

    def find(self, kind, query):
        if kind not in ('group', 'friend') or not isinstance(query, str) or not 1 <= len(query.strip()) <= 100:
            raise ExportError('Supply group/friend kind and a nonempty ID or name query (max 100 characters)')
        plural = 'groups' if kind == 'group' else 'friends'
        matches, seen = [], set()
        needle = query.strip().casefold()
        for page in range(1, 51):
            data = self.request('GET', f'/api/{plural}?page={page}&limit=200')
            if not isinstance(data, dict) or not isinstance(data.get(plural), list) or not isinstance(data.get('hasNext'), bool):
                raise ExportError('Incompatible QCE chat-list pagination schema')
            records = data[plural]
            if data['hasNext'] and not records:
                raise ExportError('QCE returned an empty page with hasNext=true')
            for record in records:
                if not isinstance(record, dict):
                    raise ExportError('Invalid conversation record')
                chat_id = str(record.get('groupCode' if kind == 'group' else 'uin', ''))
                uid = chat_id if kind == 'group' else record.get('uid')
                name = record.get('groupName' if kind == 'group' else 'nick') or ''
                remark = record.get('remark') or ''
                # Numeric input always means an exact ID, never a substring of another ID.
                hit = chat_id == needle if needle.isdecimal() else any(needle in str(s).casefold() for s in (name, remark, uid))
                if hit and (chat_id, uid) not in seen:
                    seen.add((chat_id, uid))
                    matches.append({'kind': kind, 'id': chat_id, 'peer_uid': uid, 'name': name,
                                    'remark': remark, 'chat_type': 2 if kind == 'group' else record.get('chatType', 1)})
            if not data['hasNext']:
                return {'matches': matches[:50], 'match_count': len(matches),
                        'truncated': len(matches) > 50, 'pages_read': page}
        raise ExportError('Conversation pagination limit reached; results may be incomplete')

    def plan(self, args):
        kind = args.get('kind')
        if kind not in ('group', 'friend'):
            raise ExportError('kind must be group or friend')
        chat_id = numeric_id(args.get('chat_id'), 'chat_id')
        dates = interval(args.get('start'), args.get('end'))
        fmt = args.get('format', 'JSON')
        if fmt not in ('JSON', 'TXT', 'HTML', 'EXCEL'):
            raise ExportError('format must be JSON, TXT, HTML or EXCEL')
        senders = args.get('sender_ids', [])
        if not isinstance(senders, list) or len(senders) > 50:
            raise ExportError('sender_ids must be a list of at most 50 QQ numbers')
        senders = list(dict.fromkeys(numeric_id(s, 'sender_id') for s in senders))
        media = args.get('include_media', False)
        if not isinstance(media, bool):
            raise ExportError('include_media must be boolean')
        return {'kind': kind, 'chat_id': chat_id, 'interval': dates, 'format': fmt,
                'sender_ids': senders, 'include_media': media, 'output_root': str(self.root),
                'history_source': 'QCE local history; availability is not guaranteed complete'}

    def export(self, args):
        plan = self.plan(args)
        dry_run = args.get('dry_run', True)
        if not isinstance(dry_run, bool):
            raise ExportError('dry_run must be boolean')
        if dry_run:
            return {'dry_run': True, 'submitted': False, 'plan': plan, 'identity_verified': False}
        status = self.status()
        if not status['ready']:
            raise ExportError('QCE is offline or standalone (viewer only); log in through its supported launcher')
        found = self.find(plan['kind'], plan['chat_id'])
        if found['truncated'] or found['match_count'] != 1:
            raise ExportError('Chat ID must resolve to exactly one current conversation')
        chat = found['matches'][0]
        if chat['chat_type'] not in (1, 2) or not isinstance(chat['peer_uid'], str) or not chat['peer_uid']:
            raise ExportError('Only normal friend/group chats with a resolved peer UID are supported')
        job_id = str(uuid.uuid4())
        folder = self.root / job_id
        folder.mkdir(parents=True, exist_ok=False)
        output = folder / 'files'
        output.mkdir()
        payload = {'peer': {'chatType': chat['chat_type'], 'peerUid': chat['peer_uid'],
                            'peerUin': chat['id'], 'guildId': ''},
                   'sessionName': chat['name'], 'format': plan['format'],
                   'filter': {'startTime': plan['interval']['startTime'],
                              'endTime': plan['interval']['endTime'], 'includeRecalled': False},
                   'options': {'batchSize': 5000, 'includeResourceLinks': True,
                               'includeSystemMessages': True, 'filterPureImageMessages': False,
                               'prettyFormat': True, 'exportAsZip': False,
                               'embedAvatarsAsBase64': False, 'embedResourcesAsDataUri': False,
                               'debugExport': False, 'outputDir': str(output),
                               'skipDownloadResourceTypes': [] if plan['include_media'] else ['image','video','audio','file']}}
        if plan['sender_ids']:
            payload['filter']['includeUserUins'] = plan['sender_ids']
        receipt = {'job_id': job_id, 'base_url': self.url, 'plan': plan, 'chat': chat,
                   'account_uin': status['account_uin'], 'request': payload,
                   'created_at': datetime.now(timezone.utc).isoformat(), 'submission': 'unknown'}
        self.save(folder, receipt)
        try:
            result = self.request('POST', '/api/messages/export', payload)
            task_id = result.get('taskId') if isinstance(result, dict) else None
            if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', task_id):
                raise ExportError('Export response had no valid task ID')
            receipt.update(submission='accepted', task_id=task_id)
            self.save(folder, receipt)
        except (ExportError, OSError) as error:
            # Never repeat POST automatically: timeout may follow successful submission.
            return {'job_id': job_id, 'submission': 'unknown', 'receipt': str(folder/'receipt.json'),
                    'error': str(error), 'next': 'Inspect the QCE task list before any new export; do not auto-resubmit'}
        return {'job_id': job_id, 'task_id': task_id, 'submission': 'accepted',
                'receipt': str(folder/'receipt.json'), 'output_directory': str(output),
                'completed': False, 'plan': plan}

    @staticmethod
    def save(folder, receipt):
        temporary = folder / 'receipt.tmp'
        temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(folder / 'receipt.json')

    def task(self, job_id):
        try:
            if str(uuid.UUID(job_id)) != job_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ExportError('job_id must be a UUID returned by this tool') from None
        folder = (self.root / job_id).resolve()
        if not folder.is_relative_to(self.root):
            raise ExportError('Job directory is outside configured export root')
        try:
            receipt = json.loads((folder/'receipt.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise ExportError('Local job receipt not found or invalid') from None
        if receipt.get('base_url') != self.url:
            raise ExportError('This job belongs to a different QCE service address')
        if receipt.get('submission') != 'accepted':
            return {'job_id': job_id, 'submission': 'unknown', 'completed': False,
                    'next': 'Inspect QCE UI for the original task; do not resubmit automatically'}
        task_id = receipt.get('task_id')
        if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', task_id):
            raise ExportError('Invalid task ID in receipt')
        task = self.request('GET', '/api/tasks/' + task_id)
        if not isinstance(task, dict):
            raise ExportError('Invalid task response')
        peer = task.get('peer', {})
        if peer.get('peerUid') != receipt['chat']['peer_uid'] or peer.get('chatType') != receipt['chat']['chat_type']:
            raise ExportError('Task identity differs from submitted conversation')
        output = folder / 'files'
        files = []
        if task.get('status') == 'completed' and output.is_dir():
            expected = {'JSON': '.json', 'TXT': '.txt', 'HTML': '.html', 'EXCEL': '.xlsx'}[receipt['plan']['format']]
            for p in sorted(output.iterdir()):
                if p.is_file() and p.suffix.lower() == expected and p.resolve().is_relative_to(output.resolve()):
                    files.append({'path': str(p), 'bytes': p.stat().st_size})
        return {'job_id': job_id, 'task_id': task_id, 'status': task.get('status'),
                'progress': task.get('progress'), 'message_count': task.get('messageCount'),
                'completed': task.get('status') == 'completed', 'files': files,
                'local_artifact_present': any(f['bytes'] > 0 for f in files),
                'coverage_verified': False,
                'note': 'Task completion and file presence do not prove all historical messages are available; verify dates and samples'}


def dispatch(args, client=None):
    client = client or Client()
    action = args.get('action')
    if action == 'status':
        return client.status()
    if action == 'find':
        return client.find(args.get('kind'), args.get('query'))
    if action == 'export':
        return client.export(args)
    if action == 'task':
        return client.task(args.get('job_id'))
    raise ExportError('Unknown action; use status, find, export or task')


if __name__ == '__main__':
    try:
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ExportError('Request too large')
        args = json.loads(raw)
        if not isinstance(args, dict):
            raise ExportError('Request must be a JSON object')
        print(json.dumps({'ok': True, 'result': dispatch(args)}, ensure_ascii=False))
    except (ExportError, ValueError, OSError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
