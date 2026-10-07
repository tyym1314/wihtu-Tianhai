import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameHostBridge} from '../legacy/host-bridge.mjs';

test('return dispatch reports unavailable, reauth, disposed and throwing hosts without claiming an ACK',async()=>{
 const names=['window','document','location'],saved=Object.fromEntries(names.map(k=>[k,globalThis[k]]));
 const window=new EventTarget(),posted=[];let throwing=false;
 const host={postMessage(data,origin){if(throwing)throw new Error('Fixture closed host');posted.push({data,origin});}};
 window.parent=host;globalThis.window=window;globalThis.location={origin:'https://fixture.test'};
 globalThis.document={documentElement:{style:{setProperty(){}}}};
 let bridge;
 const launch=async()=>{const ready=posted.find(x=>x.data.type==='oasis.ready').data,e=new Event('message');Object.assign(e,{source:host,origin:'https://fixture.test',data:{...ready,type:'oasis.launch',launch_code:'fixture-code'}});window.dispatchEvent(e);for(let n=0;n<10&&bridge.phase!=='loaded';n++)await new Promise(setImmediate);assert.equal(bridge.phase,'loaded');};
 try{
  bridge=createGameHostBridge({game:'run',onLaunch:async()=>({host_origin:'https://fixture.test',game_id:'run'})});
  assert.equal(bridge.completeReturn(),false);await launch();
  assert.equal(bridge.completeReturn({room_id:'room-test',status:'cancelled'}),true);
  assert.equal(posted.at(-1).data.type,'oasis.return_requested');assert.equal(posted.at(-1).origin,'https://fixture.test');assert.equal(bridge.phase,'loaded','Dispatch is not an acknowledged navigation');
  throwing=true;assert.equal(bridge.completeReturn(),false);throwing=false;
  assert.equal(bridge.completeReturn(),true,'A transient post failure does not permanently disable return');
  assert.equal(bridge.requestReauth(),true);assert.equal(bridge.completeReturn(),false);await launch();assert.equal(bridge.completeReturn(),true);
  bridge.dispose();assert.equal(bridge.completeReturn(),false);
 }finally{bridge?.dispose();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
