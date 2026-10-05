import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createDemoHost,COOKIE} from '../deploy/demo-host.mjs';
import {createNativeGameHost,NATIVE_GAME_IDS} from '../deploy/native-game-host.mjs';

const origin='https://game.example.test',csrf='a'.repeat(64);
async function serverFixture(t){
 const calls=[];
 const backend={games:async()=>({games:[]}),launch:async(guest,body)=>{calls.push({guest,body});return{entry_url:origin+'/play/'+body.game_id,session_id:'session_fixture',launch_code:'fixture_one_use_code'};}};
 const server=await createDemoHost({origin},{backend,key:Buffer.alloc(32,21)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const send=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{host:new URL(origin).host,...headers}},res=>{
   let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw}));
  });req.on('error',reject);req.end(body);
 });
 return{send,calls};
}

test('all released native routes are standalone full-screen shells with unchanged demo CSP and no backend side effects',async t=>{
 const {send,calls}=await serverFixture(t),web=await send('/demo/');
 for(const game of NATIVE_GAME_IDS){
  const response=await send('/demo/native/'+game);
  assert.equal(response.status,200);assert.equal(response.headers['content-security-policy'],web.headers['content-security-policy']);
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['set-cookie'],undefined);
  assert.match(response.raw,new RegExp(`data-game="${game}"`));assert.match(response.raw,/id="native-game"/);
  assert.doesNotMatch(response.raw,/id="(?:home|games|game-panel|balance|mute|voice)"|\/demo\/host\.mjs/);
 }
 assert.equal(calls.length,0);assert.match(web.raw,/12,000 测试币/);
 assert.equal((await send('/demo/native/match',{method:'HEAD'})).raw,'');
 assert.match((await send('/demo/native-game-host.css')).raw,/height:100dvh/);
 assert.match((await send('/demo/native-game-host.css')).raw,/overflow:hidden/);
 assert.equal((await send('/demo/native-return')).status,200);
});

test('native routes reject unknown/encoded paths, methods, Host and Origin without creating sessions',async t=>{
 const {send,calls}=await serverFixture(t);
 for(const url of ['/demo/native/unknown','/demo/native/MATCH','/demo/native/match/','/demo/native/%6datch','/demo/native/../private.env','/demo/native/','/demo/native-match'])assert.equal((await send(url)).status,404,url);
 assert.equal((await send('/demo/native/match',{method:'POST'})).status,404);
 assert.equal((await send('/demo/native/match',{headers:{host:'evil.test'}})).status,403);
 assert.equal((await send('/demo/native/match',{headers:{origin:'https://evil.test'}})).status,403);
 assert.equal(calls.length,0);
});

