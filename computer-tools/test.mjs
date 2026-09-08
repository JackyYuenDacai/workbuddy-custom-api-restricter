import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from './controller.mjs';

function fixture(options={}) {
  const requests=[];
  const bridge=async request=>{
    requests.push(request);
    if(request.action==='observe')return{window_id:'123',pid:44,rect:{left:-800,top:100,right:800,bottom:1300},image_width:800,image_height:600,png_base64:'test'};
    return {performed:true};
  };
  return {requests,controller:createController(bridge,{isStopped:()=>false,...options})};
}
test('Click coordinates map screenshot scale and negative monitor positions',async()=>{
  const {controller,requests}=fixture();
  const observed=await controller.observe({window_id:'123'});
  await controller.act('click',{snapshot_id:observed.metadata.snapshot_id,x:100,y:50});
  assert.equal(requests.at(-1).screen_x,-600);assert.equal(requests.at(-1).screen_y,200);
  assert.equal(requests.at(-1).expected_pid,44);assert.deepEqual(requests.at(-1).expected_rect,{left:-800,top:100,right:800,bottom:1300});
});
test('Snapshot is single-use, including after failed or invalid actions',async()=>{
  const {controller}=fixture();
  const token=(await controller.observe({window_id:'123'})).metadata.snapshot_id;
  await assert.rejects(controller.act('click',{snapshot_id:token,x:900,y:0}),/outside/);
  await assert.rejects(controller.act('key',{snapshot_id:token,key:'ENTER'}),/already used/);
});
test('Expired and wrong snapshot IDs are rejected',async()=>{
  let now=0;
  const {controller}=fixture({now:()=>now});
  const token=(await controller.observe({window_id:'123'})).metadata.snapshot_id;
  now=120001;
  await assert.rejects(controller.act('type',{snapshot_id:token,text:'test'}),/stale/);
  await controller.observe({window_id:'123'});
  await assert.rejects(controller.act('type',{snapshot_id:'wrong',text:'test'}),/stale/);
});
test('A slow 50-second inference still permits one action, but never reuse',async()=>{
  let now=0;
  const {controller,requests}=fixture({now:()=>now});
  const {metadata}=await controller.observe({window_id:'123'});
  assert.equal(metadata.valid_for_seconds,120);
  now=50000;
  await controller.act('scroll',{snapshot_id:metadata.snapshot_id,x:400,y:300,amount:-3});
  assert.deepEqual(requests.at(-1),{action:'scroll',window_id:'123',expected_pid:44,
    expected_rect:{left:-800,top:100,right:800,bottom:1300},screen_x:0,screen_y:700,amount:-3});
  await assert.rejects(controller.act('scroll',{snapshot_id:metadata.snapshot_id,x:400,y:300,amount:-3}),/already used/);
});
test('Scroll targets support scaled negative-monitor coordinates in both directions',async()=>{
  const {controller,requests}=fixture();
  for(const amount of [-5,1,5]){
    const {metadata}=await controller.observe({window_id:'123'});
    await controller.act('scroll',{snapshot_id:metadata.snapshot_id,x:100,y:50,amount});
    assert.equal(requests.at(-1).screen_x,-600);
    assert.equal(requests.at(-1).screen_y,200);
    assert.equal(requests.at(-1).amount,amount);
  }
});
test('Scroll rejects absent/invalid coordinates and amounts before invoking the backend',async()=>{
  const {controller,requests}=fixture();
  for(const params of [{amount:-1},{x:1,amount:-1},{x:800,y:0,amount:-1},{x:-1,y:0,amount:-1},
    {x:1.5,y:0,amount:-1},{x:0,y:600,amount:-1},...[0,6,-6,1.5,true].map(amount=>({x:1,y:1,amount}))]){
    const {metadata}=await controller.observe({window_id:'123'});
    const count=requests.length;
    await assert.rejects(controller.act('scroll',{snapshot_id:metadata.snapshot_id,...params}));
    assert.equal(requests.length,count);
  }
});
test('STOP prevents focus and input while allowing read-only discovery',async()=>{
  const {controller,requests}=fixture({isStopped:()=>true});
  await controller.windows();
  await assert.rejects(controller.focus({window_id:'123'}),/paused/);
  await assert.rejects(controller.act('key',{snapshot_id:'anything',key:'ENTER'}),/paused/);
  assert.equal(requests.length,1);
});
test('Focus invalidates an existing screenshot',async()=>{
  const {controller}=fixture();
  const token=(await controller.observe({window_id:'123'})).metadata.snapshot_id;
  await controller.focus({window_id:'123'});
  await assert.rejects(controller.act('key',{snapshot_id:token,key:'ENTER'}),/already used/);
});
test('Actions do not overlap',async()=>{
  let release;
  const controller=createController(()=>new Promise(resolve=>{release=resolve;}));
  const pending=controller.windows();
  await assert.rejects(controller.windows(),/overlap/);
  release({windows:[]});await pending;
});
test('Backend rejection never causes an automatic input retry',async()=>{
  let inputs=0;
  const controller=createController(async request=>{
    if(request.action==='observe')return{window_id:'123',pid:44,rect:{left:0,top:0,right:800,bottom:600},image_width:800,image_height:600,png_base64:'test'};
    inputs++;throw Error('Window moved');
  },{isStopped:()=>false});
  const token=(await controller.observe({window_id:'123'})).metadata.snapshot_id;
  await assert.rejects(controller.act('type',{snapshot_id:token,text:'hello'}),/Window moved/);
  await assert.rejects(controller.act('type',{snapshot_id:token,text:'hello'}),/already used/);
  assert.equal(inputs,1);
});
test('Launch invalidates snapshots and forwards only explicit app/URL fields',async()=>{
  const {controller,requests}=fixture();
  const token=(await controller.observe({window_id:'123'})).metadata.snapshot_id;
  await controller.launch({app:'firefox',url:'https://www.google.com/search?q=Astra',args:['untrusted']});
  assert.deepEqual(requests.at(-1),{action:'launch',app:'firefox',url:'https://www.google.com/search?q=Astra'});
  await assert.rejects(controller.act('key',{snapshot_id:token,key:'CTRL+L'}),/already used/);
});
test('STOP blocks launches but app discovery and browser state remain read-only',async()=>{
  const {controller,requests}=fixture({isStopped:()=>true});
  await controller.findApp({app:'firefox'});
  await controller.browserState({window_id:'123'});
  await assert.rejects(controller.launch({app:'firefox'}),/paused/);
  assert.deepEqual(requests,[{action:'find_app',app:'firefox'},{action:'browser_state',window_id:'123'}]);
});
test('Ctrl+L preserves the same snapshot/foreground identity safeguards',async()=>{
  const {controller,requests}=fixture();
  const token=(await controller.observe({window_id:'123'})).metadata.snapshot_id;
  await controller.act('key',{snapshot_id:token,key:'CTRL+L'});
  assert.equal(requests.at(-1).key,'CTRL+L');
  assert.equal(requests.at(-1).expected_pid,44);
  await assert.rejects(controller.act('key',{snapshot_id:token,key:'CTRL+L'}),/already used/);
});
