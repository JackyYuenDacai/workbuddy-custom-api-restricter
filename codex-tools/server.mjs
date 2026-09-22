import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Runner } from './runner.mjs';

const runner = new Runner();
const server = new McpServer({ name: 'workbuddy-codex-tools', version: '1.1.0' }, {
  instructions: 'Use codex_status to check installation. codex_start returns an id immediately, not a completed result. Pass that id as job_id to codex_job and codex_cancel. Poll codex_job until terminal. Default workspace-write with automatic approval review for authorized tasks; explicitly choose read-only for analysis-only tasks. Jobs belong to this connection. Never automatically repeat a failed or interrupted editing job.'
});
const wrap = fn => async args => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};
server.registerTool('codex_status', {
  description: 'Inspect the local Codex executable, version and existing login status. Does not make a model request or read/expose credentials.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(() => runner.status()));
server.registerTool('codex_start', {
  description: 'Start one Codex task using its existing account and model configuration. May contact a remote model. Returns immediately: poll codex_job for completion. Only one active job per connection. workspace-write permits editing the supplied working directory and must match the user request. Uses automatic approval review for workspace-write; blocked operations are reviewed, not blanket-approved. No automatic job retries or sandbox bypass. Use additional_write_dirs for explicitly authorized paths outside cwd.',
  inputSchema: {
    prompt: z.string().min(1).max(100000).describe('Self-contained task with scope and acceptance criteria; WorkBuddy history is not implicitly shared.'),
    cwd: z.string().min(1).describe('Existing absolute working directory chosen for this task.'),
    sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write').describe('Use workspace-write for user-authorized edits; explicitly select read-only for analysis.'),
    approval_policy: z.enum(['auto-review', 'ask-user', 'never']).optional().describe('Defaults to auto-review for workspace-write, never for read-only. Auto-review uses Codex --approve-for-me. ask-user uses a live app-server bridge: inspect pending_approvals and ask the user, then reply using codex_approval_reply.'),
    additional_write_dirs: z.array(z.string().min(1)).max(16).default([]).describe('Existing absolute directories outside cwd that the user authorized this task to edit; no whole-drive roots.'),
    model: z.string().min(1).max(200).optional().describe('Omit to use existing Codex default; preserve any model the user explicitly requests.'),
    timeout_seconds: z.number().int().min(10).max(3600).default(900)
  }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, wrap(args => runner.start(args)));
server.registerTool('codex_job', {
  description: 'Read state, last progress event, final answer and errors for a job on this connection. Terminal states: completed, failed, cancelled, timed_out. running/stopping are not completion. If phase=awaiting_user, display pending_approvals and ask the user instead of continuing to poll. Do not auto-approve requests. Poll at sensible intervals (typically 5-15 seconds); do not start a duplicate task.',
  inputSchema: { job_id: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(({ job_id }) => runner.get(job_id)));
server.registerTool('codex_cancel', {
  description: 'Stop this connection\'s Codex job and its process tree. Does not undo completed edits. Poll codex_job to confirm cancellation and inspect any partial edits before retrying.',
  inputSchema: { job_id: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, wrap(({ job_id }) => runner.cancel(job_id)));

server.registerTool('codex_request_approval', {
  description: 'Continue a stopped Codex job in the same saved thread with human approval support after automatic execution was blocked. Inspect its partial changes first. Does not grant permission: the continued turn can emit pending_approvals for WorkBuddy to show the user. Original cwd, sandbox, model and task context are retained. Never use this to evade a user denial or a managed policy restriction.',
  inputSchema: { job_id: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, wrap(({ job_id }) => runner.requestApproval(job_id)));
server.registerTool('codex_approval_reply', {
  description: 'Relay an actual user response to one pending Codex approval. First show the exact command/file diff/permissions/reason from codex_job pending_approvals in WorkBuddy. Call only after the user answers; quote their response in user_response. approve grants only this request (permission grants last this turn), never persistent/session-wide approval. deny refuses; cancel ends approval. Do not manufacture consent or treat silence as approval.',
  inputSchema: { job_id: z.string().uuid(), approval_id: z.string().uuid(), decision: z.enum(['approve', 'deny', 'cancel']), user_response: z.string().min(1).max(8000), answers: z.record(z.string(), z.array(z.string())).optional().describe('Only for requestUserInput: question IDs mapped to the user actual answers.') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, wrap(({ job_id, approval_id, decision, user_response, answers }) => runner.replyApproval(job_id, approval_id, decision, user_response, answers)));

const transport = new StdioServerTransport();
let shuttingDown;
const shutdown = () => {
  if (!shuttingDown) {
    shuttingDown = (async () => {
      await runner.close();
      await server.close();
    })().catch(error => {
      console.error(`Codex shutdown failed: ${error.message}`);
      process.exitCode = 1;
      shuttingDown = undefined;
    });
  }
  return shuttingDown;
};
server.server.onclose = shutdown;
process.stdin.once('end', shutdown);
process.stdin.once('close', shutdown);
process.stdin.once('error', shutdown);
process.stdout.once('error', shutdown);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
await server.connect(transport);
