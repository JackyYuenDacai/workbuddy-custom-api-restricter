// End-to-end check using a fixed prompt and a single allowlisted read-only command.
const {spawn}=require('node:child_process');
const path=require('node:path');
const paths=require('../paths.cjs');
const policy=require('../policy.cjs')();
const loadOnly=process.argv.includes('--load-only');
const helper=path.join(paths.configDir,'skills/local-qwen-performance/scripts/collect.cjs').replaceAll('\\','/');
const command='node '+helper;
const args=[path.join(paths.resourcesDir,'app.asar.unpacked/cli/bin/codebuddy'),'--print','--model',policy.id,
  '--tools','Skill,Bash','--allowedTools','Skill','Bash('+command+')','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
  '--no-session-persistence','--max-turns','4','--effort','low','--output-format','stream-json','--verbose',
  loadOnly?'Use the Skill tool to load local-qwen-performance. This is only a skill discovery test: do not run Bash, scripts, or other tools, do not fetch any metrics. Once the Skill tool succeeds, reply SKILL_LOADED.':
    'Use the Skill tool to load local-qwen-performance. Then run exactly this read-only command once using Bash: '+command+
    '. Do not change any files, do not run any other shell command, and do not start a benchmark. Briefly report the measured performance in Chinese, distinguishing sampling time from request time.'];
const child=spawn(paths.nodePath,args,{windowsHide:true,cwd:path.dirname(__dirname),
  env:{...process.env,CODEBUDDY_CONFIG_DIR:paths.configDir,WORKBUDDY_CONFIG_DIR:paths.configDir}});
let stdout='',stderr='',timedOut=false;
child.stdout.on('data',data=>stdout=(stdout+data).slice(-1000000));
child.stderr.on('data',data=>stderr=(stderr+data).slice(-1000000));
const timer=setTimeout(()=>{timedOut=true;child.kill();},90000);
child.on('error',()=>{clearTimeout(timer);console.error('Could not start WorkBuddy CLI.');process.exitCode=1;});
child.on('close',code=>{
  clearTimeout(timer);
  let parsed;
  try{parsed=JSON.parse(stdout);}catch{parsed=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});}
  const calls=[],results=[],models=new Set();let hasMetrics=false;
  function inspect(value){
    if(!value||typeof value!=='object')return;
    if(typeof value.model==='string'&&policy.allowed(value.model))models.add(value.model);
    if(value.type==='function_call'||value.type==='tool_use')calls.push(value.name);
    if(value.type==='function_call_result'){
      const output=JSON.stringify(value.output||'');
      const measured=value.name==='Bash'&&output.includes('"metrics_source"')&&output.includes('"latest_completed_request"');
      // Stringified string outputs escape their JSON quotes.
      const escapedMeasured=value.name==='Bash'&&output.includes('metrics_source')&&output.includes('latest_completed_request')&&output.includes('sampled_at');
      hasMetrics ||= measured||escapedMeasured;
      results.push({name:value.name,status:value.status,hasMetrics:measured||escapedMeasured});
    }
    for(const child of Object.values(value))inspect(child);
  }
  inspect(parsed);
  const success=code===0&&!timedOut&&calls.includes('Skill')&&(loadOnly?stdout.includes('SKILL_LOADED'):calls.includes('Bash')&&hasMetrics);
  console.log(JSON.stringify({success,loadOnly,code,timedOut,models:[...models],calls,results,
    policyDenied:(stdout+stderr).includes('[WorkBuddy local-only]')},null,2));
  if(!success)process.exitCode=1;
});
