import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Runner, buildArgs } from './runner.mjs';
const cwd = fileURLToPath(new URL('.', import.meta.url));
function fixtureRunner() {
  return new Runner({ discover: () => process.execPath,
    spawnProcess: (exe, args, options) => spawn(exe, [fileURLToPath(new URL('fixture.mjs', import.meta.url))], options) });
}
async function terminal(runner, id) {
  for (let n = 0; n < 200; n++) {
    const job = runner.get(id);
    if (!['running', 'stopping'].includes(job.state)) return job;
    await new Promise(r => setTimeout(r, 25));
  }
  throw Error('fixture failed to terminate');
}
test('arguments retain sandbox and prompt uses stdin', () => {
  const args = buildArgs({ cwd, sandbox: 'workspace-write', model: 'user-model' });
  assert.deepEqual(args.slice(0, 2), ['exec', '--approve-for-me']);
  assert.equal(args.at(-1), '-');
  assert.ok(!args.includes('--sandbox'), '--approve-for-me already selects workspace-write and conflicts with --sandbox');
  assert.ok(!args.some(a => a.includes('bypass')));
});
test('reject invalid directories, sandbox and timeout before spawn', () => {
  const r = fixtureRunner();
  assert.throws(() => r.start({ prompt: 'x', cwd: 'relative' }), /absolute/);
  assert.throws(() => r.start({ prompt: 'x', cwd, sandbox: 'danger-full-access' }), /sandboxes/);
  assert.throws(() => r.start({ prompt: 'x', cwd, timeout_seconds: 0 }), /10-3600/);
});
test('Unicode and shell metacharacters are passed literally; completed answer is parsed', async () => {
  const r = fixtureRunner();
  const prompt = '中文 $(whoami) `literal` & | "quoted"\nsecond line';
  const job = await terminal(r, r.start({ prompt, cwd }).id);
  assert.equal(job.state, 'completed'); assert.equal(job.answer, prompt); assert.equal(job.thread_id, 'fixture-thread');
});
test('turn failure is not success even when process exits zero', async () => {
  const r = fixtureRunner();
  const job = await terminal(r, r.start({ prompt: 'fail', cwd }).id);
  assert.equal(job.state, 'failed'); assert.equal(job.error, 'fixture failure');
});
test('one active job and cancellation terminates the owned process', async () => {
  const r = fixtureRunner();
  const job = r.start({ prompt: 'hold', cwd });
  assert.throws(() => r.start({ prompt: 'second', cwd }), /already active/);
  await r.cancel(job.id);
  const result = await terminal(r, job.id);
  assert.equal(result.state, 'cancelled');
  assert.equal((await r.cancel(job.id)).state, 'cancelled');
});
test('output is bounded and truncation reported', async () => {
  const r = fixtureRunner();
  const result = await terminal(r, r.start({ prompt: 'x'.repeat(70000), cwd }).id);
  assert.equal(result.answer.length, 64000); assert.equal(result.output_truncated, true);
});

test('completed turn clears a recovered network error', async () => {
  const r = fixtureRunner();
  const job = await terminal(r, r.start({ prompt: 'recover', cwd }).id);
  assert.equal(job.state, 'completed'); assert.equal(job.answer, 'recover'); assert.equal(job.error, null);
});

test('closing the runner stops its active job', async () => {
  const r = fixtureRunner();
  const job = r.start({ prompt: 'hold', cwd });
  await r.close();
  assert.equal((await terminal(r, job.id)).state, 'cancelled');
});
test('deadline kills the job and reports timed_out', async () => {
  const r = fixtureRunner();
  const job = r.start({ prompt: 'hold', cwd, timeout_seconds: 10 });
  await new Promise(resolve => setTimeout(resolve, 10500));
  assert.equal((await terminal(r, job.id)).state, 'timed_out');
});

test('zero exit without completed turn is failed, even with a partial answer', async () => {
  for (const prompt of ['empty', 'partial']) {
    const r = fixtureRunner();
    const job = await terminal(r, r.start({ prompt, cwd }).id);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /without a turn.completed/);
    assert.equal(job.turn_completed, false);
  }
});

test('malformed JSON values do not crash or falsely complete the runner', async () => {
  const r = fixtureRunner();
  const job = await terminal(r, r.start({ prompt: 'malformed', cwd }).id);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /without text/);
});

test('progress, discarded lines, and errors report output truncation', async () => {
  for (const prompt of ['progress', 'long-line', 'long-error']) {
    const r = fixtureRunner();
    const job = await terminal(r, r.start({ prompt, cwd }).id);
    assert.equal(job.output_truncated, true, prompt);
    assert.ok(job.progress.length <= 64000);
    assert.ok((job.error || '').length <= 64000);
  }
});

test('completed event does not override a failing exit code', async () => {
  const r = fixtureRunner();
  const job = await terminal(r, r.start({ prompt: 'nonzero', cwd }).id);
  assert.equal(job.state, 'failed');
  assert.equal(job.exit_code, 1);
});

test('login status distinguishes logged out from inspection errors', async () => {
  const results = [
    [null, true, null],
    [Object.assign(Error('exit 1'), { code: 1, stderr: 'Not logged in' }), false, null],
    [Object.assign(Error('timeout'), { code: 'ETIMEDOUT', killed: true }), null, /timeout/],
    [Object.assign(Error('bad config'), { code: 1, stderr: 'Cannot parse config' }), null, /Cannot parse config/]
  ];
  for (const [error, expected, pattern] of results) {
    const r = new Runner({ discover: () => process.execPath, execProcess: async (exe, args) => {
      if (args[0] === '--version') return { stdout: 'codex fixture' };
      if (error) throw error;
      return { stdout: '' };
    } });
    const status = await r.status();
    assert.equal(status.logged_in, expected);
    if (pattern) assert.match(status.login_error, pattern);
    else assert.equal(status.login_error, null);
  }
});

