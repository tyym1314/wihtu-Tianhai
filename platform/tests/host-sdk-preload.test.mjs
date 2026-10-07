import test from 'node:test';
import assert from 'node:assert/strict';
import {OasisHost} from '../public/sdk/oasis-h5.mjs';

const platformOrigin='https://games.example';
const nonce='fixture_ready_nonce_12345678';
const launch={entry_url:platformOrigin+'/play/run',session_id:'fixture_session',launch_code:'fixture_one_use_code'};

function deferred(){
 let resolve,reject;
 const promise=new Promise((accept,deny)=>{resolve=accept;reject=deny;});
 return{promise,resolve,reject};
}

function fixture(requestLaunch){
 const previousWindow=globalThis.window,previousDocument=globalThis.document;
 const messages=[],events=[],windowListeners=new Map(),documentListeners=new Map();
 const target={postMessage:(message,origin)=>messages.push({message,origin})};
 const frame={contentWindow:target,style:{},setAttribute(){},remove(){this.removed=true;}};
 globalThis.window={addEventListener:(type,listener)=>windowListeners.set(type,listener),removeEventListener:type=>windowListeners.delete(type)};
 globalThis.document={hidden:false,createElement:()=>frame,addEventListener:(type,listener)=>documentListeners.set(type,listener),removeEventListener:type=>documentListeners.delete(type)};
 const host=new OasisHost({platformOrigin,gameId:'run',requestLaunch,onEvent:event=>events.push(event)});
 const ready=(overrides={})=>host.receive({source:target,origin:platformOrigin,data:{type:'oasis.ready',protocol_version:1,game_id:'run',bridge_nonce:nonce},...overrides});
 return{host,frame,target,messages,events,windowListeners,documentListeners,ready,
  mount:()=>host.mount({append(){}}),
  cleanup(){host.destroy();if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}};
}

test('static game loads while authorization is pending, then the validated early handshake receives one code',async()=>{
 const pending=deferred(),calls=[],state=fixture(input=>{calls.push(input);return pending.promise;});
 try{
  const mounting=state.mount();
  assert.equal(state.frame.src,platformOrigin+'/play/run');
  assert.deepEqual(calls,[{gameId:'run'}]);
  state.ready({source:{}});state.ready({origin:'https://other.example'});
  assert.equal(state.host.nonce,undefined);
  state.ready();state.ready();
  assert.deepEqual(state.messages,[]);
  pending.resolve(launch);await mounting;
  assert.equal(state.messages.length,1);
  assert.equal(state.messages[0].origin,platformOrigin);
  assert.equal(state.messages[0].message.bridge_nonce,nonce);
  assert.equal(state.messages[0].message.launch_code,launch.launch_code);
  assert.equal(state.host.code,'');
  state.ready();assert.equal(state.messages.length,1);
 }finally{state.cleanup();}
});

test('authorization that arrives before the static game still waits for the correct ready nonce',async()=>{
 const state=fixture(async()=>launch);
 try{
  await state.mount();assert.deepEqual(state.messages,[]);
  state.ready({data:{type:'oasis.ready',protocol_version:1,game_id:'run',bridge_nonce:'short'}});
  assert.deepEqual(state.messages,[]);
  state.ready();assert.equal(state.messages.length,1);
 }finally{state.cleanup();}
});

test('rejected or mismatched launch responses remove the preload without sending a credential',async()=>{
 for(const requestLaunch of [async()=>{throw Error('Authorization denied');},async()=>({...launch,entry_url:'https://other.example/play/run'}),async()=>({...launch,entry_url:platformOrigin+'/play/tiger'})]){
  const state=fixture(requestLaunch);
  try{
   const mounting=state.mount();state.ready();await assert.rejects(mounting);
   assert.deepEqual(state.messages,[]);assert.equal(state.frame.removed,true);
   assert.equal(state.windowListeners.size,0);assert.equal(state.documentListeners.size,0);
  }finally{state.cleanup();}
 }
});

test('closing a pending preload prevents late authorization from reaching a detached frame',async()=>{
 const pending=deferred(),state=fixture(()=>pending.promise);
 try{
  const mounting=state.mount();state.ready();state.host.destroy();pending.resolve(launch);await mounting;
  assert.equal(state.frame.removed,true);assert.deepEqual(state.messages,[]);
  assert.equal(state.host.code,'');
 }finally{state.cleanup();}
});
