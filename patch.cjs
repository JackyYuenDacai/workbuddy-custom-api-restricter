const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const makePolicy = require('./policy.cjs');
const paths = require('./paths.cjs');
const resources = paths.resourcesDir;
const archivePath = path.join(resources, 'app.asar');
const stage = path.join(__dirname, 'staged');
const marker = '/* WORKBUDDY_LOCAL_QWEN_ONLY_V1 */';
const injected = marker + '\nvar __wbQwenOnly = (' + makePolicy.toString() + ')();\n';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unexpected build: patch anchor must occur exactly once: ' + before.slice(0,90));
  return source.replace(before, after);
}
function patchCli(source) {
  if (source.includes(marker)) throw new Error('Already patched; refusing to patch twice.');
  const edits = [
    ['async applyRuntimeSessionModel(eA,el,ec){', 'async applyRuntimeSessionModel(eA,el,ec){__wbQwenOnly.assertModel(el);'],
    ['{availableModels:ep,currentModelId:el}', '{availableModels:ep,currentModelId:__wbQwenOnly.id}'],
    ['return{defaultAgentName:eg,models:eh,currentModelId:em}', 'return{defaultAgentName:eg,models:eh,currentModelId:eh.length?__wbQwenOnly.id:void 0}'],
    ['computeModelsFromRaw(eA,el,ec){', 'computeModelsFromRaw(eA,el,ec){return __wbQwenOnly.filterModels(ec);'],
    ['computeModels(eA){', 'computeModels(eA){return __wbQwenOnly.filterModels([...this.modelMap.values()]);'],
    ['async computeModel(eA){', 'async computeModel(eA){return __wbQwenOnly.select(this);'],
    ['async configureModelConfig(eA,el){let ec=el.requestOptions?.model?await this.getModelByRequestOptions(eA,el):await this.getModelByCliOptions(eA,el);ec||(ec=await this.getModelByRequestOptions(eA,el)),eA.model=ec.id,',
     'async configureModelConfig(eA,el){let ec=await this.agentManager.getModel(eA.name);__wbQwenOnly.assertModel(ec.id),eA.model=ec.id,'],
    ['resolveModelBaseURL(eA){', 'resolveModelBaseURL(eA){return __wbQwenOnly.base;'],
    ['async getModel(eA){if(!eA)', 'async getModel(eA){__wbQwenOnly.assertModel(eA);if(!eA)'],
    ['async requestWithConnectionRetry(eA,el,ec,eu,ed){', 'async requestWithConnectionRetry(eA,el,ec,eu,ed){__wbQwenOnly.guardRequest(eA);'],
    ['async intercept(eA){let el=eA.session,ec=el.options?.fallbackModel?.trim();',
     'async intercept(eA){return;let el=eA.session,ec=el.options?.fallbackModel?.trim();'],
  ];
  for (const [before, after] of edits) source = replaceOnce(source, before, after);
  source = injected + source;
  new vm.Script(source);
  return source;
}
function parseArchive(buffer) {
  const header = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)));
  return {header, dataStart: 8 + buffer.readUInt32LE(4)};
}
function entries(header, prefix='') {
  return Object.entries(header.files || {}).flatMap(([name, entry]) => entry.files ?
    entries(entry, prefix + name + '/') : [{name: prefix + name, entry}]);
}
function prepare() {
  if (fs.existsSync(stage)) throw new Error('Staging directory already exists. Inspect it before preparing again.');
  const original = fs.readFileSync(archivePath);
  const {header} = parseArchive(original);
  const all = entries(header);
  const changes = new Map();
  const manifest = {version:1,model:makePolicy().model,endpoint:makePolicy().base,files:[],mainEntries:[]};
  for (const name of ['cli/dist/codebuddy.js','cli/dist/codebuddy-headless.js']) {
    const target = path.join(resources,'app.asar.unpacked',name);
    const before = fs.readFileSync(target);
    const after = Buffer.from(patchCli(before.toString('utf8')));
    const {entry} = all.find(e=>e.name===name);
    if (!entry.unpacked || entry.integrity.hash !== hash(before)) throw new Error('CLI archive integrity mismatch: '+name);
    changes.set(name,after);
    manifest.files.push({target,staged:path.join(stage,path.basename(name)),beforeHash:hash(before),afterHash:hash(after)});
  }
  // These are independently loaded unpacked JS bundles. Leave the signed EXE and
  // embedded-integrity-protected ASAR archive byte-for-byte unchanged.
  fs.mkdirSync(stage,{recursive:true});
  for(const file of manifest.files)fs.writeFileSync(file.staged,changes.get('cli/dist/'+path.basename(file.target)));
  manifest.protectedArchiveHash = hash(original);
  fs.writeFileSync(path.join(__dirname,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log('Prepared and syntax-checked two unpacked routing bundles. EXE and ASAR are unchanged.');
}
function install() {
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
  const backup=paths.backupDir;
  if(fs.existsSync(backup))throw new Error('Backup exists; refusing overwrite.');
  for(const file of manifest.files) {
    if(hash(fs.readFileSync(file.target))!==file.beforeHash || hash(fs.readFileSync(file.staged))!==file.afterHash)
      throw new Error('Files changed since preparation: '+file.target);
  }
  fs.mkdirSync(backup,{recursive:true});
  for(const file of manifest.files)fs.copyFileSync(file.target,path.join(backup,path.basename(file.target)),fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2));
  try {
    for(const file of manifest.files)fs.copyFileSync(file.staged,file.target);
    for(const file of manifest.files)if(hash(fs.readFileSync(file.target))!==file.afterHash)throw new Error('Installed hash mismatch.');
  }catch(error){
    for(const file of manifest.files)fs.copyFileSync(path.join(backup,path.basename(file.target)),file.target);
    throw error;
  }
  console.log('Installed. Original program files backed up to '+backup);
}
function restore() {
  const backup=paths.backupDir;
  const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
  for(const file of manifest.files) {
    const current=hash(fs.readFileSync(file.target));
    if(current!==file.afterHash && current!==file.beforeHash)throw new Error('Program was updated or changed; refusing to overwrite: '+file.target);
    if(hash(fs.readFileSync(path.join(backup,path.basename(file.target))))!==file.beforeHash)throw new Error('Backup hash mismatch.');
  }
  for(const file of manifest.files)fs.copyFileSync(path.join(backup,path.basename(file.target)),file.target);
  console.log('Original routing bundles restored. Restart WorkBuddy.');
}
if(require.main===module) {
  if(process.argv[2]==='prepare')prepare();
  else if(process.argv[2]==='install')install();
  else if(process.argv[2]==='restore')restore();
  else throw new Error('Use prepare, install, or restore.');
}
module.exports={patchCli,parseArchive,entries};
