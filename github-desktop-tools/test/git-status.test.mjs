import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { repositoryStatus, parseStatus, safeRemote, batchStatuses } from '../git-status.mjs';
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-git-test-')); t.after(() => { if (!path.basename(dir).startsWith('desktop-git-test-') || path.resolve(path.dirname(dir)) !== path.resolve(os.tmpdir())) throw Error('Unsafe cleanup path'); fs.rmSync(dir, { recursive: true, force: true }); }); const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); run('init', '-b', 'main'); run('config', 'user.name', 'Fixture'); run('config', 'user.email', 'fixture@example.invalid'); run('config', 'commit.gpgsign', 'false'); run('config', 'core.hooksPath', path.join(dir, 'no-hooks')); return { dir, run, repo: { id: '1', name: 'fixture', path: dir } }; }
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
test('Unborn, clean, rename, Unicode, detached HEAD and read-only index', async t => {
  const { dir, run, repo } = fixture(t); assert.equal((await repositoryStatus(repo)).unborn, true);
  write(dir, 'old file.txt', 'one\n'); run('add', '.'); run('commit', '-m', 'initial');
  assert.equal((await repositoryStatus(repo)).status, 'clean'); run('mv', 'old file.txt', '中文 new.txt'); write(dir, 'untracked.txt', 'new');
  const index = path.join(dir, '.git', 'index'), digest = () => createHash('sha256').update(fs.readFileSync(index)).digest('hex'); const before = digest();
  const result = await repositoryStatus(repo); assert.equal(result.status, 'dirty'); assert.equal(result.counts.staged, 1); assert.equal(result.counts.untracked, 1); assert.equal(result.files.find(x => x.originalPath)?.path, '中文 new.txt'); assert.equal(digest(), before);
  const brief = await repositoryStatus(repo, { maxFiles: 0 }); assert.equal(brief.files.length, 0); assert.equal(brief.filesTruncated, true); assert.equal(brief.counts.changed, 2);
  run('checkout', '--detach'); assert.equal((await repositoryStatus(repo)).detached, true);
});
test('Missing paths and child directories cannot masquerade as clean repos', async t => {
  const { dir, repo } = fixture(t); const child = path.join(dir, 'child'); fs.mkdirSync(child);
  assert.equal((await repositoryStatus({ ...repo, path: child })).status, 'not-repository-root');
  assert.equal((await repositoryStatus({ ...repo, path: path.join(dir, 'missing') })).status, 'missing');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-plain-')); try { assert.equal((await repositoryStatus({ ...repo, path: plain })).status, 'error'); } finally { fs.rmdirSync(plain); }
});
test('Merge conflicts and local tracking divergence remain distinct', async t => {
  const { dir, run, repo } = fixture(t); write(dir, 'a.txt', 'base\n'); run('add', '.'); run('commit', '-m', 'base'); run('branch', 'peer');
  write(dir, 'a.txt', 'main\n'); run('commit', '-am', 'main'); run('checkout', 'peer'); write(dir, 'a.txt', 'peer\n'); run('commit', '-am', 'peer'); run('checkout', 'main'); run('branch', '--set-upstream-to=peer');
  const divergent = await repositoryStatus(repo); assert.equal(divergent.ahead, 1); assert.equal(divergent.behind, 1);
  try { run('merge', 'peer'); } catch {} const conflict = await repositoryStatus(repo); assert.equal(conflict.status, 'conflict'); assert.equal(conflict.counts.conflicts, 1);
});
test('Remote URLs omit credentials and query tokens', async t => {
  assert.equal(safeRemote('https://user:secret@example.com/org/repo?token=secret#fragment'), 'https://example.com/org/repo'); assert.equal(safeRemote('git@example.com:org/repo.git'), 'example.com:org/repo.git');
  const { run, repo } = fixture(t); run('remote', 'add', 'origin', 'https://user:secret@example.com/org/repo?token=secret'); const r = await repositoryStatus(repo); assert.deepEqual(r.remotes, [{ name: 'origin', url: 'https://example.com/org/repo' }]); assert.ok(!JSON.stringify(r).includes('secret'));
});
test('Porcelain paths with newlines and spaces stay intact; malformed output fails', () => {
  const r = parseStatus('? line\nbreak file\0'); assert.equal(r.files[0].path, 'line\nbreak file'); assert.throws(() => parseStatus('2 bad\0'), /Malformed/);
});
test('Batch reports each result and honours cancellation', async t => {
  const { repo } = fixture(t); const result = await batchStatuses([repo, { ...repo, id: '2', path: path.join(repo.path, 'missing') }]); assert.equal(result[0].status, 'clean'); assert.equal(result[1].status, 'missing'); const c = new AbortController(); c.abort(); assert.equal((await batchStatuses([repo], { signal: c.signal }))[0].status, 'error');
});
