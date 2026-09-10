// Send only harmless shortcuts to our disposable recorder, never user apps.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const dir=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await fs.readFile(path.join(dir,'local-install.json'),'utf8'));
const title='WorkBuddy Keyboard Test '+Date.now();
const gui=spawn(config.pythonPath,['-X','utf8',path.join(dir,'test_window.py'),title],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const events=[];let partial='';
gui.stdout.on('data',data=>{partial+=data;const lines=partial.split('\n');partial=lines.pop();for(const line of lines){try{events.push(JSON.parse(line));}catch{}}});
gui.stderr.on('data',()=>{});
const client=new Client({name:'keyboard-smoke',version:'1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(dir,'server.mjs')],env:{...process.env,WORKBUDDY_COMPUTER_PYTHON:config.pythonPath},stderr:'pipe'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return JSON.parse(r.content.find(x=>x.type==='text').text);};
try{
  for(let i=0;i<100&&!events.some(e=>e.event==='ready');i++)await wait(100);
  if(!events.some(e=>e.event==='ready'))throw Error('Recorder did not start');
  await client.connect(transport);
  const schema=(await client.listTools()).tools.find(t=>t.name==='desktop_key').inputSchema;
  if(schema.properties.key.enum||!schema.properties.sequence)throw Error('Old restricted schema still active');
  const window=(await call('desktop_windows')).windows.find(w=>w.title===title);
  if(!window)throw Error('Recorder window not found');
  const focus=await call('desktop_focus',{window_id:window.window_id});
  if(!focus.focused)throw Error('Recorder not focused');
  for(const [args,expected] of [[{key:'CTRL+SHIFT+P'},['P']], [{key:'SHIFT+F1'},['F1']],
      [{sequence:['CTRL+K','CTRL+S']},['k','s']], [{key:'CTRL+HOME'},['Home']]]){
    const snap=await call('desktop_observe',{window_id:window.window_id});
    const start=events.length;
    const result=await call('desktop_key',{snapshot_id:snap.snapshot_id,...args});
    await wait(150);
    const keys=events.slice(start).filter(e=>e.event==='key_down').map(e=>e.keysym.toLowerCase());
    if(!expected.every(k=>keys.includes(k.toLowerCase())))throw Error('Recorder did not receive expected keys: '+JSON.stringify({args,keys}));
    console.log(JSON.stringify({args,completed_strokes:result.completed_strokes,received_keys:keys}));
  }
  console.log('Keyboard MCP smoke passed; test window only.');
}finally{
  gui.stdin.end('\n');
  await client.close().catch(()=>{});
  await transport.close().catch(()=>{});
}
