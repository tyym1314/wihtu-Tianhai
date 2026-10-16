import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {CASINO_GAMES,CASINO_IDS} from '../shared/casino-games.mjs';
import {wheelModel,drawWheel} from '../server/casino/wheel.mjs';
import {crashModel,drawCrash,multiplierAt,timeToReach} from '../server/casino/crash.mjs';
import {cards3Model,drawCards3,handKey} from '../server/casino/cards3.mjs';
import {slotModel,playSlotCycle} from '../server/casino/slots.mjs';

const seed=()=>randomBytes(32).toString('hex');
test('every casino game is an allowed wallet probability game id',()=>{
 const s=JSON.parse(readFileSync(new URL('../specs/openapi.json',import.meta.url),'utf8')).components.schemas;
 for(const id of CASINO_IDS){assert.ok(s.ProbabilityGameId.enum.includes(id),id);assert.ok(s.GameId.enum.includes(id),id);}
 assert.ok(readFileSync(new URL('../public/launch/index.html',import.meta.url),'utf8').includes(`'${CASINO_IDS.at(-1)}'`),'launch page lists casino games');
});
test('the same seed always gives the same result',()=>{
 const sd=seed();
 assert.deepEqual(drawWheel(wheelModel(CASINO_GAMES.greedylion),sd),drawWheel(wheelModel(CASINO_GAMES.greedylion),sd));
 assert.deepEqual(drawCrash(crashModel(CASINO_GAMES.rocketstar2),sd),drawCrash(crashModel(CASINO_GAMES.rocketstar2),sd));
 assert.deepEqual(drawCards3(cards3Model(CASINO_GAMES.teenpatti),sd),drawCards3(cards3Model(CASINO_GAMES.teenpatti),sd));
 const m=slotModel(CASINO_GAMES.olympus);assert.deepEqual(playSlotCycle(m,sd,'10000'),playSlotCycle(m,sd,'10000'));
});
test('crash points follow P(crash >= x) = rtp / x and the multiplier curve inverts exactly',()=>{
 const m=crashModel(CASINO_GAMES.rocketstar2),N=200000;let ge2=0,ge10=0;
 for(let i=0;i<N;i++){const r=drawCrash(m,seed());if(r.crash_x100>=200)ge2++;if(r.crash_x100>=1000)ge10++;assert.ok(r.crash_x100>=100&&r.crash_x100<=100000);}
 assert.ok(Math.abs(ge2/N-0.485)<0.006,String(ge2/N));assert.ok(Math.abs(ge10/N-0.097)<0.004,String(ge10/N));
 for(const x of [101,150,200,1000,50000])assert.ok(multiplierAt(timeToReach(x))>=x&&multiplierAt(timeToReach(x)-1)<x,String(x));
});
test('three-hand ranking follows Teen Patti order',()=>{
 const rank=c=>handKey(c).category;
 assert.deepEqual([rank(['As','Ah','Ad']),rank(['Qh','Kh','Ah']),rank(['4c','5d','6s']),rank(['2h','9h','Kh']),rank(['9s','9d','2c']),rank(['2s','7d','Kc'])],['trail','pure','sequence','color','pair','high']);
 assert.ok(handKey(['Ah','2h','3h']).key<handKey(['2h','3h','4h']).key||handKey(['Ah','2h','3h']).key[1]<handKey(['2h','3h','4h']).key[1],'A-2-3 is the lowest sequence');
});
test('a slot cycle never pays more than the cap and its gross matches the win multiple',()=>{
 const m=slotModel(CASINO_GAMES.olympus);
 for(let i=0;i<3000;i++){const r=playSlotCycle(m,seed(),'10000');assert.ok(r.win_x100<=m.maxMultiplier*100);assert.equal(r.gross_payout_minor,String(100n*BigInt(r.win_x100)));}
});
test('every wheel game returns 97-98% on each option and reserves its maximum payout',async()=>{
 const {ALL_CASINO_DEFINITIONS}=await import('../shared/casino-games.mjs');
 for(const id of ALL_CASINO_DEFINITIONS.filter(id=>CASINO_GAMES[id].family==='wheel')){
  const g=CASINO_GAMES[id],m=wheelModel(g);
  if(!g.bonus){assert.ok(m.targetRtp>0.97&&m.targetRtp<0.98,`${id} ${m.targetRtp}`);}
  else assert.ok(m.maxMultiplier>=Math.max(...g.options.map(o=>o.multiplier))*Math.max(...g.bonus.table.filter(x=>x.type==='multiplier').map(x=>x.value)),id);
  for(const o of g.options.filter(o=>o.covers))assert.ok(Math.abs(o.multiplier*o.covers.reduce((a,c)=>a+m.config.weights[m.outcomes.findIndex(x=>x.id===c)]/m.config.total,0)/m.targetRtp-1)<0.01,`${id}/${o.id} group RTP`);
 }
});
