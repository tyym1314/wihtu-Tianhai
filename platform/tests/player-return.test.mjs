import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerBackBridge,requestPlayerGameBack} from '../src/pages/PlayerClient.mjs';

function windowFixture(changes={}){
 const window={location:{origin:'https://player.example.invalid',pathname:'/player',search:'?app_id=app_one',hash:'',...changes}};window.top=window;return window;
}
test('native presentation bridge returns a synchronous boolean and binds exact HTTPS origin, App, query, path and top frame',()=>{
 let calls=0;const window=windowFixture(),bridge=createPlayerBackBridge({appId:'app_one',origin:window.location.origin,window,requestBack:()=>{calls++;return true;}});
 assert.equal(bridge.requestBack(),true);assert.equal(calls,1);
 const changes=[{origin:'https://foreign.example.invalid'},{origin:'http://player.example.invalid'},{pathname:'/demo/native/run'},{pathname:'/player/'},{search:'?app_id=other_app'},{search:'?app_id=app_one&app_id=app_one'},{search:'?app_id=app_one&token=secret'},{search:'?app_id=%61pp_one'},{hash:'#return'}];
 for(const change of changes){Object.assign(window.location,windowFixture().location,change);assert.equal(bridge.requestBack(),false);}
 Object.assign(window.location,windowFixture().location);window.top={};assert.equal(bridge.requestBack(),false);assert.equal(calls,1);
});
test('lobby returns false and only a true handler result delegates native close',()=>{
 for(const result of [false,undefined,null,1,Promise.resolve(true)]){
  const window=windowFixture(),bridge=createPlayerBackBridge({appId:'app_one',origin:window.location.origin,window,requestBack:()=>result});
  assert.equal(bridge.requestBack(),false);
 }
});
test('loaded host receives existing SDK requestBack; UI return waits for authority event',()=>{
 let messages=0,returns=0,blocked=0;
 requestPlayerGameBack({host:{loaded:true,closed:false,requestBack(){messages++;}},pending:false,accepted:true,onReturn:()=>returns++,onBlocked:()=>blocked++});
 assert.equal(messages,1);assert.equal(returns,0);assert.equal(blocked,0);
});
test('pending launch or known accepted session cannot discard the game before authority return',()=>{
 for(const scenario of [{pending:true,accepted:false},{pending:false,accepted:true},{pending:true,accepted:true}]){
  let returns=0,blocked=0;
  requestPlayerGameBack({...scenario,host:{loaded:false,closed:true},onReturn:()=>returns++,onBlocked:()=>blocked++});
  assert.equal(returns,0);assert.equal(blocked,1);
 }
 let returns=0;requestPlayerGameBack({host:null,pending:false,accepted:false,onReturn:()=>returns++,onBlocked:()=>assert.fail('No accepted obligation')});assert.equal(returns,1);
});
