import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const client = new Client({ name: 'workbuddy-codex-probe', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('server.mjs', import.meta.url))], stderr: 'pipe', env: process.env });
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
const parse = result => { if (result.isError) throw Error(result.content?.[0]?.text); return JSON.parse(result.content[0].text); };
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['codex_status', 'codex_start', 'codex_job', 'codex_cancel']) {
    if (!names.includes(name)) throw Error(`Missing MCP tool: ${name}`);
  }
  console.log(JSON.stringify({ tools: names }));
  const status = parse(await client.callTool({ name: 'codex_status', arguments: {} }));
  console.log(JSON.stringify(status));
  if (status.logged_in !== true) throw Error('Codex is not ready: login status could not be confirmed.');
  if (process.argv.includes('--live')) {
    const cwd = fileURLToPath(new URL('.', import.meta.url));
    let job = parse(await client.callTool({ name: 'codex_start', arguments: { cwd, sandbox: 'read-only', timeout_seconds: 180, prompt: 'This is a connection test. Do not use any tools or inspect/change files. Reply with exactly CODEX_MCP_OK.' } }));
    console.log(JSON.stringify({ started_job: job.id }));
    const pollDeadline = Date.now() + 210000;
    while (['running', 'stopping'].includes(job.state)) {
      if (Date.now() >= pollDeadline) throw Error(`Probe polling deadline exceeded for ${job.id}; task state is unknown.`);
      await new Promise(r => setTimeout(r, 2000));
      job = parse(await client.callTool({ name: 'codex_job', arguments: { job_id: job.id } }));
    }
    console.log(JSON.stringify(job, null, 2));
    if (job.state !== 'completed' || job.answer.trim() !== 'CODEX_MCP_OK') process.exitCode = 1;
  }
} finally { await client.close(); }