test('native launch uses the existing secure guest cookie and CSRF boundary',async t=>{
 const {send,calls}=await serverFixture(t),config=await send('/api/demo/config'),body=JSON.parse(config.raw);
 const cookie=config.headers['set-cookie'][0].split(';')[0];
 assert.ok(cookie.startsWith(COOKIE+'='));assert.match(config.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Lax/);
 const launch=token=>send('/api/demo/launch',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-host-csrf':token},body:JSON.stringify({game_id:'tiger',request_id:'native_fixture_123'})});
 assert.equal((await launch('invalid')).status,403);assert.equal(calls.length,0);
 assert.equal((await launch(body.csrf)).status,200);assert.equal(calls.length,1);
 assert.match(calls[0].guest,/^guest_[a-f0-9]{32}$/);assert.equal(calls[0].body.game_id,'tiger');
});

function controllerFixture({game='match',fetch:fetchOverride}={}){
 const calls=[],navigations=[],events=new Map(),elements=new Map();
 for(const name of ['native-game','native-status','native-status-title','native-status-message','native-back'])elements.set('#'+name,{hidden:false,dataset:{},attributes:{},listeners:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){this.listeners[k]=v;}});
 const document={body:{dataset:{game}},querySelector:s=>elements.get(s)};
 const window={location:{origin,pathname:'/demo/native/'+game},crypto:{randomUUID},addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
 class SDK{
  constructor(options){this.options=options;this.loaded=false;this.closed=false;this.backCalls=0;SDK.instance=this;}
  async mount(container){this.container=container;this.launch=await this.options.requestLaunch({gameId:game});}
  requestBack(){this.backCalls++;}
  emit(type,detail={}){if(type==='loaded')this.loaded=true;this.options.onEvent({type,...detail});}
  destroy(){this.closed=true;this.options.onEvent({type:'destroyed'});}
 }
 const fetch=async(url,options)=>{calls.push({url,options});if(fetchOverride)return fetchOverride(url,options);return{ok:true,status:200,json:async()=>url.endsWith('/config')?{platform_origin:origin,csrf}:{session_id:'session_fixture',entry_url:origin+'/play/'+game,launch_code:'fixture_code_123'}};};
 const controller=createNativeGameHost({window,document,OasisHost:SDK,fetch,navigate:url=>navigations.push(url)});
 return{controller,window,document,calls,navigations,elements,SDK,events};
}

test('native startup performs only config and launch, passes CSRF, mounts once, and exposes only requestBack',async()=>{
 const f=controllerFixture();await Promise.all([f.controller.start(),f.controller.start()]);
 assert.deepEqual(f.calls.map(x=>x.url),['/api/demo/config','/api/demo/launch']);
 assert.deepEqual(Object.keys(f.window.OasisNativeHost),['requestBack']);assert.ok(Object.isFrozen(f.window.OasisNativeHost));
 assert.equal(f.SDK.instance.container,f.elements.get('#native-game'));
 const request=f.calls[1].options;assert.equal(request.credentials,'same-origin');assert.equal(request.headers['x-host-csrf'],csrf);
 assert.deepEqual(Object.keys(JSON.parse(request.body)).sort(),['game_id','request_id']);
 assert.equal(f.elements.get('#native-status').hidden,false);f.SDK.instance.emit('loaded');assert.equal(f.elements.get('#native-status').hidden,true);
 f.controller.dispose();
});

test('loaded Android back sends SDK back and does not navigate until game confirms; cancellation leaves frame intact',async()=>{
 const f=controllerFixture();await f.controller.start();f.SDK.instance.emit('loaded');
 assert.equal(f.window.OasisNativeHost.requestBack(),true);assert.equal(f.SDK.instance.backCalls,1);
 assert.deepEqual(f.navigations,[]);assert.equal(f.SDK.instance.closed,false);
 // Cancel is handled inside the game: no return_requested event is produced.
 f.window.OasisNativeHost.requestBack();assert.equal(f.SDK.instance.backCalls,2);
 f.SDK.instance.emit('return_requested',{room_id:'untrusted',return_url:'https://evil.test'});
 assert.deepEqual(f.navigations,[origin+'/demo/native-return']);assert.equal(f.SDK.instance.closed,true);
 f.SDK.instance.emit('return_requested');assert.equal(f.navigations.length,1);
});

test('back during pending loading aborts startup and returns to the fixed native endpoint',async()=>{
 const f=controllerFixture({fetch:(_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
 const pending=f.controller.start();f.window.OasisNativeHost.requestBack();await pending;
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.SDK.instance,undefined);
 assert.deepEqual(f.navigations,[origin+'/demo/native-return']);
});

test('error state permits return and never displays raw error or credential contents',async()=>{
 const f=controllerFixture({fetch:async()=>{throw new Error('private_token_do_not_render');}});await f.controller.start();
 assert.equal(f.elements.get('#native-status').dataset.state,'error');
 assert.doesNotMatch([...f.elements.values()].map(e=>e.textContent).join(' '),/private_token/);
 f.elements.get('#native-back').listeners.click();assert.deepEqual(f.navigations,[origin+'/demo/native-return']);
});

test('an error after loading still follows game confirmation and reveals the game confirmation UI',async()=>{
 const f=controllerFixture();await f.controller.start();f.SDK.instance.emit('loaded');f.SDK.instance.emit('error',{message:'ignored'});
 assert.equal(f.elements.get('#native-status').hidden,false);f.elements.get('#native-back').listeners.click();
 assert.equal(f.SDK.instance.backCalls,1);assert.equal(f.elements.get('#native-status').hidden,true);assert.deepEqual(f.navigations,[]);
 f.controller.dispose();
});

test('configuration cannot redirect launch to another origin or supply an invalid CSRF',async()=>{
 for(const config of [{platform_origin:'https://evil.test',csrf},{platform_origin:origin,csrf:'bad'}]){
  const f=controllerFixture({fetch:async()=>({ok:true,json:async()=>config})});await f.controller.start();
  assert.equal(f.calls.length,1);assert.equal(f.SDK.instance,undefined);assert.equal(f.elements.get('#native-status').dataset.state,'error');f.controller.dispose();
 }
});

test('launch transport retry preserves the request id and reauthorization preserves original session binding',async()=>{
 let attempts=0;
 const f=controllerFixture({fetch:async url=>{
  if(url.endsWith('/config'))return{ok:true,json:async()=>({platform_origin:origin,csrf})};
  if(++attempts===1)throw new Error('network');
  return{ok:true,json:async()=>({session_id:'session_original',entry_url:origin+'/play/match',launch_code:'fixture_code_123'})};
 }});await f.controller.start();
 assert.equal(f.calls[1].options.body,f.calls[2].options.body);
 await f.SDK.instance.options.requestLaunch({gameId:'match',resumeSessionId:'session_original'});
 assert.equal(JSON.parse(f.calls.at(-1).options.body).resume_session_id,'session_original');
 await assert.rejects(f.SDK.instance.options.requestLaunch({gameId:'tiger'}),/changed/);f.controller.dispose();
});

test('authorization rejection is not retried and pagehide destroys the host',async()=>{
 const f=controllerFixture({fetch:async url=>url.endsWith('/config')?{ok:true,json:async()=>({platform_origin:origin,csrf})}:{ok:false,status:403,json:async()=>({error:{code:'CSRF_REJECTED'}})}});
 await f.controller.start();assert.equal(f.calls.length,2);assert.equal(f.elements.get('#native-status').dataset.state,'error');
 f.events.get('pagehide')();assert.equal(f.SDK.instance.closed,true);assert.equal(f.events.has('pagehide'),false);
});
