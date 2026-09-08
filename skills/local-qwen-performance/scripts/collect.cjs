const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const MODEL = 'Qwen3.8-27B-EXL3-3.5bpw';
const DEFAULT_URL = 'http://127.0.0.1:5000/v1/internal/model/info';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const ratio = (a,b) => number(a)!==null && number(b)!==null && b>0 ? a/b : null;
const mean = values => {const valid=values.filter(x=>x!==null);return valid.length?valid.reduce((a,b)=>a+b,0)/valid.length:null;};
function metricRecord(record) {
  const data = {};
  for (const key of ['job_id','new_tokens','emitted_tokens','prompt_tokens','cached_tokens','accepted_draft_tokens','rejected_draft_tokens',
    'image_cache_hits','image_cache_misses','image_seconds','total_seconds','time_enqueued','time_prefill','time_generate']) data[key]=number(record[key]);
  data.completed=record.completed===true;
  data.time_to_first_output_seconds=number(record.time_to_first_output);
  data.decode_tokens_per_second=data.completed ? ratio(data.new_tokens,data.time_generate) : null;
  data.end_to_end_tokens_per_second=data.completed ? ratio(data.new_tokens,data.total_seconds) : null;
  data.prompt_cache_hit_ratio=ratio(data.cached_tokens,data.prompt_tokens);
  data.draft_acceptance=data.accepted_draft_tokens!==null && data.rejected_draft_tokens!==null ?
    ratio(data.accepted_draft_tokens,data.accepted_draft_tokens+data.rejected_draft_tokens) : null;
  return data;
}
function weighted(records,tokensKey,secondsKey) {
  const valid=records.filter(r=>r[tokensKey]!==null&&r[secondsKey]!==null&&r[secondsKey]>0);
  return {count:valid.length,value:ratio(valid.reduce((n,r)=>n+r[tokensKey],0),valid.reduce((n,r)=>n+r[secondsKey],0))};
}
function summarize(info) {
  if (!info || info.model_name!==MODEL) return {status:'model_mismatch',expected_model:MODEL,
    observed_model:typeof info?.model_name==='string'?info.model_name.slice(0,160):null};
  const result={status:'ok',model:MODEL,loader:typeof info.loader==='string'?info.loader.slice(0,60):null};
  if (!info.performance || typeof info.performance!=='object') return {...result,status:'metrics_unavailable'};
  const perf=info.performance;
  const records=(Array.isArray(perf.recent_requests)?perf.recent_requests:[]).filter(r=>r&&typeof r==='object').slice(-32).map(metricRecord);
  const complete=records.filter(r=>r.completed);
  const decode=weighted(complete,'new_tokens','time_generate');
  const e2e=weighted(complete,'new_tokens','total_seconds');
  result.status=records.length?'ok':'no_history';
  result.history_semantics='last_finished_requests_not_live_token_stream';
  result.request_timestamps_available=false;
  result.active_generation_available=false;
  result.latest_finished_request=records.at(-1)||null;
  result.latest_completed_request=complete.at(-1)||null;
  result.window={finished_requests:records.length,completed_requests:complete.length,incomplete_requests:records.length-complete.length,
    weighted_decode_tokens_per_second:decode.value,decode_sample_count:decode.count,
    weighted_end_to_end_tokens_per_second:e2e.value,end_to_end_sample_count:e2e.count,
    mean_time_to_first_output_seconds:mean(complete.map(r=>r.time_to_first_output_seconds)),
    total_new_tokens:complete.reduce((n,r)=>n+(r.new_tokens||0),0)};
  const drafting=perf.drafting||{};
  result.drafting={mode:['mtp','external','none'].includes(drafting.mode)?drafting.mode:'unknown',
    max_tokens:number(drafting.max_tokens),adaptive:typeof drafting.adaptive==='boolean'?drafting.adaptive:null,
    confidence:number(drafting.confidence)};
  result.image_cache={};
  for(const key of ['entries','bytes','max_bytes'])result.image_cache[key]=number(perf.image_cache?.[key]);
  result.max_chunk_size=number(perf.max_chunk_size);
  result.history_fingerprint=crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0,16);
  return result;
}
function validateUrl(value) {
  const url=new URL(value);
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || url.search || url.hash ||
      url.pathname!=='/v1/internal/model/info') throw Error('Only a loopback TextGen model/info metrics URL is permitted.');
  return url;
}
function readInfo({url=DEFAULT_URL,key=process.env.TEXTGEN_METRICS_API_KEY,timeout=5000}={}) {
  const target=validateUrl(url);
  return new Promise((resolve,reject)=>{
    const fail=code=>reject(Object.assign(new Error(code),{code}));
    const headers={Accept:'application/json'};
    if(key)headers.Authorization='Bearer '+key;
    const request=http.get(target,{headers,agent:false},response=>{
      if(response.statusCode!==200){response.resume();fail('HTTP_'+response.statusCode);return;}
      const chunks=[];let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024){request.destroy();fail('RESPONSE_TOO_LARGE');}else chunks.push(chunk);});
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{fail('INVALID_JSON');}});
      response.on('error',()=>fail('RESPONSE_ERROR'));
    });
    const timer=setTimeout(()=>request.destroy(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})),timeout);
    request.on('close',()=>clearTimeout(timer));
    request.on('error',error=>fail(['ECONNREFUSED','ETIMEDOUT','ECONNRESET'].includes(error.code)?error.code:'REQUEST_FAILED'));
  });
}
function gpuSnapshot() {
  const binary=process.platform==='win32'?path.join(process.env.SystemRoot||'C:/Windows','System32','nvidia-smi.exe'):'nvidia-smi';
  const result=spawnSync(binary,['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw','--format=csv,noheader,nounits'],
    {encoding:'utf8',timeout:3000,windowsHide:true,maxBuffer:65536,shell:false});
  if(result.status!==0)return{status:'unavailable',devices:[]};
  const toNumber=value=>value!==''&&Number.isFinite(Number(value))?Number(value):null;
  const devices=result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>{
    const fields=line.split(',').map(x=>x.trim());
    if(fields.length!==7)return null;
    return {index:toNumber(fields[0]),name:fields[1],utilization_percent:toNumber(fields[2]),memory_used_mib:toNumber(fields[3]),
      memory_total_mib:toNumber(fields[4]),temperature_celsius:toNumber(fields[5]),power_watts:toNumber(fields[6])};
  }).filter(Boolean);
  return {status:devices.length?'ok':'unavailable',scope:'whole_gpu_not_model_exclusive',devices};
}
function parseArgs(args) {
  const options={samples:1,interval:2,gpu:true,url:process.env.TEXTGEN_METRICS_URL||DEFAULT_URL};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--no-gpu')options.gpu=false;
    else if(['--samples','--interval'].includes(args[i]))options[args[i].slice(2)]=Number(args[++i]);
    else throw Error('Use --samples 1..10, --interval 1..10, and optional --no-gpu.');
  }
  if(!Number.isInteger(options.samples)||options.samples<1||options.samples>10||!Number.isFinite(options.interval)||
    options.interval<1||options.interval>10||(options.samples-1)*options.interval>30)throw Error('Sampling must be bounded to 1..10 snapshots and at most 30 seconds of waiting.');
  validateUrl(options.url);
  return options;
}
async function main() {
  const options=parseArgs(process.argv.slice(2));
  let previous=null;
  for(let index=0;index<options.samples;index++){
    if(index)await new Promise(resolve=>setTimeout(resolve,options.interval*1000));
    const sampled_at=new Date().toISOString();
    let data;
    try{data=summarize(await readInfo({url:options.url}));}
    catch(error){data={status:'metrics_request_failed',error_code:error.code||'REQUEST_FAILED',expected_model:MODEL};}
    const fingerprint=data.history_fingerprint||null;
    const changed=previous!==null&&fingerprint!==null?previous!==fingerprint:null;
    const gpu=options.gpu?gpuSnapshot():{status:'skipped',devices:[]};
    console.log(JSON.stringify({sampled_at,metrics_source:options.url,inference_base_unchanged:'http://127.0.0.1:8317/v1',
      ...data,history_changed_since_previous_sample:changed,gpu}));
    previous=fingerprint;
    if(['metrics_request_failed','model_mismatch'].includes(data.status)){process.exitCode=1;break;}
  }
}
if(require.main===module)main().catch(()=>{console.error(JSON.stringify({status:'invalid_options',message:'Use a loopback metrics URL and bounded --samples/--interval options; do not put API keys in arguments.'}));process.exitCode=1;});
module.exports={MODEL,DEFAULT_URL,summarize,metricRecord,validateUrl,readInfo,parseArgs};
