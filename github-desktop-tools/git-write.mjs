import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repositoryStatus, safeRemote } from './git-status.mjs';

export function redact(text) {
  return String(text).replace(/\b(?:https?|socks5h?|ssh):\/\/[^\s<>"']+/gi, value => {
    try { const u = new URL(value); u.username = ''; u.password = ''; if (u.search) u.search = '?[redacted]'; u.hash = ''; return u.toString(); } catch { return '[redacted URL]'; }
  }).replace(/\b(authorization|proxy-authorization)\s*:[^\r\n]*/gi, '$1: [redacted]').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted token]');
}
export function failureCategory(text, timedOut = false) {
  if (timedOut) return 'timeout';
  if (/proxy|CONNECT tunnel/i.test(text)) return 'proxy';
  if (/authentication|could not read Username|terminal prompts disabled|permission denied.*publickey|invalid username|credential/i.test(text)) return 'authentication';
  if (/non-fast-forward|fetch first|\[rejected\]|protected branch|GH006|GH013/i.test(text)) return 'remote-rejected';
  if (/could not resolve|failed to connect|connection refused|connection timed out|network is unreachable/i.test(text)) return 'network';
  if (/index.lock|another git process|Unable to create.*lock/i.test(text)) return 'git-lock';
  if (/Author identity unknown|unable to auto-detect email/i.test(text)) return 'identity';
  return 'git-error';
}
function environment(proxy) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key) || (proxy !== undefined && /^(https?|all|no)_proxy$/i.test(key))) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_PAGER: 'cat', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10', LC_ALL: 'C' };
}
// Hard limits include the process tree (credential helpers, hooks, ssh) on Windows.
export function runGit(directory, args, { config = [], proxy, signal, timeoutMs = 25000, input } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(Error('Operation cancelled before Git started'), { category: 'cancelled' }));
    const child = spawn(process.env.GITHUB_DESKTOP_GIT_PATH || 'git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'credential.interactive=false', ...config.flatMap(x => ['-c', x]), '-C', directory, ...args], { env: environment(proxy), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', bytes = 0, reason, finished = false, fallback, processExitConfirmed = false;
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
    function finish(code, error) {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(fallback); signal?.removeEventListener('abort', abort);
      if (!error && !reason && code === 0) resolve({ stdout, stderr: redact(stderr) });
      else {
        const detail = redact([stderr, stdout].filter(Boolean).join('\n') || error?.message || 'Git failed').slice(-12000);
        const e = Error(reason ? `Git operation ${reason}. ${detail}` : detail);
        e.category = reason || failureCategory(detail); e.code = code; e.outcomeUnknown = !!reason; e.processExitConfirmed = processExitConfirmed; reject(e);
      }
    }
    function stop(why) {
      if (reason || finished) return; reason = why;
      if (child.pid) {
        if (process.platform === 'win32') { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
      fallback = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null); }, 2000);
    }
    for (const [stream, target] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.setEncoding('utf8').on('data', b => { bytes += Buffer.byteLength(b); if (bytes > 1024 * 1024) return stop('output-limit'); if (target === 'out') stdout += b.toString('utf8'); else stderr += b.toString('utf8'); });
    child.on('error', e => finish(null, e)); child.on('close', code => { processExitConfirmed = true; finish(code); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
function validPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 200) throw Error('Provide 1–200 explicit repository-relative paths, or use mode=staged.');
  return paths.map(p => { if (typeof p !== 'string' || !p || p.length > 1024 || path.isAbsolute(p) || /^[\\/]/.test(p) || /[:\0]/.test(p) || p.split(/[\\/]/).some(x => x === '..' || x.toLowerCase() === '.git')) throw Error('Paths must be literal repository-relative paths without .. or .git.'); return p.replace(/\\/g, '/'); });
}
async function checkRepo(repo, opts, command) {
  const status = await repositoryStatus(repo, { maxFiles: 0, includeRemotes: false, signal: opts.signal });
  if (!['clean', 'dirty'].includes(status.status)) throw Error(`Repository is not ready: ${status.status}. ${status.error || 'Resolve conflicts or missing paths first.'}`);
  if (status.detached || !status.branch) throw Error('A checked-out branch is required.');
  if (status.branch !== opts.expectedBranch || status.head !== opts.expectedHead) throw Error('Branch or HEAD changed. Refresh desktop_repository_status before retrying.');
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const loc = (await command(['rev-parse', '--git-path', name])).stdout.trim();
    if (fs.existsSync(path.resolve(repo.path, loc))) throw Error(`Finish the in-progress Git operation (${name}) first.`);
  }
  return status;
}
async function operation(repo, opts, body) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ((opts.timeoutSeconds || 25) + 20) * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const command = (args, more = {}) => runGit(repo.path, args, { signal, timeoutMs: (opts.timeoutSeconds || 25) * 1000, ...more });
  let lockPath, fd, keepLock = false;
  try {
    // Verify root before creating any file, then re-check under a cross-process lock.
    await checkRepo(repo, { ...opts, signal }, command);
    if (!opts.dryRun) {
      const dir = (await command(['rev-parse', '--absolute-git-dir'])).stdout.trim(); lockPath = path.join(dir, 'workbuddy-desktop-write.lock');
      try { fd = fs.openSync(lockPath, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
      catch (e) { throw Error(e.code === 'EEXIST' ? 'Another MCP write operation holds the repository lock. If a previous server crashed, inspect the lock owner before removing the stale lock.' : e.message); }
    }
    const status = await checkRepo(repo, { ...opts, signal }, command);
    return await body(command, status);
  } catch (e) { keepLock = e.outcomeUnknown && e.processExitConfirmed === false; return { ok: false, repositoryId: repo.id, lockRetained: keepLock && fd !== undefined, error: redact(e.message), category: e.category || 'precondition', outcomeUnknown: !!e.outcomeUnknown, nextStep: 'Inspect local HEAD/status after a commit failure; inspect the remote ref after a push timeout. Do not automatically repeat writes.' }; }
  finally { clearTimeout(timer); if (fd !== undefined) { fs.closeSync(fd); if (!keepLock) fs.unlinkSync(lockPath); } }
}
export async function commitRepository(repo, options) {
  const opts = { dryRun: true, mode: 'staged', ...options };
  return operation(repo, opts, async (command, status) => {
    if (!opts.message?.trim() || opts.message.includes('\0')) throw Error('A non-empty commit message without NUL is required.');
    const paths = opts.mode === 'paths' ? validPaths(opts.paths) : [];
    if (opts.mode === 'staged' && opts.paths?.length) throw Error('paths requires mode=paths.');
    let selected;
    if (paths.length) { await command(['add', '--dry-run', '--', ...paths]); selected = paths; }
    else { selected = (await command(['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean); if (!selected.length) throw Error('No staged changes. Select paths explicitly with mode=paths.'); }
    const preview = { ok: true, dryRun: opts.dryRun, repositoryId: repo.id, branch: status.branch, previousHead: status.head, mode: opts.mode, selectedPaths: selected, message: opts.message };
    if (opts.dryRun) return { ...preview, note: 'Preview only; index and HEAD unchanged. paths mode commits the current contents of selected paths, preserving other staged paths.' };
    if (paths.length) await command(['add', '--', ...paths]);
    // Staging can run clean filters; check HEAD and branch again before commit.
    const headNow = await repositoryStatus(repo, { maxFiles: 0, includeRemotes: false });
    if (headNow.head !== opts.expectedHead || headNow.branch !== opts.expectedBranch) throw Error('HEAD changed during staging; selected paths may remain staged. Inspect status.');
    await command(['commit', '--file=-', ...(paths.length ? ['--only', '--', ...paths] : [])], { input: opts.message });
    const commit = (await command(['rev-parse', 'HEAD'])).stdout.trim();
    return { ...preview, commit, note: 'Committed locally. No push performed.' };
  });
}
export async function pushRepository(repo, options) {
  const opts = { dryRun: true, remote: 'origin', ...options };
  return operation(repo, opts, async (command, status) => {
    if (!status.head) throw Error('There is no commit to push.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.remote)) throw Error('Invalid remote name. Use a configured remote name, not a URL.');
    const branch = opts.branch || status.branch; await command(['check-ref-format', `refs/heads/${branch}`]);
    if (branch !== status.branch) throw Error('Push is limited to the currently checked-out branch of the same name.');
    const urls = (await command(['remote', 'get-url', '--push', '--all', opts.remote])).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1) throw Error('Exactly one configured push URL is required. Multiple destinations must be handled separately.');
    const config = [`remote.${opts.remote}.mirror=false`, 'push.followTags=false', 'push.recurseSubmodules=no', 'http.lowSpeedLimit=1', 'http.lowSpeedTime=15'];
    if (opts.proxy !== undefined) {
      if (opts.proxy !== '') { let u; try { u = new URL(opts.proxy); } catch { throw Error('proxy must be a valid proxy URL, or an empty string for direct access.'); } if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw Error('Use an HTTP/HTTPS/SOCKS proxy URL without credentials or path.'); }
      config.push(`http.proxy=${opts.proxy}`, `https.proxy=${opts.proxy}`, `remote.${opts.remote}.proxy=${opts.proxy}`);
    }
    const refspec = `${status.head}:refs/heads/${branch}`;
    const result = await command(['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', ...(opts.dryRun ? ['--dry-run'] : []), opts.remote, refspec], { config, proxy: opts.proxy });
    return { ok: true, dryRun: opts.dryRun, repositoryId: repo.id, remote: opts.remote, remoteUrl: safeRemote(urls[0]), branch, commit: status.head, proxyMode: opts.proxy === undefined ? 'configured' : opts.proxy === '' ? 'direct' : opts.proxy, output: redact(result.stdout).slice(-12000), warnings: result.stderr.slice(-4000), note: opts.dryRun ? 'Remote preflight succeeded; no remote ref updated. The server can still reject a real push.' : 'Git confirmed push completion. No force, tags, other branches or upstream configuration changes.' };
  });
}
