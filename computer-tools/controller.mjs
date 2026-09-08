import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_VALID_SECONDS=120;
export function createBridge(pythonPath) {
  if (!pythonPath || !path.isAbsolute(pythonPath)) throw Error('Configure an absolute WORKBUDDY_COMPUTER_PYTHON path.');
  return request=>new Promise((resolve,reject)=>{
    const child=spawn(pythonPath,['-X','utf8',path.join(directory,'windows_backend.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',size=0;
    const timer=setTimeout(()=>{child.kill();reject(Error('Desktop operation timed out. Do not retry input without a new screenshot.'));},12000);
    child.stdout.on('data',data=>{size+=data.length;if(size>12*1024*1024){child.kill();reject(Error('Screenshot response too large.'));}else stdout+=data;});
    child.stderr.on('data',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(Error('Could not start the configured Python desktop bridge.'));});
    child.on('close',()=>{clearTimeout(timer);try{const response=JSON.parse(stdout);if(!response.ok)reject(Error(response.error));else resolve(response.result);}catch{reject(Error('Desktop bridge returned an invalid response.'));}});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(request));
  });
}
export function createController(bridge,{now=()=>Date.now(),isStopped=()=>fs.existsSync(path.join(directory,'STOP'))}={}) {
  let snapshot=null,busy=false;
  async function exclusive(action) {
    if(busy)throw Error('Another desktop operation is running; do not overlap actions.');
    busy=true;try{return await action();}finally{busy=false;}
  }
  function enabled(){if(isStopped())throw Error('Computer input is paused by the STOP file. Ask the user to remove it manually to resume.');}
  const controller={
    windows:()=>exclusive(()=>bridge({action:'windows'})),
    cursor:()=>exclusive(()=>bridge({action:'cursor'})),
    findApp:({app})=>exclusive(()=>bridge({action:'find_app',app})),
    launch:({app,url})=>exclusive(async()=>{enabled();snapshot=null;return bridge({action:'launch',app,url});}),
    browserState:({window_id})=>exclusive(()=>bridge({action:'browser_state',window_id})),
    focus:({window_id})=>exclusive(async()=>{enabled();snapshot=null;return bridge({action:'focus',window_id});}),
    observe:({window_id})=>exclusive(async()=>{
      snapshot=null;
      const result=await bridge({action:'observe',window_id});
      const {png_base64,...metadata}=result;
      const token=randomUUID();
      snapshot={token,source:'window',window_id,pid:result.pid,rect:result.rect,focus:result.focused_control,width:result.image_width,height:result.image_height,created:now()};
      return {metadata:{...metadata,snapshot_id:token,valid_for_seconds:SNAPSHOT_VALID_SECONDS,coordinates:'image pixels, origin at top-left of this image',one_action_per_snapshot:true},png_base64};
    }),
    screenObserve:()=>exclusive(async()=>{
      snapshot=null;
      const result=await bridge({action:'screen_observe'});
      const {png_base64,...metadata}=result;
      const token=randomUUID();
      snapshot={token,source:'screen',rect:{left:result.screen_left,top:result.screen_top,right:result.screen_right,bottom:result.screen_bottom},width:result.image_width,height:result.image_height,created:now()};
      return {metadata:{...metadata,snapshot_id:token,valid_for_seconds:SNAPSHOT_VALID_SECONDS,coordinates:'image pixels, origin at top-left of this image',one_action_per_snapshot:true},png_base64};
    }),
    screenClick:({snapshot_id,x,y,button,count})=>exclusive(async()=>{
      enabled();
      const previous=snapshot;snapshot=null;
      if(!previous||previous.source!=='screen'||snapshot_id!==previous.token||now()-previous.created>SNAPSHOT_VALID_SECONDS*1000)throw Error('Screen snapshot is missing, stale or already used. Observe the screen again.');
      if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=previous.width||y>=previous.height)throw Error('Click coordinates are missing or outside the screen image. Supply x and y from a new screen observation.');
      const screen_x=previous.rect.left+Math.floor(x*(previous.rect.right-previous.rect.left)/previous.width);
      const screen_y=previous.rect.top+Math.floor(y*(previous.rect.bottom-previous.rect.top)/previous.height);
      return bridge({action:'screen_click',expected_screen:previous.rect,screen_x,screen_y,button:button||'left',count:count||1});
    }),
    act:(action,args)=>exclusive(async()=>{
      enabled();
      const previous=snapshot;snapshot=null;
      if(!previous||previous.source!=='window'||args.snapshot_id!==previous.token||now()-previous.created>SNAPSHOT_VALID_SECONDS*1000)throw Error('Window snapshot is missing, stale or already used. Observe the target again.');
      if(!['click','type','key','scroll'].includes(action))throw Error('Unsupported action.');
      const request={action,window_id:previous.window_id,expected_rect:previous.rect,expected_pid:previous.pid};
      if(action==='type'||action==='key')request.expected_focus=previous.focus;
      if(action==='click'||action==='scroll'){
        if(!Number.isInteger(args.x)||!Number.isInteger(args.y)||args.x<0||args.y<0||args.x>=previous.width||args.y>=previous.height)throw Error('Click/scroll coordinates are missing or outside the screenshot. Supply x and y from a new observation.');
        request.screen_x=previous.rect.left+Math.floor(args.x*(previous.rect.right-previous.rect.left)/previous.width);
        request.screen_y=previous.rect.top+Math.floor(args.y*(previous.rect.bottom-previous.rect.top)/previous.height);
      }
      if(action==='click'){
        request.button=args.button||'left';request.count=args.count||1;
      }else if(action==='type')request.text=args.text;
      else if(action==='key')request.key=args.key;
      else {
        if(!Number.isInteger(args.amount)||Math.abs(args.amount)<1||Math.abs(args.amount)>5)throw Error('Scroll amount must be an integer from -5 to 5, excluding zero.');
        request.amount=args.amount;
      }
      return bridge(request);
    })
  };
  return controller;
}
