// Explicit interactive test: opens a NEW Firefox window, never closes existing ones.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await fs.readFile(path.join(directory,'local-install.json'),'utf8'));
const client=new Client({name:'firefox-browser-test',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(directory,'server.mjs')],env:{...process.env,WORKBUDDY_COMPUTER_PYTHON:config.pythonPath},stderr:'pipe'});
const json=result=>JSON.parse(result.content.find(item=>item.type==='text').text);
async function call(name,args={}){const result=await client.callTool({name,arguments:args});if(result.isError)throw Error(result.content[0].text);return result;}
try{
  await client.connect(transport);
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  const windowIndex=process.argv.indexOf('--window');
  let window_id=windowIndex>=0?process.argv[windowIndex+1]:null;
  if(windowIndex<0&&!process.argv.includes('--launch'))throw Error('Use --launch (new Firefox Google search Astra window) or --window ID (observe only). Add --ctrl-l for an explicit address-bar shortcut test.');
  if(!window_id){
    const found=json(await call('desktop_find_app',{app:'firefox'}));
    console.log(JSON.stringify({discovery:found}));
    if(!found.found)throw Error('Firefox not found in checked locations.');
    const launched=json(await call('desktop_launch',{app:'firefox',url:'https://www.google.com/search?q=Astra'}));
    console.log(JSON.stringify({launch:launched}));
    if(launched.windows.length!==1)throw Error('Expected one new Firefox window. Inspect windows before continuing; do not relaunch automatically.');
    window_id=launched.windows[0].window_id;
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  let state=json(await call('desktop_browser_state',{window_id}));
  if(state.process.toLowerCase()!=='firefox.exe')throw Error('Selected window is not Firefox.');
  console.log(JSON.stringify({tool_count:names.length,browser_state:state}));
  if(!state.foreground){
    try{await call('desktop_focus',{window_id});}
    catch(error){console.log(JSON.stringify({needs_manual_focus:true,window_id,message:error.message}));process.exitCode=2;}
  }
  if(!process.exitCode){
    let observed=await call('desktop_observe',{window_id});
    if(process.argv.includes('--ctrl-l')){
      await call('desktop_key',{snapshot_id:json(observed).snapshot_id,key:'CTRL+L'});
      observed=await call('desktop_observe',{window_id});
      state=json(await call('desktop_browser_state',{window_id}));
      console.log(JSON.stringify({ctrl_l_sent:true,browser_state_after_shortcut:state}));
    }
    const screenshot=path.join(directory,'test-output',`firefox-${Date.now()}.png`);
    await fs.mkdir(path.dirname(screenshot),{recursive:true});
    await fs.writeFile(screenshot,Buffer.from(observed.content.find(item=>item.type==='image').data,'base64'),{flag:'wx'});
    console.log(JSON.stringify({screenshot,window_id,page_verified:false,next_step:'Inspect screenshot to verify Google results; launch/title/URL alone are not sufficient.'}));
  }
}catch(error){console.error(JSON.stringify({success:false,error:error.message}));process.exitCode=1;}
finally{await client.close().catch(()=>{});}
