import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await fs.readFile(path.join(directory,'local-install.json'),'utf8'));
const title='WorkBuddy Computer Test '+Date.now();
const gui=spawn(config.pythonPath,['-X','utf8',path.join(directory,'test_window.py'),title],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const events=[];let pending='';
gui.stdout.on('data',data=>{pending+=data;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){try{events.push(JSON.parse(line));}catch{}}});
gui.stderr.on('data',()=>{});
const waitFor=async predicate=>{for(let n=0;n<100;n++){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out waiting for isolated test UI.');};
const client=new Client({name:'isolated-desktop-test',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(directory,'server.mjs')],env:{...process.env,WORKBUDDY_COMPUTER_PYTHON:config.pythonPath},stderr:'pipe'});
async function call(name,args={}){const result=await client.callTool({name,arguments:args});if(result.isError)throw Error(result.content[0].text);return result;}
const json=result=>JSON.parse(result.content.find(item=>item.type==='text').text);
try{
  const ready=await waitFor(()=>events.find(e=>e.event==='ready'));
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  const names=tools.map(tool=>tool.name);
  const scrollSchema=tools.find(tool=>tool.name==='desktop_scroll').inputSchema;
  if(!['x','y','amount','snapshot_id'].every(key=>scrollSchema.required.includes(key)))throw Error('Scroll tool schema is missing required targeting parameters.');
  const windows=json(await call('desktop_windows')).windows;
  const target=windows.find(window=>window.title===title);
  if(!target)throw Error('Isolated test window not found.');
  if(process.argv.includes('--manual')) {
    console.log('Waiting up to 60 seconds: click the WorkBuddy Computer Test window to activate it.');
    const deadline=Date.now()+60000;
    let active=false;
    while(Date.now()<deadline) {
      const current=json(await call('desktop_windows')).windows.find(window=>window.window_id===target.window_id);
      if(current?.foreground){active=true;break;}
      await new Promise(resolve=>setTimeout(resolve,700));
    }
    if(!active)throw Error('Test window was not manually activated; no input was sent.');
    await new Promise(resolve=>setTimeout(resolve,500));
  }else await call('desktop_focus',{window_id:target.window_id});
  const observe=()=>call('desktop_observe',{window_id:target.window_id});
  const initial=await observe();
  let snapshot=json(initial);
  const pixel=(x,y)=>({x:Math.floor((x-snapshot.rect.left)*snapshot.image_width/(snapshot.rect.right-snapshot.rect.left)),
    y:Math.floor((y-snapshot.rect.top)*snapshot.image_height/(snapshot.rect.bottom-snapshot.rect.top))});
  await call('desktop_click',{snapshot_id:snapshot.snapshot_id,...pixel(ready.entry_x,ready.entry_y)});
  snapshot=json(await observe());
  await call('desktop_type_text',{snapshot_id:snapshot.snapshot_id,text:'WorkBuddy 中文 OK'});
  await waitFor(()=>events.find(e=>e.event==='text'&&e.value==='WorkBuddy 中文 OK'));
  snapshot=json(await observe());
  await call('desktop_key',{snapshot_id:snapshot.snapshot_id,key:'CTRL+A'});
  snapshot=json(await observe());
  await call('desktop_type_text',{snapshot_id:snapshot.snapshot_id,text:'Unicode 与快捷键验证成功'});
  await waitFor(()=>events.find(e=>e.event==='text'&&e.value==='Unicode 与快捷键验证成功'));
  snapshot=json(await observe());
  await call('desktop_click',{snapshot_id:snapshot.snapshot_id,...pixel(ready.button_x,ready.button_y)});
  await waitFor(()=>events.find(e=>e.event==='clicked'));
  snapshot=json(await observe());
  const firstScrollEvent=events.length;
  await call('desktop_scroll',{snapshot_id:snapshot.snapshot_id,...pixel(ready.scroll_x,ready.scroll_y),amount:-3});
  const down=await waitFor(()=>events.slice(firstScrollEvent).find(e=>e.event==='scrolled'&&e.positions.right>0));
  if(down.positions.left!==0||down.delta>=0)throw Error('Scroll moved the wrong pane or direction.');
  snapshot=json(await observe());
  const secondScrollEvent=events.length;
  await call('desktop_scroll',{snapshot_id:snapshot.snapshot_id,...pixel(ready.scroll_x,ready.scroll_y),amount:1});
  const up=await waitFor(()=>events.slice(secondScrollEvent).find(e=>e.event==='scrolled'&&e.positions.right<down.positions.right));
  if(up.positions.left!==0||up.delta<=0)throw Error('Upward scroll moved the wrong pane or direction.');
  const final=await observe();
  const image=final.content.find(item=>item.type==='image');
  const imagePath=path.join(directory,'test-output',`smoke-${Date.now()}.png`);
  await fs.mkdir(path.dirname(imagePath),{recursive:true});
  await fs.writeFile(imagePath,Buffer.from(image.data,'base64'),{flag:'wx'});
  console.log(JSON.stringify({success:true,tool_count:names.length,unicode_input_verified:true,shortcut_verified:true,click_verified:true,
    scroll_content_movement_verified:true,scroll_down_position:down.positions.right,scroll_up_position:up.positions.right,
    untargeted_pane_unchanged:true,screenshot:imagePath,scope:'isolated_test_window_only'},null,2));
}catch(error){
  console.log(JSON.stringify({success:false,error:error.message,test_events:events.slice(-8)},null,2));
  process.exitCode=1;
}finally{
  await client.close().catch(()=>{});
  gui.stdin.end('close\n');
  await new Promise(resolve=>{if(gui.exitCode!==null)return resolve();gui.once('close',resolve);setTimeout(()=>{gui.kill();resolve();},3000).unref();});
}
