import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConverters } from './converters.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-doc-tools-test-'));
const converter = await createConverters({root,browserPath:process.env.WORKBUDDY_BROWSER_PATH});
await fs.copyFile(path.join(directory,'examples/sample.html'),path.join(root,'sample.html'));
await fs.copyFile(path.join(directory,'examples/sample.md'),path.join(root,'sample.md'));
test('HTML converts to Markdown with headings, Chinese and basic tables', async () => {
  await converter.htmlToMarkdown({input_path:'sample.html',output_path:'sample.md.new.md'});
  const result = await fs.readFile(path.join(root,'sample.md.new.md'),'utf8');
  assert.match(result,/# WorkBuddy 本地文档工具/);
  assert.match(result,/\| 项目 \| 状态 \|/);
  assert.doesNotMatch(result,/<style>|font-family/);
});
test('Markdown writer does not overwrite existing files', async () => {
  await converter.writeMarkdown({output_path:'new.md',content:'# Test'});
  await assert.rejects(converter.writeMarkdown({output_path:'new.md',content:'overwrite'}),/already exists/);
  assert.equal(await fs.readFile(path.join(root,'new.md'),'utf8'),'# Test\n');
});
test('Traversal, hidden paths, non-document extensions and oversized data are rejected', async () => {
  for (const output_path of ['../escape.md','.git/config.md','file.txt','x.md:stream'])
    await assert.rejects(converter.writeMarkdown({output_path,content:'test'}));
  await assert.rejects(converter.htmlToMarkdown({input_path:'../escape.html',output_path:'escape.md'}));
  await assert.rejects(converter.writeMarkdown({output_path:'large.md',content:'x'.repeat(2*1024*1024+1)}));
});
test('Linked output folder cannot escape the document root', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(),'workbuddy-doc-tools-outside-'));
  await fs.symlink(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(converter.writeMarkdown({output_path:'linked/no.md',content:'test'}),/outside/);
});
test('MCP stdio handshake, five tools and a real Markdown write', async () => {
  const transport = new StdioClientTransport({command:process.execPath,args:[path.join(directory,'server.mjs')],
    env:{...process.env,WORKBUDDY_DOCUMENT_ROOT:root},stderr:'pipe'});
  const client = new Client({name:'document-tools-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(),['document_tools_info','html_to_markdown','html_to_pdf','markdown_to_pdf','write_markdown']);
    const result = await client.callTool({name:'write_markdown',arguments:{output_path:'via-mcp.md',content:'# MCP works'}});
    assert.ok(!result.isError);
    assert.equal(await fs.readFile(path.join(root,'via-mcp.md'),'utf8'),'# MCP works\n');
  } finally {await client.close();}
});
test('Both PDF conversions work and external HTML resources are not fetched', {skip:process.env.WORKBUDDY_TEST_PDF!=='1'}, async () => {
  let requests=0;
  const server=http.createServer((_req,res) => {requests++;res.end('blocked test resource');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port;
    await fs.writeFile(path.join(root,'external.html'),`<h1>Offline test</h1><img src="http://127.0.0.1:${port}/image"><script>fetch('http://127.0.0.1:${port}/script')</script>`);
    await converter.htmlToPdf({input_path:'external.html',output_path:'external.pdf'});
    await converter.markdownToPdf({input_path:'sample.md',output_path:'markdown.pdf'});
    for (const name of ['external.pdf','markdown.pdf']) {
      const bytes = await fs.readFile(path.join(root,name));
      assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      assert.ok(bytes.length>1000);
    }
    assert.equal(requests,0);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test.after(() => { console.log('Generated test artifacts:',root); });
