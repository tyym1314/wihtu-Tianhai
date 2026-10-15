/** Pure observation-order fixtures. No device, HTTP, DB or paid mutation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {playOneProbabilityCycle} from '../scripts/android-game-actions.mjs';

function fixture({delivery='after-wait',requestMutation=()=>{},pendingRequestId='request_original',roundId='round_original',settlement='SETTLED',timeoutMs=5000}={}){
 const state={game:'tiger',sessionId:'session_original',playerId:'player_original',spins:[],acks:new Set(),probabilityRequests:[]};
 let clock=0,reads=0,drains=0,current={pendingRound:null,freeSpins:0,betChoices:[1000],balance:10000};
 const taps=[],waits=[];
 const delivered=()=>{if(state.spins.length)return;state.probabilityRequests[0].status=200;state.spins.push({id:roundId,cycleId:'cycle_original',status:settlement,isFreeSpin:false});};
 const frame={locator:selector=>({selector,waitFor:async()=>{},isVisible:async()=>selector==='#continue'&&!!current.pendingRound&&state.spins.some(s=>s.id===current.pendingRound.id),isEnabled:async()=>true})};
 const options={state,timeoutMs,now:()=>clock,assertSession:s=>s,beforeAction:async()=>{},tap:async target=>{
  taps.push(target.selector);
  if(target.selector==='#spin'){
   const request={type:'spin',request_id:'request_original',path:'/api/play/tiger/spin',method:'POST',game_frame_request:true,phase:'playing',session_id:state.sessionId,player_id:state.playerId,status:null};
   state.probabilityRequests.push(request);requestMutation(request,state);
   current={...current,pendingRound:{id:'round_original',requestId:pendingRequestId}};
  }else if(target.selector==='#continue'){
   state.acks.add(current.pendingRound.id);current={...current,pendingRound:null};
  }
 },readSession:async()=>{reads++;return current;},drain:async()=>{drains++;if(delivery==='after-read'&&reads===2)delivered();},wait:async ms=>{waits.push(ms);clock+=ms;if(delivery==='after-wait')delivered();}};
 return{state,frame,options,taps,waits,get clock(){return clock;},get drains(){return drains;}};
}

test('session commit before the original spin body waits, then observes one UI cycle and exact ACK',async()=>{
 const f=fixture(),result=await playOneProbabilityCycle(f.frame,'tiger',f.options);
 assert.equal(result.cycleId,'cycle_original');assert.equal(result.matchingAcks,1);assert.equal(result.finalSession.pendingRound,null);
 assert.equal(f.taps.filter(t=>t==='#spin').length,1);assert.equal(f.taps.filter(t=>t==='#continue').length,1);
 assert.equal(f.waits[0],1000);assert.equal(f.state.probabilityRequests.length,1);
});

test('a body delivered during session read is drained before checking the pending round',async()=>{
 const f=fixture({delivery:'after-read'}),result=await playOneProbabilityCycle(f.frame,'tiger',f.options);
 assert.equal(result.spins,1);assert.equal(f.waits.length,1);assert.equal(f.taps.filter(t=>t==='#spin').length,1);
 // The sole wait follows the visible presentation close; no observation wait.
 assert.equal(f.drains,5);
});

test('unknown pending request and an original body for a different round remain rejected',async()=>{
 for(const settings of [{pendingRequestId:'request_unknown'},{roundId:'round_other'}]){
  const f=fixture(settings);await assert.rejects(playOneProbabilityCycle(f.frame,'tiger',f.options),/UNOBSERVED_PROBABILITY_PRESENTATION_PRESERVED/);
  assert.equal(f.taps.filter(t=>t==='#spin').length,1);assert.equal(f.taps.includes('#continue'),false);assert.equal(f.state.acks.size,0);
 }
});

test('a transport failure or non-200 original response cannot qualify as a presentation',async()=>{
 for(const requestMutation of [p=>p.transport_error='failed',p=>p.status=503]){
  const f=fixture({delivery:'never',requestMutation});await assert.rejects(playOneProbabilityCycle(f.frame,'tiger',f.options),/UNOBSERVED_PROBABILITY_PRESENTATION_PRESERVED/);
  assert.equal(f.waits.length,0);assert.equal(f.taps.includes('#continue'),false);
 }
});

test('a still pending original response uses the original deadline and never sends a second paid spin',async()=>{
 const f=fixture({delivery:'never',timeoutMs:1000});await assert.rejects(playOneProbabilityCycle(f.frame,'tiger',f.options),/ORIGINAL_PROBABILITY_CYCLE_DEADLINE/);
 assert.equal(f.clock,1000);assert.equal(f.taps.filter(t=>t==='#spin').length,1);assert.equal(f.state.spins.length,0);assert.equal(f.state.acks.size,0);
});

test('a non-settled original body does not pass even after a presentation ACK',async()=>{
 const f=fixture({settlement:'PENDING',timeoutMs:3000});await assert.rejects(playOneProbabilityCycle(f.frame,'tiger',f.options),/ORIGINAL_PROBABILITY_CYCLE_DEADLINE/);
 assert.equal(f.clock,3000);assert.equal(f.taps.filter(t=>t==='#spin').length,1);
});

test('waiting requires a unique original request from the exact owned game, player and session',async()=>{
 for(const requestMutation of [p=>p.game_frame_request=false,p=>p.session_id='other',p=>p.player_id='other',p=>p.path='/api/play/thunder/spin',p=>p.method='GET',p=>p.phase='cleanup',(p,s)=>s.probabilityRequests.push({...p})]){
  const f=fixture({delivery:'never',requestMutation});await assert.rejects(playOneProbabilityCycle(f.frame,'tiger',f.options),/UNOBSERVED_PROBABILITY_PRESENTATION_PRESERVED/);
  assert.equal(f.waits.length,0);assert.equal(f.taps.includes('#continue'),false);
 }
});
