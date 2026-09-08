// Bounded WorkBuddy/Qwen read-only integration check; never launches a GUI app.
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const paths=require('../paths.cjs');
const policy=require('../policy.cjs')();
const directory=path.join(__dirname,'../computer-tools');
const local=JSON.parse(fs.readFileSync(path.join(directory,'local-install.json'),'utf8'));
const config={mcpServers:{'local-computer-tools':{type:'stdio',command:paths.nodePath,args:[path.join(directory,'server.mjs')],env:{WORKBUDDY_COMPUTER_PYTHON:local.pythonPath}}}};
const args=[path.join(paths.resourcesDir,'app.asar.unpacked/cli/bin/codebuddy'),'--print','--model',policy.id,
  '--tools','Skill,ToolSearch,DeferExecuteTool','--allowedTools','Skill','ToolSearch','DeferExecuteTool','mcp__local-computer-tools__desktop_find_app',
  '--strict-mcp-config','--mcp-config',JSON.stringify(config),'--no-session-persistence','--max-turns','6','--effort','low','--output-format','stream-json','--verbose',
  'Use Skill to load windows-computer-use. This is a READ-ONLY integration test. Discover the local-computer-tools desktop_find_app MCP tool and actually call it once with app=firefox. Use ToolSearch and DeferExecuteTool if required. Do not launch apps, focus windows, take screenshots, type, click, execute shell commands, edit files or call other desktop tools. Report in Chinese whether Firefox was found, which discovery source succeeded and whether it is on PATH. Do not claim a browser page was opened.'];
const child=spawn(paths.nodePath,args,{windowsHide:true,cwd:path.join(__dirname,'..'),env:{...process.env,CODEBUDDY_CONFIG_DIR:paths.configDir,WORKBUDDY_CONFIG_DIR:paths.configDir}});
let stdout='',stderr='',timedOut=false;
child.stdout.on('data',data=>{stdout=(stdout+data).slice(-1000000);});
child.stderr.on('data',data=>{stderr=(stderr+data).slice(-100000);});
const timer=setTimeout(()=>{timedOut=true;child.kill();},90000);
child.on('error',()=>{clearTimeout(timer);console.error('Could not start WorkBuddy CLI.');process.exitCode=1;});
child.on('close',code=>{
  clearTimeout(timer);
  const events=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const calls=[],results=[];let foundEvidence=false;
  function inspect(value){
    if(!value||typeof value!=='object')return;
    if(['function_call','tool_use'].includes(value.type))calls.push(value.name);
    if(['function_call_result','tool_result'].includes(value.type)){
      const output=JSON.stringify(value.output??value.content??'');
      const found=/found[\\"\s:]+true/.test(output)&&output.includes('firefox.exe')&&output.includes('App Paths');
      foundEvidence ||= found;
      results.push({name:value.name??null,status:value.status??null,foundEvidence:found});
    }
    for(const nested of Object.values(value))inspect(nested);
  }
  inspect(events);
  console.log(JSON.stringify({code,timedOut,calls,results,foundEvidence,policyDenied:(stdout+stderr).includes('[WorkBuddy local-only]'),
    final:events.filter(event=>event.type==='result').map(event=>({subtype:event.subtype,result:event.result})).slice(-1)},null,2));
  if(code!==0||timedOut||!foundEvidence)process.exitCode=1;
});
