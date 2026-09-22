import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Runner } from './runner.mjs';
import { approvalResponse } from './approval-bridge.mjs';
const cwd = fileURLToPath(new URL('.', import.meta.url));
function runner() { return new Runner({ discover: () => process.execPath, spawnProcess: (exe, args, opts) => spawn(exe, [fileURLToPath(new URL('approval-fixture.mjs', import.meta.url))], opts) }); }
async function until(r, id, condition) { for (let i = 0; i < 200; i++) { const job = r.get(id); if (condition(job)) return job; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Fixture timeout'); }
test('Human approval waits, exposes exact request, forwards one user answer, rejects replay', async () => {
  const r = runner(); try {
    const start = r.start({ cwd, prompt: 'command', approval_policy: 'ask-user' }); const pending = await until(r, start.id, j => j.phase === 'awaiting_user');
    assert.equal(pending.state, 'running'); assert.equal(pending.answer, ''); assert.equal(pending.pending_approvals.length, 1); assert.equal(pending.pending_approvals[0].details.command, 'write one authorized file'); assert.ok(pending.pending_approvals[0].item);
    assert.throws(() => r.start({ cwd, prompt: 'duplicate' }), /active/);
    const id = pending.pending_approvals[0].approval_id; assert.throws(() => r.replyApproval(start.id, id, 'approve', ''), /actual user/);
    r.replyApproval(start.id, id, 'approve', 'Approve this one operation'); assert.throws(() => r.replyApproval(start.id, id, 'approve', 'Again'), /stale|answered/);
    const done = await until(r, start.id, j => j.ended_at); assert.equal(done.state, 'completed'); assert.deepEqual(JSON.parse(done.answer), { decision: 'accept' }); assert.equal(done.approval_history[0].decision, 'approve');
  } finally { await r.close(); }
});
test('Deny and cancel are explicit responses, never grants', async () => {
  for (const decision of ['deny', 'cancel']) { const r = runner(); try { const j = r.start({ cwd, prompt: 'fileChange', approval_policy: 'ask-user' }); const p = await until(r, j.id, x => x.pending_approvals.length); r.replyApproval(j.id, p.pending_approvals[0].approval_id, decision, 'User says no'); const done = await until(r, j.id, x => x.ended_at); assert.deepEqual(JSON.parse(done.answer), { decision: decision === 'deny' ? 'decline' : 'cancel' }); } finally { await r.close(); } }
});
test('Permissions are limited to requested subset and current turn', () => {
  const request = { method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { write: ['C:/scope'] } } } };
  assert.deepEqual(approvalResponse(request, 'approve'), { permissions: request.params.permissions, scope: 'turn' }); assert.deepEqual(approvalResponse(request, 'deny'), { permissions: {}, scope: 'turn' });
  assert.throws(() => approvalResponse({ method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['decline', 'cancel'] } }, 'approve'), /unavailable/);
});
test('User questions require answers and translate without inventing one', async () => {
  const r = runner(); try { const j = r.start({ cwd, prompt: 'question', approval_policy: 'ask-user' }); const p = await until(r, j.id, x => x.pending_approvals.length); const id = p.pending_approvals[0].approval_id; assert.throws(() => r.replyApproval(j.id, id, 'approve', 'yes'), /each/); r.replyApproval(j.id, id, 'approve', 'Only that file', { q1: ['Only that file'] }); const done = await until(r, j.id, x => x.ended_at); assert.deepEqual(JSON.parse(done.answer), { answers: { q1: { answers: ['Only that file'] } } }); } finally { await r.close(); }
});
test('Closing while awaiting user terminates the bridge and clears pending approvals', async () => {
  const r = runner(); const j = r.start({ cwd, prompt: 'command', approval_policy: 'ask-user' }); await until(r, j.id, x => x.phase === 'awaiting_user'); await r.close(); const done = r.get(j.id); assert.equal(done.state, 'cancelled'); assert.deepEqual(done.pending_approvals, []);
});
test('Human-review continuation resumes the original thread and preserves scope', async () => {
  const r = runner(); try { r.jobs.set('previous', { id: 'previous', state: 'failed', thread_id: 'original-thread', cwd, sandbox: 'workspace-write', model: 'preserve-user-model', additional_write_dirs: [] }); const j = r.requestApproval('previous'); const p = await until(r, j.id, x => x.phase === 'awaiting_user'); assert.equal(p.thread_id, 'original-thread'); assert.equal(p.model, 'preserve-user-model'); assert.equal(p.cwd.toLowerCase(), cwd.replace(/[\\/]$/, '').toLowerCase()); } finally { await r.close(); }
});
