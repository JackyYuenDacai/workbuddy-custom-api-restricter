import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const paths=require('../paths.cjs');
const policy=require('../policy.cjs')();
const local=JSON.parse(await fs.readFile(path.join(directory,'local-install.json'),'utf8'));
const config={type:'stdio',command:paths.nodePath,args:[path.join(directory,'server.mjs')],
  env:{WORKBUDDY_DOCUMENT_ROOT:local.documentRoot,WORKBUDDY_BROWSER_PATH:local.browserPath}};
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
if(process.argv[2]==='workbuddy'){
  const outputName=`workbuddy-proof-${stamp}.md`;
  const toolName='mcp__local-document-tools__write_markdown';
  const args=[path.join(paths.resourcesDir,'app.asar.unpacked/cli/bin/codebuddy'),'--print','--model',policy.id,
    '--tools','ToolSearch,DeferExecuteTool,'+toolName,'--allowedTools','ToolSearch','DeferExecuteTool',toolName,'--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{'local-document-tools':config}}),
    '--no-session-persistence','--max-turns','5','--effort','low','--output-format','json',
    `First use ToolSearch to discover the deferred MCP tool named ${toolName} (server local-document-tools). Then execute that tool exactly once using DeferExecuteTool if required, to create ${outputName} with exactly this Markdown content: # WorkBuddy local tool verification\n\nLOCAL_DOCUMENT_TOOL_OK\n. Only ToolSearch and this MCP tool (via its deferred executor when required) are permitted; do not use Write, Bash, or other tools. Make real tool calls, not XML or code in the text reply. Then reply DONE.`];
  const child=spawn(paths.nodePath,args,{windowsHide:true,cwd:directory,
    env:{...process.env,CODEBUDDY_CONFIG_DIR:paths.configDir,WORKBUDDY_CONFIG_DIR:paths.configDir}});
  let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',data=>stdout=(stdout+data).slice(-1000000));
  child.stderr.on('data',data=>stderr=(stderr+data).slice(-1000000));
  const timer=setTimeout(()=>{timedOut=true;child.kill();},90000);
  const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);}).finally(()=>clearTimeout(timer));
  let parsed;
  try{parsed=JSON.parse(stdout);}catch{parsed=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});}
  const calls=[],results=[],models=new Set(),assistantDiagnostics=[];
  function inspect(value){
    if(!value||typeof value!=='object')return;
    if(typeof value.model==='string'&&policy.allowed(value.model))models.add(value.model);
    if(value.type==='function_call')calls.push(value.name);
    if(value.type==='function_call_result')results.push({name:value.name,status:value.status});
    if(value.role==='assistant') {
      const text=typeof value.content==='string'?value.content:Array.isArray(value.content)?value.content.map(item=>item.text||'').join(''):'';
      assistantDiagnostics.push({mentionsUnavailable:/not available|no.*tool|don't have|cannot access|无法|不可用|没有.*工具/i.test(text),
        saysDone:text.trim()==='DONE',characters:text.length,fixedTestReply:text.slice(0,600)});
    }
    for(const child of Object.values(value))inspect(child);
  }
  inspect(parsed);
  let created=false;
  try{created=(await fs.readFile(path.join(local.documentRoot,outputName),'utf8')).includes('LOCAL_DOCUMENT_TOOL_OK');}catch{}
  console.log(JSON.stringify({code,timedOut,models:[...models],calls,results,assistantDiagnostics,created,output_path:path.join(local.documentRoot,outputName),
    policyDenied:(stdout+stderr).includes('[WorkBuddy local-only]')},null,2));
  if(code!==0||!created||!calls.some(name=>name.endsWith('write_markdown')||name==='DeferExecuteTool'))process.exitCode=1;
}else{
  const client=new Client({name:'local-document-smoke',version:'1.0.0'});
  const transport=new StdioClientTransport({...config,env:{...process.env,...config.env},stderr:'pipe'});
  try{
    await client.connect(transport);
    for(const [name,args] of [
      ['html_to_pdf',{input_path:'sample.html',output_path:`html-${stamp}.pdf`}],
      ['html_to_markdown',{input_path:'sample.html',output_path:`html-${stamp}.md`}],
      ['markdown_to_pdf',{input_path:'sample.md',output_path:`markdown-${stamp}.pdf`}],
      ['write_markdown',{content:'# 新建 Markdown\n\n由本地 MCP 工具保存。',output_path:`written-${stamp}.md`}]
    ]){
      const result=await client.callTool({name,arguments:args});
      if(result.isError)throw Error(name+' failed: '+result.content[0].text);
      const file=JSON.parse(result.content[0].text);
      const bytes=await fs.readFile(file.output_path);
      if(file.output_path.endsWith('.pdf')&&bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid PDF signature');
      console.log(JSON.stringify({tool:name,...file}));
    }
  }finally{await client.close();}
}
