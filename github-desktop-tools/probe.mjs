import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const client = new Client({ name: 'desktop-repos-probe', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', b => { stderr += b.toString(); });
async function call(name, args) { const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 }); if (result.isError) throw Error(result.content.map(x => x.text || '').join('\n')); return result.structuredContent || JSON.parse(result.content[0].text); }
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 3); assert.ok(tools.every(t => t.annotations.readOnlyHint));
  const list = await call('desktop_repositories', {}); assert.equal(list.totalRegistered, list.repositories.length);
  const ids = new Set(list.repositories.map(r => r.id)), statuses = []; let offset = 0;
  do { const page = await call('desktop_repository_statuses', { offset, limit: 8, maxFiles: 0 }); assert.equal(page.totalRegistered, list.totalRegistered, 'Registry changed during probe; rerun'); statuses.push(...page.repositories); offset = page.nextOffset; } while (offset !== null);
  assert.equal(statuses.length, ids.size); assert.equal(new Set(statuses.map(r => r.id)).size, ids.size); assert.ok(statuses.every(r => ids.has(r.id)));
  if (list.repositories.length) { const one = await call('desktop_repository_status', { repositoryId: list.repositories[0].id, maxFiles: 5 }); assert.equal(one.id, list.repositories[0].id); }
  const invalid = await client.callTool({ name: 'desktop_repository_status', arguments: { repositoryId: '999999999' } }); assert.equal(invalid.isError, true);
  const summary = {}; for (const r of statuses) summary[r.status] = (summary[r.status] || 0) + 1;
  console.log(JSON.stringify({ success: true, total: list.totalRegistered, summary, repositories: statuses.map(({ id, name, status, branch, ahead, behind, counts, error }) => ({ id, name, status, branch, ahead, behind, counts, error })) }, null, 2));
} finally { await client.close(); if (stderr.trim()) console.error(stderr); }
