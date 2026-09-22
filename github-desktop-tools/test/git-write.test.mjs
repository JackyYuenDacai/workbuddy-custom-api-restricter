import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryStatus } from '../git-status.mjs';
import { commitRepository, pushRepository, runGit, redact, failureCategory } from '../git-write.mjs';
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-write-test-')), dir = path.join(parent, 'repo'), remote = path.join(parent, 'remote.git'); fs.mkdirSync(dir);
  t.after(() => { if (path.resolve(path.dirname(parent)) !== path.resolve(os.tmpdir()) || !path.basename(parent).startsWith('desktop-write-test-')) throw Error('Invalid test cleanup'); fs.rmSync(parent, { recursive: true, force: true }); });
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  run('init', '-b', 'main'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid'); run('config', 'commit.gpgsign', 'false'); run('config', 'core.hooksPath', path.join(parent, 'no-hooks'));
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore', windowsHide: true }); run('remote', 'add', 'origin', remote);
  const repo = { id: 'test', path: dir }, write = (file, content) => fs.writeFileSync(path.join(dir, file), content);
  const state = async () => { const s = await repositoryStatus(repo); return { expectedBranch: s.branch, expectedHead: s.head }; };
  return { parent, dir, remote, run, repo, write, state };
}
test('Commit preview does not stage; explicit paths preserve unrelated staged changes', async t => {
  const x = fixture(t); x.write('first.txt', 'initial'); x.run('add', '.'); x.run('commit', '-m', 'initial');
  x.write('other.txt', 'other'); x.run('add', 'other.txt'); x.write('中文 selected.txt', 'selected'); const initial = await x.state();
  const options = { ...initial, message: 'selected commit', mode: 'paths', paths: ['中文 selected.txt'] };
  assert.equal((await commitRepository(x.repo, options)).ok, true); assert.equal(x.run('diff', '--cached', '--name-only').trim(), 'other.txt');
  const r = await commitRepository(x.repo, { ...options, dryRun: false }); assert.equal(r.ok, true, r.error); assert.notEqual(r.commit, initial.expectedHead);
  assert.equal(x.run('-c', 'core.quotepath=false', 'show', '--pretty=format:', '--name-only', 'HEAD').trim(), '中文 selected.txt'); assert.equal(x.run('diff', '--cached', '--name-only').trim(), 'other.txt');
  assert.equal((await commitRepository(x.repo, { ...options, dryRun: false })).ok, false);
});
test('Staged mode preserves partial staging and supports the first commit', async t => {
  const x = fixture(t); x.write('a.txt', 'staged'); x.run('add', '.'); x.write('a.txt', 'unstaged');
  const r = await commitRepository(x.repo, { ...await x.state(), message: 'first', dryRun: false }); assert.equal(r.ok, true, r.error); assert.equal(x.run('show', 'HEAD:a.txt'), 'staged'); assert.equal(fs.readFileSync(path.join(x.dir, 'a.txt'), 'utf8'), 'unstaged');
});
test('Commit rejects escaping paths, conflicts, in-progress operations and foreign locks', async t => {
  const x = fixture(t); x.write('a', 'a'); const opts = { ...await x.state(), message: 'first', mode: 'paths', dryRun: false };
  for (const selected of ['../a', '.git/config', ':(glob)**', 'C:/escape']) assert.equal((await commitRepository(x.repo, { ...opts, paths: [selected] })).ok, false);
  const lock = path.join(x.dir, '.git', 'workbuddy-desktop-write.lock'); fs.writeFileSync(lock, 'other'); assert.match((await commitRepository(x.repo, { ...opts, paths: ['a'] })).error, /lock/); assert.equal(fs.readFileSync(lock, 'utf8'), 'other'); fs.unlinkSync(lock);
  fs.writeFileSync(path.join(x.dir, '.git', 'MERGE_HEAD'), 'x'); assert.match((await commitRepository(x.repo, { ...opts, paths: ['a'] })).error, /in-progress|conflict/);
});
test('Push dry-run leaves remote untouched; execution pushes only branch even under mirror/tag configuration', async t => {
  const x = fixture(t); x.write('a', 'a'); x.run('add', '.'); x.run('commit', '-m', 'first'); x.run('tag', '-a', 'private-tag', '-m', 'tag'); x.run('branch', 'other'); x.run('config', 'remote.origin.mirror', 'true'); x.run('config', 'push.followTags', 'true');
  const opts = { ...await x.state() }; const preview = await pushRepository(x.repo, opts); assert.equal(preview.ok, true, preview.error); assert.equal(x.run('ls-remote', 'origin').trim(), '');
  const r = await pushRepository(x.repo, { ...opts, dryRun: false }); assert.equal(r.ok, true, r.error); const refs = x.run('ls-remote', 'origin'); assert.match(refs, /refs\/heads\/main/); assert.ok(!refs.includes('private-tag')); assert.ok(!refs.includes('refs/heads/other')); assert.equal(x.run('config', '--get', 'remote.origin.mirror').trim(), 'true');
});
test('Remote non-fast-forward is reported without force or automatic retry', async t => {
  const x = fixture(t); x.write('a', '1'); x.run('add', '.'); x.run('commit', '-m', 'first'); const first = x.run('rev-parse', 'HEAD').trim(); x.write('a', '2'); x.run('commit', '-am', 'second'); const second = x.run('rev-parse', 'HEAD').trim(); x.run('push', 'origin', 'main'); x.run('reset', '--hard', first); x.write('a', 'diverged'); x.run('commit', '-am', 'diverged');
  const r = await pushRepository(x.repo, { ...await x.state(), dryRun: false }); assert.equal(r.ok, false); assert.equal(r.category, 'remote-rejected'); assert.match(x.run('ls-remote', 'origin'), new RegExp(second));
});
test('Dead per-call proxy returns promptly without modifying repository proxy config', async t => {
  const x = fixture(t); x.write('a', 'a'); x.run('add', '.'); x.run('commit', '-m', 'first'); x.run('remote', 'set-url', 'origin', 'https://github.com/example/nonexistent-test-repository'); x.run('config', 'http.proxy', 'http://127.0.0.1:9');
  const started = Date.now(); const r = await pushRepository(x.repo, { ...await x.state(), proxy: 'http://127.0.0.1:1', timeoutSeconds: 5 }); assert.equal(r.ok, false); assert.ok(['proxy', 'network'].includes(r.category), JSON.stringify(r)); assert.ok(Date.now() - started < 12000); assert.equal(x.run('config', '--get', 'http.proxy').trim(), 'http://127.0.0.1:9');
});
test('Command deadline terminates hung command and marks uncertain outcome', async t => {
  const x = fixture(t); const start = Date.now(); await assert.rejects(runGit(x.dir, ['-c', 'alias.wait-test=!sleep 30', 'wait-test'], { timeoutMs: 300 }), e => e.category === 'timeout' && e.outcomeUnknown); assert.ok(Date.now() - start < 5000);
});
test('Failure messages redact credentials, tokens and proxy authorization', () => {
  const out = redact('https://u:password@example.com/repo?token=secret\nAuthorization: Basic secret\nghp_123456abcdef'); assert.ok(!out.includes('password')); assert.ok(!out.includes('secret')); assert.ok(!out.includes('123456abcdef')); assert.equal(failureCategory('CONNECT tunnel failed'), 'proxy');
});
