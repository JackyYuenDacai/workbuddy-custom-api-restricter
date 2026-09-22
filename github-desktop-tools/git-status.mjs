import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
}
export function git(directory, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(process.env.GITHUB_DESKTOP_GIT_PATH || 'git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', directory, ...args],
      { env: gitEnv(), windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 12000, signal }, (error, stdout) => {
        if (error) { const e = Error(error.name === 'AbortError' || error.killed ? 'Git query timed out or was cancelled' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git status exceeds 8 MiB output limit' : error.code === 'ENOENT' ? 'Git executable not found' : 'Git query failed: directory is not readable, not a repository, or requires ownership/trust setup in GitHub Desktop'); e.code = error.code; reject(e); }
        else resolve(stdout);
      });
  });
}
function splitFields(text, count) { const fields = []; let start = 0; for (let i = 0; i < count; i++) { const end = text.indexOf(' ', start); if (end < 0) throw Error('Malformed Git porcelain status'); fields.push(text.slice(start, end)); start = end + 1; } return [...fields, text.slice(start)]; }
export function parseStatus(raw, maxFiles = 100) {
  const out = { branch: null, head: null, detached: false, unborn: false, upstream: null, ahead: null, behind: null, dirty: false, counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, submodules: 0 }, files: [], filesTruncated: false, untrackedMode: 'normal (untracked directories are grouped)' };
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]; if (!line) continue;
    if (line.startsWith('# ')) {
      if (line.startsWith('# branch.head ')) { out.branch = line.slice(14); out.detached = out.branch === '(detached)'; if (out.detached) out.branch = null; }
      else if (line.startsWith('# branch.oid ')) { out.head = line.slice(13); out.unborn = out.head === '(initial)'; if (out.unborn) out.head = null; }
      else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) { const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line); if (!m) throw Error('Malformed branch divergence'); out.ahead = +m[1]; out.behind = +m[2]; }
      continue;
    }
    let file;
    if (line[0] === '?' && line[1] === ' ') { file = { path: line.slice(2), kind: 'untracked', staged: false, unstaged: false, conflict: false }; out.counts.untracked++; }
    else if (['1', '2', 'u'].includes(line[0])) {
      const fields = splitFields(line, line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10);
      const xy = fields[1], sub = fields[2], conflict = line[0] === 'u';
      if (!/^[.MADRCUT?!]{2}$/.test(xy)) throw Error('Invalid Git change status');
      file = { path: fields.at(-1), kind: conflict ? 'conflict' : line[0] === '2' ? 'rename-or-copy' : 'tracked', index: xy[0], workingTree: xy[1], staged: !conflict && xy[0] !== '.', unstaged: !conflict && xy[1] !== '.', conflict, submodule: sub !== 'N...' ? sub : null };
      if (line[0] === '2') { if (!parts[i + 1]) throw Error('Missing rename source'); file.originalPath = parts[++i]; }
      if (file.staged) out.counts.staged++;
      if (file.unstaged) out.counts.unstaged++;
      if (conflict) out.counts.conflicts++;
      if (file.submodule) out.counts.submodules++;
    } else throw Error('Unsupported Git status record');
    out.counts.changed++; out.dirty = true;
    if (out.files.length < maxFiles) out.files.push(file);
  }
  out.filesTruncated = out.counts.changed > out.files.length;
  return out;
}
export function safeRemote(url) {
  // Never return URI credentials, queries, or fragments from repository config.
  try { const u = new URL(url); if (u.protocol === 'file:') return 'file://[local]'; u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { if (/^[^\s/:]+@[^\s/:]+:/.test(url)) return url.replace(/^[^@]+@/, '').split(/[?#]/)[0]; return '[local or nonstandard remote]'; }
}
function canonical(directory) { const value = fs.realpathSync.native(directory).replace(/\\/g, '/').replace(/\/$/, ''); return process.platform === 'win32' ? value.toLowerCase() : value; }
export async function repositoryStatus(repo, { maxFiles = 100, includeRemotes = true, signal } = {}) {
  const started = new Date().toISOString();
  if (!fs.existsSync(repo.path)) return { ...repo, exists: false, status: 'missing', checkedAt: started };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  const cancel = () => controller.abort(); if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', cancel, { once: true });
  try {
    const root = (await git(repo.path, ['rev-parse', '--show-toplevel'], controller.signal)).replace(/\r?\n$/, '');
    if (canonical(root) !== canonical(repo.path)) return { ...repo, status: 'not-repository-root', checkedAt: started, error: 'Desktop path resolves to a parent repository. Re-add the correct repository in GitHub Desktop.' };
    const parsed = parseStatus(await git(repo.path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], controller.signal), maxFiles);
    const result = { ...repo, status: parsed.counts.conflicts ? 'conflict' : parsed.dirty ? 'dirty' : 'clean', checkedAt: started, ...parsed, remoteComparison: 'Local upstream tracking refs only; this tool does not fetch.' };
    if (includeRemotes) {
      try {
        const raw = await git(repo.path, ['config', '--null', '--get-regexp', '^remote\..*\.url$'], controller.signal);
        result.remotes = raw.split('\0').filter(Boolean).map(entry => { const newline = entry.indexOf('\n'); if (newline < 0) throw Error('Invalid remote config'); return { name: entry.slice(7, newline - 4), url: safeRemote(entry.slice(newline + 1)) }; });
      } catch (e) { if (e.code === 1) result.remotes = []; else result.remoteError = e.message; }
    }
    return result;
  } catch (e) { return { ...repo, status: 'error', checkedAt: started, error: e.message }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export async function batchStatuses(repositories, options = {}) {
  const results = new Array(repositories.length); let next = 0;
  async function worker() { while (next < repositories.length) { const i = next++; if (options.signal?.aborted) { results[i] = { ...repositories[i], status: 'error', error: 'Request cancelled' }; continue; } results[i] = await repositoryStatus(repositories[i], { ...options, includeRemotes: false }); } }
  await Promise.all(Array.from({ length: Math.min(4, repositories.length) }, worker)); return results;
}
