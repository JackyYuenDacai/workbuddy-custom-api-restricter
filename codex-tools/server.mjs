import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Runner } from './runner.mjs';

const runner = new Runner();
const server = new McpServer({ name: 'workbuddy-codex-tools', version: '1.0.0' }, {
  instructions: 'Use codex_status to check installation. codex_start returns an id immediately, not a completed result. Pass that id as job_id to codex_job and codex_cancel. Poll codex_job until terminal. Default read-only; choose workspace-write only for user-authorized edits. Jobs belong to this connection. Never automatically repeat a failed or interrupted editing job.'
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
  description: 'Start one Codex task using its existing account and model configuration. May contact a remote model. Returns immediately: poll codex_job for completion. Only one active job per connection. workspace-write permits editing the supplied working directory and must match the user request. No automatic retries, sandbox bypass or interactive approval handling.',
  inputSchema: {
    prompt: z.string().min(1).max(100000).describe('Self-contained task with scope and acceptance criteria; WorkBuddy history is not implicitly shared.'),
    cwd: z.string().min(1).describe('Existing absolute working directory chosen for this task.'),
    sandbox: z.enum(['read-only', 'workspace-write']).default('read-only'),
    model: z.string().min(1).max(200).optional().describe('Omit to use existing Codex default; preserve any model the user explicitly requests.'),
    timeout_seconds: z.number().int().min(10).max(3600).default(900)
  }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, wrap(args => runner.start(args)));
server.registerTool('codex_job', {
  description: 'Read state, last progress event, final answer and errors for a job on this connection. Terminal states: completed, failed, cancelled, timed_out. running/stopping are not completion. Poll at sensible intervals (typically 5-15 seconds); do not start a duplicate task.',
  inputSchema: { job_id: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(({ job_id }) => runner.get(job_id)));
server.registerTool('codex_cancel', {
  description: 'Stop this connection\'s Codex job and its process tree. Does not undo completed edits. Poll codex_job to confirm cancellation and inspect any partial edits before retrying.',
  inputSchema: { job_id: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, wrap(({ job_id }) => runner.cancel(job_id)));
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
