import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const directory=path.dirname(fileURLToPath(import.meta.url));
const script=path.resolve(directory,'../skills/qq-message-export/scripts/qq_export.py');
export function runQQExport(request,{python=process.env.WORKBUDDY_COMPUTER_PYTHON,env=process.env}={}) {
  if(!python || !path.isAbsolute(python))return Promise.reject(Error('Configure WORKBUDDY_COMPUTER_PYTHON to an absolute Python path.'));
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-X','utf8',script],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',size=0;
    const timer=setTimeout(()=>{child.kill();reject(Error('QQ operation timed out. Check local receipts and QCE tasks before resubmitting an export.'));},180000);
    child.stdout.on('data',data=>{size+=data.length;if(size>1024*1024){child.kill();reject(Error('QQ metadata response too large.'));}else stdout+=data;});
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(Error('Cannot start the QQ export Python client.'));});
    child.on('close',()=>{clearTimeout(timer);try{const response=JSON.parse(stdout);if(!response.ok)reject(Error(response.error));else resolve(response.result);}catch{reject(Error('Invalid QQ client response. Inspect receipts before retrying export.'));}});
    child.stdin.end(JSON.stringify(request));
  });
}

export function registerQQExportTools(server,run=runQQExport) {
  const wrap=action=>async args=>{try{return{content:[{type:'text',text:JSON.stringify(await run({...args,action}),null,2)}]};}catch(error){return{isError:true,content:[{type:'text',text:error.message}]};}};
  const readonly={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  const kind=z.enum(['group','friend']);
  const id=z.string().regex(/^[1-9][0-9]{3,19}$/);
  server.registerTool('qq_export_status',{description:'Check the configured loopback QQ Chat Exporter (QCE) service, QQ login readiness and account ID. Does not install, log in, inspect messages or change QQ.',inputSchema:{},annotations:readonly},wrap('status'));
  server.registerTool('qq_find_chat',{description:'Resolve QQ group name/number or friend name/QQ number through the local authenticated QCE service. Returns only matching identities, no message bodies. Group names are not unique; use the exact returned numeric ID for export. Normal friends only; no temporary/service chats.',inputSchema:{kind,query:z.string().min(1).max(100)},annotations:readonly},wrap('find'));
  server.registerTool('qq_export_messages',{description:'Plan or submit a local QCE message export for one exact group/friend ID and explicit date interval. dry_run defaults true and performs no network request. Set false for the user-authorized export after resolving identity. YYYY-MM-DD dates use UTC+8; end date includes that entire day. ISO timestamps require offset and end is EXCLUSIVE. Optional sender_ids selects senders within the conversation. Media downloads default off for speed; message metadata stays included. Returns job_id for polling; accepted is not completed. Requires an already running authenticated QCE backend; never retries submissions or sends QQ messages.',inputSchema:{kind,chat_id:id,start:z.string().min(10).max(40),end:z.string().min(10).max(40),format:z.enum(['JSON','TXT','HTML','EXCEL']).default('JSON'),sender_ids:z.array(id).max(50).default([]),include_media:z.boolean().default(false),dry_run:z.boolean().default(true)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},wrap('export'));
  server.registerTool('qq_export_task',{description:'Check one local export job_id returned by qq_export_messages. Reads that task only, reports progress and completed output paths, never resubmits, deletes, or downloads remote files. Completion does not prove complete QQ history coverage.',inputSchema:{job_id:z.string().uuid()},annotations:readonly},wrap('task'));
}
