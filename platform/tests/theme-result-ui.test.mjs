import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';

let dir,render,present;
before(async()=>{
 dir=await mkdtemp(resolve(tmpdir(),'oasis-theme-result-'));
 const outfile=resolve(dir,'render.cjs');
 await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import ThemeResult from './arena/shared/ThemeResult.jsx';
 import useResultPresentation from './arena/shared/useResultPresentation.jsx';
 function freeze(o){if(o&&typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o);}return o;}
 function isolated(input,fn){const room=freeze(input),saved=JSON.stringify(room),originalFetch=globalThis.fetch;let requests=0,commands=0;
  globalThis.fetch=()=>{requests++;throw Error('Result rendering must never request wallet or network');};
  try{const value=fn(room,()=>{commands++;});return{...value,unchanged:saved===JSON.stringify(room),requests,commands};}finally{globalThis.fetch=originalFetch;}}
 export function render(input,game='carrom',meId='a'){return isolated(input,(room,onAgain)=>({html:renderToStaticMarkup(<ThemeResult game={game} room={room} meId={meId} meta={{scoreUnit:'SCORE'}} onAgain={onAgain} onRetryTraining={game==='towerlink'&&room.game?.training?onAgain:undefined} onNextTraining={game==='towerlink'&&room.game?.training?.completed&&room.game.training.nextLessonId?onAgain:undefined}/>)}));}
 export function present(input){return isolated(input,room=>{let result;function Probe(){result=useResultPresentation(room);return null;}renderToStaticMarkup(<Probe/>);return{presenting:result.presenting,sameRoom:result.presentationRoom===room,room:result.presentationRoom,revealIsFunction:typeof result.reveal==='function'};});}
 `,resolveDir:resolve(import.meta.dirname,'..'),loader:'jsx'},bundle:true,jsx:'automatic',platform:'node',format:'cjs',outfile,loader:{'.css':'empty','.png':'file','.webp':'file','.svg':'file','.glb':'file'},logLevel:'silent'});
 ({render,present}=createRequire(import.meta.url)(outfile));
});
after(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
const player=(id,seat,rank,payout,extra={})=>({external_user_id:id,name:id.toUpperCase(),seat_index:seat,rank,score:7-seat,payout_minor:String(payout),forfeited:false,...extra});
function room(overrides={}){return{id:'result_fixture',game_id:'carrom',status:'settled',practice:false,team_size:1,entry_minor:'10000',prize_minor:'19000',server_now:1700000000000,players:[player('a',0,1,19000),player('b',1,2,0)],result:{resolution:'completed',fee_minor:'1000'},...overrides};}
const text=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function panel(html,name){return html.match(new RegExp(`<div class="${name}">([\\s\\S]*?)<\\/div>`))?.[1]||'';}
function safe(result){assert.equal(result.unchanged,true,'must not mutate frozen room');assert.equal(result.requests,0,'must not fetch wallet or network');assert.equal(result.commands,0,'must not invoke play-again during render');return result.html;}

test('settled winner displays confirmed gross payout in major coins and preserves frozen minor amounts',()=>{
 const r=render(room());const html=safe(r);assert.match(html,/<h1>VICTORY<\/h1>/);assert.match(text(panel(html,'result-reward-panel')),/本局获得.*含入场本金.*190/);assert.doesNotMatch(panel(html,'result-reward-panel'),/19,000/);assert.match(html,/奖励已到账/);assert.match(html,/class="result-play-again"/);assert.match(html,/服务费：10 金币/);assert.doesNotMatch(html,/settlement-wait/);
});
test('fractional payout is formatted once from integer minor units',()=>{
 const html=safe(render(room({prize_minor:'19095',players:[player('a',0,1,19095),player('b',1,2,0)],result:{resolution:'completed',fee_minor:'1005'}})));assert.match(text(panel(html,'result-reward-panel')),/190\.95/);assert.match(html,/服务费：10\.05 金币/);assert.doesNotMatch(html,/19,095/);
});
test('settling winner shows pending payout, never a received-wallet assertion or replay control',()=>{
 const html=safe(render(room({status:'settling'})));assert.match(html,/待到账奖励/);assert.match(html,/结果已锁定，正在确认钱包到账/);assert.match(html,/settlement-wait/);assert.doesNotMatch(html,/奖励已到账|class="result-play-again"/);
});
test('settled loser cannot receive victory heading, winner confetti or winner cash statement',()=>{
 const html=safe(render(room(),'carrom','b'));assert.match(html,/<h1>WELL PLAYED<\/h1>/);assert.doesNotMatch(html,/result-is-winner|result-confetti|<h1>VICTORY|奖励已到账/);assert.match(text(panel(html,'result-reward-panel')),/本局获得.*0/);assert.match(html,/结果已确认/);
});
test('forfeited participant is not promoted to a displayed placement',()=>{
 const html=safe(render(room({players:[player('a',0,null,0,{forfeited:true}),player('b',1,1,19000)]})));assert.match(html,/<h1>WELL PLAYED<\/h1>/);assert.match(html,/已弃权/);assert.match(html,/<b>—<\/b>/);assert.doesNotMatch(html,/result-is-winner/);
});
test('practice has no reward panel, coin allocation or received-wallet claim, even if stale amounts are passed',()=>{
 const html=safe(render(room({practice:true,team_size:2,players:[player('a',0,1,9500,{team_id:'team_a'}),player('b',1,2,0,{team_id:'team_b'}),player('c',2,1,9500,{team_id:'team_a'}),player('d',3,2,0,{team_id:'team_b'})]}),'jackaroo'));assert.match(html,/练习已完成 · 无金币变化/);assert.doesNotMatch(html,/result-reward-panel|result-team-note|奖励已到账|A：95 金币|C：95 金币/);
});
test('winning team displays full team allocation and the viewer own share separately',()=>{
 const html=safe(render(room({team_size:2,prize_minor:'38000',players:[player('a',0,1,19000,{team_id:'team_a'}),player('b',1,2,0,{team_id:'team_b'}),player('c',2,1,19000,{team_id:'team_a'}),player('d',3,2,0,{team_id:'team_b'})]}),'jackaroo'));assert.match(text(panel(html,'result-reward-panel')),/190/);assert.match(text(panel(html,'result-team-note')),/380/);assert.match(html,/搭档同心/);
});
test('tied teams show this team allocation instead of claiming the entire pool is split between two partners',()=>{
 const html=safe(render(room({team_size:2,prize_minor:'38000',players:['a','b','c','d'].map((id,i)=>player(id,i,1,9500,{team_id:i%2?'team_b':'team_a'}))}),'jackaroo'));assert.match(text(panel(html,'result-reward-panel')),/95/);const note=text(panel(html,'result-team-note'));assert.match(note,/190/,'this team receives 95+95, not all 380');assert.doesNotMatch(note,/胜队奖池\s*380/);
});
test('team summary sums actual personal payouts including deterministic one-minor-unit remainder',()=>{
 const html=safe(render(room({team_size:2,prize_minor:'38001',players:[player('a',0,1,19001,{team_id:'team_a'}),player('b',1,2,0,{team_id:'team_b'}),player('c',2,1,19000,{team_id:'team_a'}),player('d',3,2,0,{team_id:'team_b'})]}),'jackaroo'));assert.match(text(panel(html,'result-reward-panel')),/190\.01/);assert.match(text(panel(html,'result-team-note')),/380\.01/);assert.match(html,/C：190 金币/);
});
test('losing teammate sees neither winning-team allocation nor victory despite another team rank one',()=>{
 const html=safe(render(room({team_size:2,prize_minor:'38000',players:[player('a',0,2,0,{team_id:'team_a'}),player('b',1,1,19000,{team_id:'team_b'}),player('c',2,2,0,{team_id:'team_a'}),player('d',3,1,19000,{team_id:'team_b'})]}),'jackaroo'));assert.match(html,/<h1>WELL PLAYED<\/h1>/);assert.doesNotMatch(html,/result-is-winner|result-confetti|result-team-note|奖励已到账/);
});
test('individual tie remains a tie and every actual share keeps its own minor-unit remainder',()=>{
 const html=safe(render(room({prize_minor:'19001',players:[player('a',0,1,9501),player('b',1,1,9500)]}),'domino'));assert.match(html,/并列冠军/);assert.match(text(panel(html,'result-reward-panel')),/95\.01/);assert.match(html,/B：95 金币/);assert.doesNotMatch(html,/result-team-note/);
});
test('cancelled room has no winner, pending reward or confirmed prize and may open another game',()=>{
 const html=safe(render(room({status:'cancelled',result:null,players:[player('a',0,null,0),player('b',1,null,0)]})));assert.match(html,/<h1>CANCELLED<\/h1>/);assert.match(html,/已释放预留金币，没有收取服务费/);assert.match(html,/result-play-again/);assert.doesNotMatch(html,/result-is-winner|result-confetti|result-reward-panel|待到账奖励|奖励已到账/);
});
test('cancelled no-contest roster does not fabricate positions from array order',()=>{
 const html=safe(render(room({status:'cancelled',result:null,players:[player('a',0,null,0),player('b',1,null,0)]})));const ranking=panel(html,'result-finish-ranking');assert.doesNotMatch(ranking,/<b>[1-9]\d*<\/b>/,'no official ranks exist for cancelled players');
});
test('voided paid room shows each original entry returned without a fee or winner celebration',()=>{
 const html=safe(render(room({status:'voided',result:{resolution:'void',fee_minor:'0'},players:[player('a',0,null,10000),player('b',1,null,10000)]})));assert.match(html,/<h1>FAIR PLAY<\/h1>/);assert.match(text(panel(html,'result-reward-panel')),/退回入场.*无服务费.*100/);assert.match(html,/已退回入场金币，没有收取服务费/);assert.doesNotMatch(html,/result-is-winner|result-confetti|VICTORY|奖励已到账/);assert.match(html,/result-play-again/);
});
test('voiding with a frozen refund plan must not claim funds already returned before wallet confirmation',()=>{
 const html=safe(render(room({status:'voiding',result:{resolution:'void',fee_minor:'0'},players:[player('a',0,null,10000),player('b',1,null,10000)]})));assert.match(html,/settlement-wait/);assert.doesNotMatch(html,/已退回|已到账|result-play-again/,'refund result is still unknown');assert.match(html,/确认|处理中|待退/);
});
for(const game of ['carrom','match','golf','darts','ludo','pool','bowling','jackaroo','domino','run','towerlink'])test(`${game} result theme remains pure with a deeply frozen server room`,()=>{
 const html=safe(render(room(),game));assert.match(html,new RegExp(`result-${game}`));assert.match(html,/<h1>VICTORY<\/h1>/);
});
test('Tower Link two-player draw shows both official winners and their own confirmed payouts',()=>{
 const html=safe(render(room({game_id:'towerlink',players:[player('a',0,1,9500,{score:8}),player('b',1,1,9500,{score:8})]}),'towerlink'));
 assert.match(html,/并列冠军/);assert.match(html,/result-finish-ranking/);
 assert.equal((html.match(/class="result-player-portrait/g)||[]).length,2);
 assert.match(text(panel(html,'result-reward-panel')),/95/);
 assert.doesNotMatch(html,/background-position:-25%|undefined/);
});
for(const status of ['voiding','voided'])test(`Tower Link genuine draw ${status} is a draw with fee-free principal return, not a fault`,()=>{
 const html=safe(render(room({game_id:'towerlink',status,players:[player('a',0,1,10000,{score:3}),player('b',1,1,10000,{score:3})],result:{resolution:'void',reason:'tied_game',fee_minor:'0',rankings:[{playerKey:'a',totalTroops:40},{playerKey:'b',totalTroops:40}]}}),'towerlink'));
 assert.match(html,/<h1>DRAW<\/h1>/);assert.match(html,/平局/);assert.match(html,/不收服务费/);assert.match(html,/40 总兵力/);assert.doesNotMatch(html,/本局作废|FAIR PLAY|VICTORY|result-confetti|奖励已到账/);
 if(status==='voiding'){assert.match(html,/本金返还确认中/);assert.doesNotMatch(html,/本金已退回|本金已全额退回|result-play-again/);}else{assert.match(html,/本金已退回/);assert.match(html,/result-play-again/);}
});
test('Tower Link real friend entertainment remains distinct from AI practice and displays no wallet credit',()=>{
 const html=safe(render(room({game_id:'towerlink',room_mode:'social',entry_minor:'0',prize_minor:'0',players:[player('a',0,1,0),player('b',1,2,0)],result:{resolution:'completed',fee_minor:'0'}}),'towerlink'));
 assert.match(html,/真人好友娱乐 · 无入场费与奖金/);assert.match(html,/本局没有金币变化/);assert.doesNotMatch(html,/练习已完成|result-reward-panel|奖励已到账|待到账奖励|A：0 金币/);
});
test('Tower Link completed training shows a real next-lesson and retry action without coin awards',()=>{
 const html=safe(render(room({game_id:'towerlink',practice:true,entry_minor:'0',game:{training:{lessonId:'lesson-01',title:'初识兵营',objective:'占领中立塔',completed:true,failed:false,nextLessonId:'lesson-02'}},players:[player('a',0,1,0),player('b',1,2,0)]}),'towerlink'));
 assert.match(html,/TRAINING CLEAR/);assert.match(html,/初识兵营 · 目标已完成/);assert.match(html,/下一关/);assert.match(html,/重试本关/);assert.doesNotMatch(html,/result-reward-panel|奖励已到账/);
});
test('Tower Link training failure cannot show a completed target or next lesson even with rank one',()=>{
 const html=safe(render(room({game_id:'towerlink',practice:true,entry_minor:'0',game:{training:{lessonId:'lesson-03',title:'友军增援',objective:'完成增援',completed:false,failed:true,nextLessonId:'lesson-04'}},players:[player('a',0,1,0),player('b',1,2,0)]}),'towerlink'));
 assert.match(html,/TRY AGAIN/);assert.match(html,/重试本关/);assert.doesNotMatch(html,/下一关|目标已完成|result-confetti|VICTORY/);
});
for(const status of ['active','settling','settled','voiding','voided','cancelled'])test(`presentation hook initial ${status} snapshot is not replaced by an invented game or financial state`,()=>{
 const fixture=room({status,game:{status:status==='active'?'active':'finished',busyUntil:1700000000999,lastEvent:{id:3,type:'shot'}}}),r=present(fixture);assert.equal(r.presenting,false,'without a preceding mounted active game there is nothing to retain');assert.equal(r.sameRoom,true);assert.deepEqual(r.room,fixture);assert.equal(r.revealIsFunction,true);safe(r);
});

test('two-player Ludo celebration uses authoritative green seat color rather than the second atlas cell',()=>{
 const html=safe(render(room({players:[player('a',0,2,0),player('b',1,1,19000)],game:{players:[{key:'a',color:0,pieces:[-1,-1]},{key:'b',color:2,pieces:[52,52]}]}}),'ludo','b'));
 assert.match(html,/result-ludo-actor[^>]*background-position:66\.66666666666667% 0/);
});
for(const game of ['bowling','domino','run'])test(`${game} four-player result retains all player identities and ranks`,()=>{
 const html=safe(render(room({players:['a','b','c','d'].map((id,i)=>player(id,i,i+1,i?0:38000)),prize_minor:'38000'}),game));
 assert.equal((html.match(/class="result-player-portrait/g)||[]).length,4);
 assert.match(html,/result-finish-ranking/);assert.match(html,/<strong>C<\/strong>/);assert.match(html,/<strong>D<\/strong>/);
 if(game==='bowling')assert.doesNotMatch(html,/class="result-duo/);
 if(game==='domino')assert.doesNotMatch(html,/result-domino-facts/);
});
