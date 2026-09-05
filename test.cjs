const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const paths = require('./paths.cjs');
const policy = require('./policy.cjs')();
const goodRequest = () => ({modelId:policy.id,url:policy.base+'/chat/completions',method:'POST',
  data:JSON.stringify({model:policy.model,messages:[{role:'user',content:'test'}]})});

test('only raw and internal-prefix Qwen identifiers are allowed', () => {
  policy.assertModel(policy.model); policy.assertModel(policy.id);
  for(const model of ['auto','default','gpt-5.5','hy3','lite','reasoning','qwen',null,undefined,policy.model+'-other'])
    assert.throws(()=>policy.assertModel(model), {code:'WORKBUDDY_MODEL_POLICY_DENIED'});
});
test('model catalog and selection exclude cloud and Auto', () => {
  const models=[{id:'auto'},{id:'hy3'},{id:policy.id,url:'https://wrong.example',apiKey:'test-only-key'}];
  assert.equal(policy.filterModels(models).length,1);
  assert.equal(policy.filterModels(models)[0].url,policy.base);
  assert.equal(policy.filterModels(models)[0].apiKey,'test-only-key');
  assert.throws(()=>policy.select({findModelByIdOrName:()=>undefined}));
});
test('approved streaming and non-streaming requests pass', () => {
  for(const stream of [true,false]) {
    const request=goodRequest();request.data=JSON.stringify({model:policy.model,stream});
    policy.guardRequest(request);
    assert.equal(request.maxRedirects,0);assert.equal(request.proxy,false);
    const body=request.transformRequest.at(-1).call(request,request.data);
    assert.equal(JSON.parse(body).stream,stream);
  }
});
test('wrong model, endpoint, method, and malformed payload fail closed', () => {
  const bad=[{modelId:'auto'}, {url:'https://copilot.tencent.com/v2/chat/completions'},
    {url:'http://127.0.0.1:5000/v1/chat/completions'}, {url:policy.base+'/chat/completions?model=gpt-5.5'},
    {url:policy.base+'/responses'}, {method:'GET'}, {data:'not json'},
    {data:JSON.stringify({model:'gpt-5.5'})}, {data:JSON.stringify({model:policy.id})}];
  for(const change of bad)assert.throws(()=>policy.guardRequest({...goodRequest(),...change}),{code:'WORKBUDDY_MODEL_POLICY_DENIED'});
});
test('request-transform changes to model or URL are rejected', () => {
  const request=policy.guardRequest(goodRequest());
  const transform=request.transformRequest.at(-1);
  assert.throws(()=>transform.call(request,JSON.stringify({model:'hy3'})));
  assert.throws(()=>transform.call({...request,url:'https://cloud.example/v1/chat/completions'},request.data));
});
test('catalog helper leaves authentication and search definitions untouched', () => {
  const auth={endpoint:'https://login.example'}, tools=[{name:'web_search',url:'https://search.example'}];
  const config={authentication:auth,endpoint:'https://copilot.tencent.com',tools,
    models:[{id:policy.id}],agents:[{name:'summary',models:['hy3']}]};
  const result=policy.restrictProduct(config);
  assert.equal(result.authentication,auth);assert.equal(result.tools,tools);assert.equal(result.endpoint,config.endpoint);
});
test('both staged bundles compile and include all guards', () => {
  for(const name of ['codebuddy.js','codebuddy-headless.js']) {
    const source=fs.readFileSync(path.join(__dirname,'staged',name),'utf8');
    new vm.Script(source);
    for(const fragment of ['async requestWithConnectionRetry(eA,el,ec,eu,ed){__wbQwenOnly.guardRequest(eA);',
      'async getModel(eA){__wbQwenOnly.assertModel(eA);',
      'async computeModel(eA){return __wbQwenOnly.select(this);',
      'async intercept(eA){return;let el=eA.session,ec=el.options?.fallbackModel?.trim();'])
      assert.ok(source.includes(fragment),name+': '+fragment);
  }
});
test('protected ASAR archive has not changed', () => {
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
  const archive=fs.readFileSync(path.join(paths.resourcesDir,'app.asar'));
  assert.equal(crypto.createHash('sha256').update(archive).digest('hex'),manifest.protectedArchiveHash);
});

test('installed routing bundles match the tested staged files', () => {
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
  assert.equal(manifest.files.length,2);
  for (const file of manifest.files) {
    assert.ok(file.target.includes('app.asar.unpacked'));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file.target)).digest('hex'),file.afterHash);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file.staged)).digest('hex'),file.afterHash);
  }
});

test('patcher reproduces the installed bundles from verified backups', () => {
  const {patchCli}=require('./patch.cjs');
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
  for (const file of manifest.files) {
    const backup=fs.readFileSync(path.join(paths.backupDir,path.basename(file.target)));
    assert.equal(crypto.createHash('sha256').update(backup).digest('hex'),file.beforeHash);
    assert.equal(crypto.createHash('sha256').update(patchCli(backup.toString('utf8'))).digest('hex'),file.afterHash);
  }
});
