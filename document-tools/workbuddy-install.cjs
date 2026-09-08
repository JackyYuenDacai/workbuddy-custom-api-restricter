// Additive registration through WorkBuddy's supported MCP CLI, not direct config replacement.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const paths=require('../paths.cjs');
const configPath=path.join(__dirname,'local-install.json');
const action=process.argv[2];
if(!['check','install','remove'].includes(action))throw Error('Use check, install or remove.');
const name='local-document-tools';
function run(args){
  return spawnSync(paths.nodePath,[path.join(paths.resourcesDir,'app.asar.unpacked/cli/bin/codebuddy'),'mcp',...args],
    {windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,CODEBUDDY_CONFIG_DIR:paths.configDir,WORKBUDDY_CONFIG_DIR:paths.configDir}});
}
function inspect(result){
  const output=(result.stdout||'')+'\n'+(result.stderr||'');
  return {registered:result.status===0&&output.includes(name+':')&&/Scope:\s*(user|project|local)/.test(output),
    missing:output.includes('MCP server "'+name+'" not found in any scope'),
    connected:/Status:\s*✓ Connected/.test(output)};
}
if(action==='check'){
  const result=run(['get',name]);
  const state=inspect(result);
  console.log(JSON.stringify({name,exitCode:result.status,...state}));
  process.exitCode=state.registered&&state.connected?0:1;
}else if(action==='install'){
  const previous=inspect(run(['get',name]));
  if(!previous.missing)throw Error('Server already exists or its state is unknown; refusing to overwrite it.');
  const local=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if(!path.isAbsolute(local.documentRoot)||!fs.statSync(local.documentRoot).isDirectory())throw Error('Document root must exist.');
  if(!path.isAbsolute(local.browserPath)||!fs.existsSync(local.browserPath))throw Error('Browser executable is missing.');
  const config={type:'stdio',command:paths.nodePath,args:[path.join(__dirname,'server.mjs')],
    env:{WORKBUDDY_DOCUMENT_ROOT:local.documentRoot,WORKBUDDY_BROWSER_PATH:local.browserPath}};
  const result=run(['add-json','--scope','user',name,JSON.stringify(config)]);
  const success=result.status===0&&(result.stdout||'').includes('Added stdio MCP server '+name);
  console.log(JSON.stringify({name,action,exitCode:result.status,success}));
  if(!success)process.exitCode=1;
}else{
  const result=run(['remove','--scope','user',name]);
  const success=result.status===0&&(result.stdout||'').includes('Removed MCP server "'+name+'"');
  console.log(JSON.stringify({name,action,exitCode:result.status,success}));
  if(!success)process.exitCode=1;
}
