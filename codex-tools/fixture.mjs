import { spawn } from 'node:child_process';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt === 'hold' || prompt === 'hold-tree') {
  const descendant = prompt === 'hold-tree' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }) : null;
  console.log(JSON.stringify({ type: 'thread.started', thread_id: descendant ? `${process.pid}:${descendant.pid}` : 'fixture-thread' }));
  setInterval(() => {}, 1000);
} else if (prompt === 'fail') {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'fixture failure' } }));
} else if (prompt === 'empty') {
  // Successful exit alone is not evidence that a Codex turn completed.
} else if (prompt === 'partial') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial answer' } }));
} else if (prompt === 'malformed') {
  console.log('null');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: { invalid: true } } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
} else if (prompt === 'progress') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'p'.repeat(70000) } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
} else if (prompt === 'long-line') {
  console.log('x'.repeat(2 * 1024 * 1024 + 1));
  console.log(JSON.stringify({ type: 'turn.completed' }));
} else if (prompt === 'long-error') {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'e'.repeat(70000) } }));
} else if (prompt === 'nonzero') {
  console.log(JSON.stringify({ type: 'turn.completed' }));
  process.exitCode = 1;
} else {
  if (prompt === 'recover') console.log(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: prompt } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
