import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CAP = 64000;
const supported = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
export function approvalResponse(request, decision, answers = {}) {
  if (!['approve', 'deny', 'cancel'].includes(decision)) throw Error('Invalid approval decision.');
  if (request.method === 'item/tool/requestUserInput') {
    if (decision !== 'approve') return { answers: {} };
    const questions = request.params.questions || [];
    if (questions.some(q => !Array.isArray(answers[q.id]) || !answers[q.id].length)) throw Error('Provide an answer for each requested question.');
    return { answers: Object.fromEntries(questions.map(q => [q.id, { answers: answers[q.id] }])) };
  }
  if (request.method === 'item/permissions/requestApproval') return { permissions: decision === 'approve' ? request.params.permissions : {}, scope: 'turn' };
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
    const value = { approve: 'accept', deny: 'decline', cancel: 'cancel' }[decision];
    if (request.params.availableDecisions && !request.params.availableDecisions.includes(value)) throw Error('This decision is unavailable for this request. Do not substitute a persistent approval.');
    return { decision: value };
  }
  throw Error('Unsupported approval request.');
}
export function startApprovalJob(runner, options) {
  const { prompt, cwd, sandbox = 'workspace-write', model, timeout_seconds = 900, additional_write_dirs = [], resume_thread_id } = options;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw Error('prompt must contain 1-100000 characters.');
  for (const dir of [cwd, ...additional_write_dirs]) if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Error('All working directories must be existing absolute directories.');
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw Error('Unsupported sandbox.');
  if (!Array.isArray(additional_write_dirs) || additional_write_dirs.length > 16 || additional_write_dirs.some(d => path.resolve(d) === path.parse(path.resolve(d)).root) || (sandbox === 'read-only' && additional_write_dirs.length)) throw Error('Invalid additional_write_dirs.');
  if (!Number.isInteger(timeout_seconds) || timeout_seconds < 10 || timeout_seconds > 3600) throw Error('timeout_seconds must be 10-3600.');
  if ([...runner.jobs.values()].some(j => ['running', 'stopping'].includes(j.state))) throw Error('A Codex job is already active.');
  while (runner.jobs.size >= runner.maxJobs) runner.jobs.delete(runner.jobs.keys().next().value);
  const job = { id: randomUUID(), state: 'running', phase: 'starting', backend: 'codex app-server', cwd: fs.realpathSync.native(cwd), sandbox, model, approval_policy: 'ask-user', additional_write_dirs,
    started_at: new Date().toISOString(), ended_at: null, thread_id: null, turn_id: null, exit_code: null, answer: '', progress: '', stderr: '', error: null, events_seen: 0, output_truncated: false, turn_completed: false, permission_issues: [], pending_approvals: [], approval_history: [], deadline: Date.now() + timeout_seconds * 1000 };
  const wire = new Map(), requests = new Map(), items = new Map(); let sequence = 0, line = '', discard = false, exitTimer, approvalTimer, remaining, resultState;
  job.closed = new Promise(resolve => { job.resolveClosed = resolve; }); runner.jobs.set(job.id, job);
  const bounded = value => { const text = String(value); if (text.length > CAP) job.output_truncated = true; return text.slice(-CAP); };
  function send(message) { if (!job.child || job.child.stdin.destroyed) throw Error('Approval connection is closed.'); job.child.stdin.write(JSON.stringify(message) + '\n'); }
  function rpc(method, params) { return new Promise((resolve, reject) => { const id = `wb-${++sequence}`; const timer = setTimeout(() => { wire.delete(id); reject(Error(`Codex protocol request timed out: ${method}`)); }, 30000); wire.set(id, { resolve, reject, timer }); try { send({ id, method, params }); } catch (e) { clearTimeout(timer); wire.delete(id); reject(e); } }); }
  function stopAfterTurn() {
    clearTimeout(job.timer); clearTimeout(approvalTimer); requests.clear(); job.pending_approvals = [];
    job.child?.stdin.end(); exitTimer = setTimeout(() => { if (job.child?.pid) runner.stopProcess(job.child.pid, true).catch(e => { job.error = bounded(e.message); }); }, 1500);
  }
  function resumeClock() { if (requests.size || job.ended_at || job.phase !== 'awaiting_user') return; clearTimeout(approvalTimer); job.phase = 'working'; job.deadline = Date.now() + remaining; runner.armDeadline(job); }
  function publicRequests() { job.pending_approvals = [...requests.values()].map(x => ({ approval_id: x.approval_id, method: x.method, details: x.params, item: items.get(x.params.itemId) || null })); }
  function receive(message) {
    job.events_seen++;
    if (message.id !== undefined && !message.method) { const waiter = wire.get(message.id); if (!waiter) return; clearTimeout(waiter.timer); wire.delete(message.id); if (message.error) waiter.reject(Error(message.error.message)); else waiter.resolve(message.result); return; }
    if (message.method && message.id !== undefined) {
      if (!supported.has(message.method) || JSON.stringify({ message, item: items.get(message.params?.itemId) }).length > CAP) { send({ id: message.id, error: { code: -32601, message: 'Request cannot be safely displayed by this approval bridge; not approved.' } }); return; }
      if (message.params.threadId !== job.thread_id) { send({ id: message.id, error: { code: -32602, message: 'Wrong thread for approval.' } }); return; }
      if (message.params.turnId && job.turn_id && message.params.turnId !== job.turn_id) { send({ id: message.id, error: { code: -32602, message: 'Stale turn for approval.' } }); return; }
      const request = { ...message, approval_id: randomUUID() }; requests.set(request.approval_id, request); publicRequests();
      if (job.phase !== 'awaiting_user') { remaining = Math.max(1000, job.deadline - Date.now()); clearTimeout(job.timer); approvalTimer = setTimeout(() => { runner.cancel(job.id, 'timed_out').catch(e => { job.error = bounded(e.message); }); }, 30 * 60 * 1000); }
      job.phase = 'awaiting_user'; job.progress = 'User response required. Show pending_approvals in WorkBuddy; never infer consent.'; return;
    }
    const p = message.params || {}; if (p.threadId && job.thread_id && p.threadId !== job.thread_id) return;
    if (message.method === 'turn/started') job.turn_id = p.turn?.id || job.turn_id;
    if (message.method === 'item/started' && p.item) { items.set(p.item.id, p.item); if (items.size > 50) items.delete(items.keys().next().value); }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') job.answer = bounded(p.item.text || '');
    if (message.method === 'serverRequest/resolved') { for (const [id, request] of requests) if (request.id === p.requestId) requests.delete(id); publicRequests(); resumeClock(); }
    if (message.method === 'error') job.error = bounded(p.error?.message || p.message || 'Codex error');
    if (message.method === 'turn/completed') {
      job.turn_completed = p.turn?.status === 'completed'; resultState = job.turn_completed ? 'completed' : p.turn?.status === 'interrupted' ? 'cancelled' : 'failed';
      if (job.turn_completed) job.error = null; else job.error = bounded(p.turn?.error?.message || job.error || `Turn ${p.turn?.status}`);
      stopAfterTurn();
    }
    if (message.method && job.phase !== 'awaiting_user') job.progress = bounded(JSON.stringify(message));
  }
  function finish(code) {
    if (job.ended_at) return; clearTimeout(job.timer); clearTimeout(approvalTimer); clearTimeout(exitTimer);
    for (const waiter of wire.values()) { clearTimeout(waiter.timer); waiter.reject(Error('Codex approval connection closed.')); } wire.clear(); requests.clear(); job.pending_approvals = [];
    job.exit_code = code; job.state = job.stopReason || resultState || 'failed'; job.phase = 'ended'; job.ended_at = new Date().toISOString();
    if (job.state === 'failed' && !job.error) job.error = 'Codex app-server exited without a completed turn.';
    delete job.child; delete job.replyApproval; job.resolveClosed();
  }
  job.replyApproval = (approvalId, decision, userResponse, answers) => {
    if (job.ended_at || job.state !== 'running') throw Error('Job is no longer awaiting approval.');
    const request = requests.get(approvalId); if (!request) throw Error('Unknown, stale, or already answered approval_id.');
    if (typeof userResponse !== 'string' || !userResponse.trim() || userResponse.length > 8000) throw Error('An actual user response is required; never infer approval.');
    const result = approvalResponse(request, decision, answers);
    send({ id: request.id, result }); requests.delete(approvalId); publicRequests();
    job.approval_history.push({ approval_id: approvalId, decision, user_response: userResponse, at: new Date().toISOString() });
    if (job.approval_history.length > 50) job.approval_history.shift(); resumeClock(); return runner.get(job.id);
  };
  try {
    const child = runner.spawnProcess(runner.discover(), ['app-server', '--stdio'], { cwd: job.cwd, env: process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); job.child = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) || []) { if (!discard) line += part; if (line.length > 2 * 1024 * 1024) { discard = true; line = ''; job.output_truncated = true; } if (part.endsWith('\n')) { if (!discard) { try { receive(JSON.parse(line)); } catch (e) { job.error = bounded(`Protocol error: ${e.message}`); } } line = ''; discard = false; } } });
    child.stderr.on('data', chunk => { job.stderr = bounded(job.stderr + chunk); }); child.stdin.on('error', e => { if (e.code !== 'EPIPE') job.error = bounded(e.message); });
    child.on('error', e => { job.error = bounded(e.message); finish(null); }); child.on('close', finish); runner.armDeadline(job);
    (async () => {
      await rpc('initialize', { clientInfo: { name: 'workbuddy-approval-bridge', version: '1.1.0' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized', params: {} });
      const params = { cwd: job.cwd, sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'user', ...(model ? { model } : {}), ...(additional_write_dirs.length ? { config: { 'sandbox_workspace_write.writable_roots': additional_write_dirs } } : {}) };
      const thread = await rpc(resume_thread_id ? 'thread/resume' : 'thread/start', resume_thread_id ? { ...params, threadId: resume_thread_id, excludeTurns: true } : params);
      job.thread_id = thread.thread.id; job.phase = 'working';
      const turn = await rpc('turn/start', { threadId: job.thread_id, approvalPolicy: 'on-request', approvalsReviewer: 'user', input: [{ type: 'text', text: prompt }] }); job.turn_id = turn.turn.id;
    })().catch(e => { if (!job.ended_at) { job.error = bounded(e.message); resultState = 'failed'; stopAfterTurn(); } });
  } catch (e) { job.error = bounded(e.message); finish(null); }
  return runner.get(job.id);
}
