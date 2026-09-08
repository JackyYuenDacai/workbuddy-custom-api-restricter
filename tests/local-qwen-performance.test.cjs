const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {MODEL,summarize,metricRecord,validateUrl,readInfo,parseArgs}=require('../skills/local-qwen-performance/scripts/collect.cjs');
const completed={job_id:1,completed:true,new_tokens:100,time_generate:2,total_seconds:4,prompt_tokens:200,cached_tokens:100,
  accepted_draft_tokens:6,rejected_draft_tokens:2,time_to_first_output:0.5};
test('Decode, backend end-to-end and ratios use their own denominators',()=>{
  const r=metricRecord(completed);
  assert.equal(r.decode_tokens_per_second,50);assert.equal(r.end_to_end_tokens_per_second,25);
  assert.equal(r.prompt_cache_hit_ratio,0.5);assert.equal(r.draft_acceptance,0.75);
  assert.equal(metricRecord({...completed,rejected_draft_tokens:0,accepted_draft_tokens:0}).draft_acceptance,null);
});
test('Stopped records are not presented as live or complete decode measurements',()=>{
  const result=summarize({model_name:MODEL,performance:{recent_requests:[completed,{job_id:2,completed:false,total_seconds:5,emitted_tokens:20}]}});
  assert.equal(result.latest_finished_request.completed,false);assert.equal(result.latest_finished_request.decode_tokens_per_second,null);
  assert.equal(result.latest_completed_request.job_id,1);assert.equal(result.active_generation_available,false);
  assert.equal(result.request_timestamps_available,false);
});
test('Weighted speed is token/time weighted and does not include incomplete requests',()=>{
  const data=summarize({model_name:MODEL,performance:{recent_requests:[completed,{...completed,job_id:2,new_tokens:50,time_generate:5},
    {...completed,job_id:3,completed:false,new_tokens:9999}]}});
  assert.equal(data.window.weighted_decode_tokens_per_second,150/7);assert.equal(data.window.decode_sample_count,2);
});
test('Mismatch, absent metrics and empty history remain distinguishable',()=>{
  assert.equal(summarize({model_name:'other'}).status,'model_mismatch');
  assert.equal(summarize({model_name:MODEL}).status,'metrics_unavailable');
  assert.equal(summarize({model_name:MODEL,performance:{recent_requests:[]}}).status,'no_history');
});
test('Sensitive/unknown fields are dropped; MTP is retained without assuming an external draft model',()=>{
  const data=summarize({model_name:MODEL,apiKey:'secret',performance:{recent_requests:[{...completed,prompt:'private text'}],drafting:{mode:'mtp',max_tokens:4,adaptive:false,secret:'private'}}});
  assert.equal(data.drafting.mode,'mtp');assert.equal(data.drafting.max_tokens,4);
  assert.ok(!JSON.stringify(data).includes('secret'));assert.ok(!JSON.stringify(data).includes('private'));
  assert.equal(data.history_fingerprint,summarize({model_name:MODEL,performance:{recent_requests:[completed]}}).history_fingerprint);
});
test('Metrics allowlist rejects remote hosts, credentials, queries and inference endpoints',()=>{
  for(const url of ['https://cloud.example/v1/internal/model/info','http://localhost:5000/v1/internal/model/info',
    'http://user:pass@127.0.0.1:5000/v1/internal/model/info','http://127.0.0.1:5000/v1/chat/completions',
    'http://127.0.0.1:5000/v1/internal/model/info?key=secret'])assert.throws(()=>validateUrl(url));
  assert.equal(validateUrl('http://127.0.0.1:5000/v1/internal/model/info').port,'5000');
});
test('Sampling is bounded',()=>{
  assert.equal(parseArgs([]).samples,1);assert.equal(parseArgs(['--samples','3','--interval','2']).samples,3);
  for(const args of [['--samples','100'],['--interval','0'],['--samples','10','--interval','10'],['--unknown']])assert.throws(()=>parseArgs(args));
});
test('HTTP client is GET-only, does not follow redirects and times out',async()=>{
  let requests=0;let mode='ok';
  const server=http.createServer((req,res)=>{
    requests++;assert.equal(req.method,'GET');assert.equal(req.url,'/v1/internal/model/info');
    if(mode==='slow')return;
    if(mode==='redirect'){res.writeHead(302,{Location:'/redirect-target'});res.end();return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model_name:MODEL}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/v1/internal/model/info`;
  try{
    assert.equal((await readInfo({url})).model_name,MODEL);
    mode='redirect';await assert.rejects(readInfo({url}),{code:'HTTP_302'});assert.equal(requests,2);
    mode='slow';await assert.rejects(readInfo({url,timeout:50}),{code:'ETIMEDOUT'});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
