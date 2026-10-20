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
  if(!g.bonus){assert.ok(m.targetRtp>0.96&&m.targetRtp<=0.981,`${id} ${m.targetRtp}`);}
  else assert.ok(m.maxMultiplier>=Math.max(...g.options.map(o=>o.multiplier))*Math.max(...g.bonus.table.filter(x=>x.type==='multiplier').map(x=>x.value)),id);
  for(const o of g.options.filter(o=>o.covers))assert.ok(Math.abs(o.multiplier*o.covers.reduce((a,c)=>a+m.config.weights[m.outcomes.findIndex(x=>x.id===c)]/m.config.total,0)/m.targetRtp-1)<0.01,`${id}/${o.id} group RTP`);
 }
});
test('lines/ways slots: deterministic, capped, and wild/golden rules hold',async()=>{
 const {linesModel,playLinesCycle}=await import('../server/casino/slot-lines.mjs');
 for(const id of Object.keys(CASINO_GAMES).filter(id=>['lines','ways'].includes(CASINO_GAMES[id].slot?.pay))){
  const m=linesModel(CASINO_GAMES[id]),sd=seed();assert.deepEqual(playLinesCycle(m,sd,'10000'),playLinesCycle(m,sd,'10000'));
  for(let i=0;i<2000;i++){const r=playLinesCycle(m,seed(),'10000');assert.ok(r.win_x100<=m.maxMultiplier*100);
   for(const s of r.spins){s.initial.forEach((reel,col)=>{const w=reel.filter(x=>x.s==='wild').length;if(m.config.wild)assert.ok(m.config.wild.reels.includes(col)||w===0,`${id} wild on reel ${col}`);if(m.config.golden)assert.ok(m.config.golden.reels.includes(col)||!reel.some(x=>x.g));});}}
 }
});
test('ChilliSlot free spins play 2-4 boards; collected chillies unlock boards and wild reels',async()=>{
 const {linesModel,playLinesCycle}=await import('../server/casino/slot-lines.mjs');
 const m=linesModel(CASINO_GAMES.chillislot);let r;do r=playLinesCycle(m,seed(),'10000');while(!r.free_spins);
 let before=0;
 for(const s of r.spins.filter(s=>s.free)){
  const steps=m.config.freeSpins.boards.steps.filter(x=>before>=x.at),boards=Math.max(2,...steps.map(x=>x.boards||0));
  assert.equal(s.boards.length,boards);assert.deepEqual(s.wild_reels,steps.map(x=>x.wildReel).filter(x=>x!=null));
  for(const b of s.boards)for(const col of s.wild_reels)assert.ok(b.initial[col].every(x=>x.s==='wild'));
  before=s.collected;
 }
});
test('sphinxlegend: a triggered feature waits for a choice; the base spin is identical whichever package is chosen',async()=>{
 const {linesModel,playLinesCycle}=await import('../server/casino/slot-lines.mjs');
 const m=linesModel(CASINO_GAMES.sphinxlegend);let sd,r;do{sd=seed();r=playLinesCycle(m,sd,'10000');}while(!r.pending);
 assert.equal(r.pending.choices.length,4);assert.equal(r.free_spins,0);
 for(let c=0;c<4;c++){const f=playLinesCycle(m,sd,'10000',{choice:c});assert.deepEqual(f.spins[0],r.spins[0]);assert.equal(f.free_spins,m.config.freeSpins.choices[c].award);assert.equal(f.choice,c);}
 assert.throws(()=>playLinesCycle(m,sd,'10000',{choice:9}),/INVALID_CHOICE/);
});

test('every casino math version is bound to its config hash, so a config change is a new approved version',async()=>{
 const {casinoProfiles}=await import('../server/casino/rounds.mjs');
 const profiles=casinoProfiles(),games=new Set(profiles.map(m=>m.gameId));
 // Default model per game plus one per adjustable return-rate tier (96–99), each its own version.
 assert.deepEqual([...games].sort(),[...CASINO_IDS].sort());assert.equal(new Set(profiles.map(m=>m.version)).size,profiles.length);
 for(const m of profiles){assert.match(m.version,/^[A-Za-z0-9_.-]{1,96}$/);assert.ok(m.version.endsWith('-'+m.hash.slice(0,12)),m.gameId);}
});

test('return-rate tiers: adjustable families reach the tier, fixed ones keep their default model',async()=>{
 const {rtpTiers}=await import('../server/rtp-tiers.mjs');const {games}=rtpTiers();const by=Object.fromEntries(games.map(g=>[g.game_id,g]));
 for(const id of ['thunder','tiger','crash','monster','olympus','oceanslot'])for(const t of ['96','97','98','99'])assert.equal(by[id].tiers[t],Number(t),id+' '+t);
 // Greedy wheels: specials lift the return above the printed-multiplier floor (97.19%), never below it.
 assert.equal(by.greedylion.tiers['99'],99);assert.equal(by.greedylion.tiers['96'],by.greedylion.default);
 for(const id of ['roulette','sicbo','teenpatti','greedyking'])assert.equal(by[id].adjustable,false,id);
 // Mini-reel bonus games reach every tier by scaling the bonus weights.
 for(const id of ['fruitparty','footballleague','glorycup'])for(const t of ['96','97','98','99'])assert.equal(by[id].tiers[t],Number(t),id+' '+t);
});

test('classes used by several game families are styled in the shared stylesheet (each game loads only its own CSS)',async()=>{
 const {readFileSync}=await import('node:fs');const shell=readFileSync(new URL('../casino/shared/shell.css',import.meta.url),'utf8');
 for(const cls of ['wg-hot','wg-balance'])assert.match(shell,new RegExp('\\.'+cls+'\\{[^}]*'),cls);
 assert.match(shell,/\.wg-hot\{[^}]*position:absolute/);
});

test('half-screen bands are ordered, inside the plate and keep the top and bottom controls',async()=>{
 const {HALF_BANDS,halfLayout}=await import('../casino/shared/half.mjs');
 for(const [id,bands] of Object.entries(HALF_BANDS)){
  assert.ok(CASINO_IDS.includes(id),id);
  let last=0;for(const [a,b] of bands){assert.ok(a>=last&&b>a&&b<=1672,id);last=b;}
  const l=halfLayout(id);assert.ok(l.height<1672&&l.height>=900,id);
  assert.equal(l.removedAbove(1672),1672-l.height);assert.ok(l.cutAt((bands[0][0]+bands[0][1])/2),id);
 }
});
