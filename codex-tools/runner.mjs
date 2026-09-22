import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CAP = 64000;
const tail = value => String(value).slice(-CAP);
const boundedValue = (job, value) => {
  const text = String(value);
  if (text.length > CAP) job.output_truncated = true;
  return tail(text);
};

export function findCodex(env = process.env) {
  if (env.WORKBUDDY_CODEX_PATH) {
    const p = env.WORKBUDDY_CODEX_PATH;
    if (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw Error('WORKBUDDY_CODEX_PATH must name an existing absolute executable.');
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(p)) throw Error('WORKBUDDY_CODEX_PATH must point to the real Codex executable (codex.exe), not a .cmd/.bat wrapper.');
    return p;
  }
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    const p = path.join(dir, name);
    if (path.isAbsolute(p) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  const base = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(base)) {
    const candidates = fs.readdirSync(base).map(d => path.join(base, d, name)).filter(p => fs.existsSync(p) && fs.statSync(p).isFile());
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  throw Error('Codex executable not found. Install Codex or set WORKBUDDY_CODEX_PATH; run codex login separately if needed.');
}

export function buildArgs({ cwd, sandbox = 'read-only', model }) {
  const args = ['-a', 'never', 'exec', '--json', '--color', 'never', '--sandbox', sandbox, '--cd', cwd, '--skip-git-repo-check'];
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

async function stopTree(pid, force) {
  if (process.platform === 'win32') {
    await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  } else process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
}

async function waitForExit(job, milliseconds) {
  if (job.ended_at) return true;
  let timer;
  try {
    return await Promise.race([job.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

export class Runner {
  constructor({ discover = findCodex, spawnProcess = spawn, execProcess = exec, stopProcess = stopTree, stopWaitMs = 2000, maxJobs = 50 } = {}) {
    this.discover = discover;
    this.spawnProcess = spawnProcess;
    this.execProcess = execProcess;
    this.stopProcess = stopProcess;
    this.stopWaitMs = stopWaitMs;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
  }

  async status() {
    const executable = this.discover();
    const options = { windowsHide: true, timeout: 15000, maxBuffer: 65536 };
    const version = await this.execProcess(executable, ['--version'], options);
    let loggedIn = null;
    let loginError = null;
    try { await this.execProcess(executable, ['login', 'status'], options); loggedIn = true; }
    catch (error) {
      const diagnostic = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
      if (error.code === 1 && !error.killed && /^not logged in[.!]?$/im.test(diagnostic)) loggedIn = false;
      else loginError = tail(diagnostic || error.message);
    }
    return { executable, version: version.stdout.trim(), logged_in: loggedIn, login_error: loginError,
      backend: 'codex exec', active_jobs: [...this.jobs.values()].filter(j => j.state === 'running' || j.state === 'stopping').length,
      note: 'Uses your existing Codex account/model configuration; inference may use a remote service. Login status is not a network test. null means the login check failed, not that you are logged out.' };
  }

  armDeadline(job) {
    clearTimeout(job.timer);
    const remaining = job.deadline - Date.now();
    if (remaining <= 0 || job.ended_at) return;
    job.timer = setTimeout(() => {
      this.cancel(job.id, 'timed_out').catch(error => {
        job.error = boundedValue(job, `Deadline elapsed; the process may still be running. Retry codex_cancel. ${error.message}`);
      });
    }, remaining);
    job.timer.unref();
  }

  start({ prompt, cwd, sandbox = 'read-only', model, timeout_seconds = 900 }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw Error('prompt must contain 1-100000 characters.');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw Error('cwd must be an existing absolute directory.');
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw Error('Only read-only and workspace-write sandboxes are supported.');
    if (!Number.isInteger(timeout_seconds) || timeout_seconds < 10 || timeout_seconds > 3600) throw Error('timeout_seconds must be 10-3600.');
    if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) throw Error('Invalid model.');
    if ([...this.jobs.values()].some(j => ['running', 'stopping'].includes(j.state))) throw Error('A Codex job is already active. Poll or cancel it before starting another.');
    while (this.jobs.size >= this.maxJobs) this.jobs.delete(this.jobs.keys().next().value);
    const executable = this.discover();
    const job = { id: randomUUID(), state: 'running', cwd: fs.realpathSync(cwd), sandbox,
      started_at: new Date().toISOString(), ended_at: null, thread_id: null, exit_code: null,
      answer: '', progress: '', stderr: '', error: null, events_seen: 0, output_truncated: false, turn_completed: false,
      deadline: Date.now() + timeout_seconds * 1000 };
    job.closed = new Promise(resolve => { job.resolveClosed = resolve; });
    this.jobs.set(job.id, job);
    let lineBuffer = '';
    let discardLongLine = false;
    let lastEventError = null;
    const bounded = value => boundedValue(job, value);
    const parseLine = line => {
      if (!line.trim()) return;
      job.events_seen++;
      let event;
      try { event = JSON.parse(line); } catch { job.progress = bounded(line); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { job.progress = bounded(line); return; }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') job.thread_id = event.thread_id;
      if (event.type === 'turn.started') job.turn_completed = false;
      // A completed turn proves recovery from earlier transient Codex errors, not local process errors.
      if (event.type === 'turn.completed') {
        job.turn_completed = true;
        if (job.error === lastEventError) job.error = null;
        lastEventError = null;
      }
      if (event.type === 'turn.failed' || event.type === 'error') {
        if (event.type === 'turn.failed') job.turn_completed = false;
        job.error = lastEventError = bounded(event.error?.message || event.message || 'Codex turn failed.');
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (typeof event.item.text === 'string') job.answer = bounded(event.item.text);
        else job.error = 'Codex returned an agent message without text.';
      }
      job.progress = bounded(JSON.stringify(event));
    };
    const finish = code => {
      if (job.ended_at) return;
      clearTimeout(job.timer);
      job.exit_code = code;
      job.state = job.stopReason || (code === 0 && job.turn_completed && !job.error ? 'completed' : 'failed');
      job.ended_at = new Date().toISOString();
      if (job.state === 'failed' && !job.error) {
        job.error = code === 0 && !job.turn_completed ? 'Codex exited without a turn.completed event; completion is unconfirmed.' : tail(job.stderr) || `Codex exited with code ${code}.`;
      }
      delete job.child;
      job.resolveClosed();
    };
    try {
      const child = this.spawnProcess(executable, buildArgs({ ...job, model }), {
        cwd: job.cwd, env: process.env, windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'
      });
      job.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) || []) {
          const ends = part.endsWith('\n');
          if (!discardLongLine) lineBuffer += part;
          if (lineBuffer.length > 2 * 1024 * 1024) { lineBuffer = ''; discardLongLine = true; job.output_truncated = true; }
          if (ends) { if (!discardLongLine) parseLine(lineBuffer); lineBuffer = ''; discardLongLine = false; }
        }
      });
      child.stderr.on('data', chunk => { job.stderr = bounded(job.stderr + chunk); });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') job.error = boundedValue(job, error.message); });
      child.on('error', error => { job.error = boundedValue(job, error.message); finish(null); });
      child.on('close', code => { if (lineBuffer && !discardLongLine) parseLine(lineBuffer); finish(code); });
      this.armDeadline(job);
      child.stdin.end(prompt);
    } catch (error) {
      job.error = boundedValue(job, error.message);
      finish(null);
    }
    return this.get(job.id);
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw Error('Unknown job_id. IDs belong to this MCP connection; restarting the server clears its jobs.');
    const { child, timer, stopReason, closed, resolveClosed, stopPromise, deadline, ...publicJob } = job;
    return { ...publicJob };
  }

  async cancel(id, reason = 'cancelled') {
    const job = this.jobs.get(id);
    if (!job) throw Error('Unknown job_id.');
    if (job.stopPromise) return job.stopPromise;
    if (job.state !== 'running') return this.get(id);
    job.state = 'stopping';
    job.stopReason = reason;
    clearTimeout(job.timer);
    job.stopPromise = (async () => {
      const pid = job.child?.pid;
      try {
        if (pid) await this.stopProcess(pid, false);
        if (!await waitForExit(job, this.stopWaitMs)) {
          if (pid) await this.stopProcess(pid, true);
          if (!await waitForExit(job, this.stopWaitMs)) throw Error('The process has not exited after termination.');
        }
      } catch (error) {
        if (!job.ended_at) {
          job.state = 'running';
          delete job.stopReason;
          job.error = boundedValue(job, `Could not confirm cancellation of PID ${pid ?? 'unknown'}: ${error.message}`);
          // A failed manual cancellation must not silently disable its original deadline.
          this.armDeadline(job);
          throw Error(job.error);
        }
      }
      return this.get(id);
    })();
    try { return await job.stopPromise; }
    finally { delete job.stopPromise; }
  }

  async close() {
    await Promise.all([...this.jobs.values()].filter(j => ['running', 'stopping'].includes(j.state)).map(j => this.cancel(j.id)));
  }
}
