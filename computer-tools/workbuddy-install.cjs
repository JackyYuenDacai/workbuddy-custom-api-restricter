const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const paths=require('../paths.cjs');
const action=process.argv[2];
const name='local-computer-tools';
if(!['install','check','remove'].includes(action))throw Error('Use install, check or remove.');
function run(args){return spawnSync(paths.nodePath,[path.join(paths.resourcesDir,'app.asar.unpacked/cli/bin/codebuddy'),'mcp',...args],
  {windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,CODEBUDDY_CONFIG_DIR:paths.configDir,WORKBUDDY_CONFIG_DIR:paths.configDir}});}
function inspect(result){const output=(result.stdout||'')+'\n'+(result.stderr||'');return{
  registered:result.status===0&&output.includes(name+':')&&/Scope:\s*(user|project|local)/.test(output),
  missing:output.includes('MCP server "'+name+'" not found in any scope'),connected:/Status:\s*✓ Connected/.test(output)};}
if(action==='check'){
  const result=run(['get',name]),state=inspect(result);
  console.log(JSON.stringify({name,...state}));if(!state.registered||!state.connected)process.exitCode=1;
}else if(action==='install'){
  if(!inspect(run(['get',name])).missing)throw Error('Server exists or state is unknown; refusing to overwrite.');
  const local=JSON.parse(fs.readFileSync(path.join(__dirname,'local-install.json'),'utf8'));
  if(!path.isAbsolute(local.pythonPath)||!fs.existsSync(local.pythonPath))throw Error('Configure an existing absolute Python executable path.');
  const probe=spawnSync(local.pythonPath,['-c','import sys, PIL; assert sys.platform == "win32"; print("ready")'],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(probe.status!==0)throw Error('Windows Python with Pillow is required.');
  const config={type:'stdio',command:paths.nodePath,args:[path.join(__dirname,'server.mjs')],env:{WORKBUDDY_COMPUTER_PYTHON:local.pythonPath}};
  const result=run(['add-json','--scope','user',name,JSON.stringify(config)]);
  const success=result.status===0&&(result.stdout||'').includes('Added stdio MCP server '+name);
  console.log(JSON.stringify({name,action,success}));if(!success)process.exitCode=1;
}else{
  const result=run(['remove','--scope','user',name]);
  const success=result.status===0&&(result.stdout||'').includes('Removed MCP server "'+name+'"');
  console.log(JSON.stringify({name,action,success}));if(!success)process.exitCode=1;
}