test('failed cancellation is retryable and preserves its original deadline', async t => {
  const r = fixtureRunner();
  const stop = r.stopProcess;
  const job = r.start({ prompt: 'hold', cwd, timeout_seconds: 10 });
  t.after(() => { r.stopProcess = stop; return r.close(); });
  r.stopProcess = async () => { throw Error('fixture access denied'); };
  await assert.rejects(r.cancel(job.id), /Could not confirm cancellation/);
  assert.equal(r.get(job.id).state, 'running');
  assert.match(r.get(job.id).error, /access denied/);
  assert.ok(r.jobs.get(job.id).timer && !r.jobs.get(job.id).timer._destroyed);
  r.stopProcess = stop;
  assert.equal((await r.cancel(job.id)).state, 'cancelled');
});

test('close awaits cancellation already in progress and escalates an ignored stop', async () => {
  const r = fixtureRunner();
  const stop = r.stopProcess;
  const attempts = [];
  r.stopWaitMs = 50;
  r.stopProcess = async (pid, force) => {
    attempts.push(force);
    if (force) await stop(pid, true);
  };
  const job = r.start({ prompt: 'hold', cwd });
  const cancelling = r.cancel(job.id);
  await r.close();
  await cancelling;
  assert.equal(r.get(job.id).state, 'cancelled');
  assert.deepEqual(attempts, [false, true]);
});

test('MCP stdin EOF terminates an active fixture and its descendant', { timeout: 15000 }, async t => {
  const server = spawn(process.execPath, [fileURLToPath(new URL('server-fixture.mjs', import.meta.url))], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  const replies = new Map();
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', chunk => {
    output += chunk;
    let end;
    while ((end = output.indexOf('\n')) !== -1) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      const response = JSON.parse(line);
      if (response.id !== undefined) replies.set(response.id, response);
    }
  });
  server.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise(resolve => server.once('close', (code, signal) => resolve({ code, signal })));
  const waitUntil = async predicate => {
    for (let i = 0; i < 150; i++) {
      const result = predicate();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error(`MCP fixture condition timed out: ${errors}`);
  };
  let requestId = 0;
  const request = async (method, params) => {
    const id = ++requestId;
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const reply = await waitUntil(() => replies.get(id));
    assert.equal(reply.error, undefined);
    return reply.result;
  };
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.stdin.end();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 4000))]);
      if (server.exitCode === null && server.signalCode === null) server.kill();
    }
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture-test', version: '1.0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const result = await request('tools/call', { name: 'codex_start', arguments: { prompt: 'hold-tree', cwd } });
  assert.equal(result.isError, undefined);
  const job = JSON.parse(result.content[0].text);
  let pids;
  for (let i = 0; i < 50; i++) {
    const status = await request('tools/call', { name: 'codex_job', arguments: { job_id: job.id } });
    const current = JSON.parse(status.content[0].text);
    if (current.thread_id) { pids = current.thread_id.split(':').map(Number); break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(pids?.length, 2);
  server.stdin.end();
  const exit = await Promise.race([closed, new Promise((resolve, reject) => setTimeout(() => reject(Error('server failed to exit on stdin EOF')), 5000).unref())]);
  assert.equal(exit.code, 0, errors);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('spawn errors fail the job and report bounded diagnostics', async () => {
  const r = new Runner({ discover: () => process.execPath, spawnProcess: () => { throw Error('s'.repeat(70000)); } });
  const job = r.start({ prompt: 'x', cwd });
  assert.equal(job.state, 'failed');
  assert.equal(job.error.length, 64000);
  assert.equal(job.output_truncated, true);
  assert.ok(job.ended_at);
  await r.close();
});


test('Write tasks default to automatic review; read-only retains never approval', async () => {
  const args = buildArgs({ cwd }); assert.ok(args.includes('--approve-for-me')); assert.ok(!args.includes('-a'));
  const readonly = buildArgs({ cwd, sandbox: 'read-only' }); assert.deepEqual(readonly.slice(0, 3), ['-a', 'never', 'exec']); assert.ok(!readonly.includes('--approve-for-me'));
  const dirs = buildArgs({ cwd, additional_write_dirs: [cwd] }); assert.equal(dirs[dirs.indexOf('--add-dir') + 1], cwd);
  const r = fixtureRunner(); const job = await terminal(r, r.start({ prompt: 'write defaults', cwd }).id); assert.equal(job.sandbox, 'workspace-write'); assert.equal(job.approval_policy, 'auto-review');
});
test('Reject incompatible approval mode and invalid extra write roots', () => {
  const r = fixtureRunner(); assert.throws(() => r.start({ prompt: 'x', cwd, sandbox: 'read-only', approval_policy: 'auto-review' }), /requires/);
  assert.throws(() => r.start({ prompt: 'x', cwd, sandbox: 'read-only', additional_write_dirs: [cwd] }), /require/);
  assert.throws(() => r.start({ prompt: 'x', cwd, additional_write_dirs: ['relative'] }), /absolute/);
});
test('Permission problems remain visible even when Codex returns a completed answer', async () => {
  const r = fixtureRunner(); const job = await terminal(r, r.start({ prompt: 'helper_sandbox_lock_failed SetNamedSecurityInfoW access denied', cwd }).id); assert.equal(job.state, 'completed'); assert.ok(job.permission_issues.some(x => x.kind === 'windows-sandbox'));
});
