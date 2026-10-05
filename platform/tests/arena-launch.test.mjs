import test from 'node:test';
import assert from 'node:assert/strict';

test('first launch reads one session; reauthorization shares one fresh session and retains recovery',async()=>{
 const saved=Object.fromEntries(['window','document','location','fetch'].map(k=>[k,globalThis[k]]));
 const window=new EventTarget(),posted=[],reads=[],authorized=[];
 const host={postMessage:(data,origin)=>posted.push({data,origin})};window.parent=host;window.opener=null;
 globalThis.window=window;globalThis.document={documentElement:{style:{setProperty(){}}}};globalThis.location={origin:'https://host.test'};
 let round=0,releaseSession,sessionPending=false;const sessionGate=new Promise(resolve=>releaseSession=resolve);
 globalThis.fetch=async(path,options)=>{
  reads.push(path);
  if(path==='/v1/launch/exchange'){round++;return Response.json({access_token:'fixture_token_'+round,game_id:'run',host_origin:'https://host.test',session_id:'fixture_session'});}
  if(path==='/api/arena/session'){if(round===2){sessionPending=true;await sessionGate;}return Response.json({game_id:'run',external_user_id:'fixture_user',balance:{balance:{available_minor:String(round*100)}},active_room_id:round===2?'restored_room':null});}
  if(path==='/api/pvp/rooms'&&options.method==='POST'){assert.equal(options.headers.Authorization,'Bearer fixture_token_2');return Response.json({id:'new_room'});}
  assert.equal(options.headers.Authorization,'Bearer fixture_token_1');return Response.json({error:{code:'SESSION_EXPIRED'}},{status:401});
 };
 const flush=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(setImmediate);assert(predicate(),'expected asynchronous host state');};
 const dispatch=(data,source=host,origin='https://host.test')=>{const e=new Event('message');Object.assign(e,{data,source,origin});window.dispatchEvent(e);};
 try{
  const client=await import('../arena/shared/client.mjs?launch-test='+Date.now());
  window.addEventListener('oasis:authorized',e=>authorized.push(e.detail));
  const launched=client.waitForLaunch('run');const ready=posted.find(p=>p.data.type==='oasis.ready').data;
  const body={...ready,type:'oasis.launch',launch_code:'fixture_launch_code'};
  dispatch(body);const first=await launched;await flush(()=>posted.some(p=>p.data.type==='oasis.loaded'));
  assert.equal(first.balance.balance.available_minor,'100');assert.deepEqual(reads,['/v1/launch/exchange','/api/arena/session']);assert.equal(authorized.length,0);
  await assert.rejects(client.api('/protected'),{status:401});assert(posted.some(p=>p.data.type==='oasis.reauth_required'));
  dispatch({...body,launch_code:'fixture_reauth_code'});await flush(()=>sessionPending);
  const readCount=reads.length;await assert.rejects(client.api('/api/pvp/rooms',{request_id:'old_ui_request'}),{code:'SESSION_CHANGED'});await assert.rejects(client.api('/api/pvp/rooms/old_room'),{code:'SESSION_CHANGED'});assert.equal(reads.length,readCount,'unverified new identity must not receive old UI actions or polls');
  releaseSession();await flush(()=>authorized.length===1);await client.api('/api/pvp/rooms',{request_id:'verified_context_request'});
  assert.equal(authorized[0].context.active_room_id,'restored_room');assert.equal(authorized[0].context.balance.balance.available_minor,'200');
  assert.equal(reads.filter(p=>p==='/api/arena/session').length,2);
  dispatch(body,{},'https://host.test');dispatch(body,host,'https://other.test');await new Promise(setImmediate);assert.equal(round,2);
 }finally{window.dispatchEvent(new Event('pagehide'));for(const[k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});
