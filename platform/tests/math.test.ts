import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getProfile, playCycle, createCycleRandom, generateThunderCycle, generateTigerCycle } from '../server/math/index.js';
import { generateRound, type RoundResult } from '../../src/game/engine.js';
import { generateTigerRound } from '../../src/tiger/math.js';
const seed=(n:number)=>createHash('sha256').update(`fixture:${n}`).digest('hex');

test('all four platform profiles are stable, frozen and independent of legacy versions',()=>{
  const versions=new Set<string>(),hashes=new Set<string>();
  for(const game of ['thunder','tiger']) for(const tier of ['98','99']) {
    const p=getProfile(game,tier); assert(Object.isFrozen(p));assert(Object.isFrozen(p.config));
    assert.match(p.version,/platform/);assert.equal(p.targetRtp,Number(tier)/100);assert.match(p.hash,/^[0-9a-f]{64}$/);
    versions.add(p.version);hashes.add(p.hash);
  }
  assert.equal(versions.size,4);assert.equal(hashes.size,4);assert.throws(()=>getProfile('carrom'));
});
test('cryptographic stream is reproducible, domain-separated and validates range/seed',()=>{
  const a=createCycleRandom(seed(1),'a'),b=createCycleRandom(seed(1),'a'),c=createCycleRandom(seed(1),'b');
  const av=Array.from({length:1000},()=>a(997)),bv=Array.from({length:1000},()=>b(997)),cv=Array.from({length:1000},()=>c(997));
  assert.deepEqual(av,bv);assert.notDeepEqual(av,cv);assert(av.every(n=>Number.isInteger(n)&&n>=0&&n<997));
  assert.throws(()=>a(0));assert.throws(()=>a(1.2));assert.throws(()=>createCycleRandom('abcd','a'));
});
test('same seed/profile produces recoverable complete cycle and one conserved payout',()=>{
  for(const game of ['thunder','tiger'])for(const tier of ['98','99'])for(let i=0;i<100;i++){
    const a=playCycle(game,10000,tier,seed(i));assert.deepEqual(a,playCycle(game,10000,tier,seed(i)));
    assert.equal(a.rounds.reduce((sum,r)=>sum+r.totalWin,0),a.grossPayoutMinor);assert(a.grossPayoutMinor<=a.maxPayoutMinor);
    if(game==='thunder') {assert(a.freeSpinsPlayed<=100);for(const r of a.rounds)assert.equal(r.steps.reduce((sum,s)=>sum+(s as unknown as {settledWin:number}).settledWin,0),r.totalWin);}
  }
});
test('Tiger99 retains the exact legacy outcome model and proves reachable 455x upper bound',()=>{
  const p=getProfile('tiger','99');
  for(let i=0;i<100;i++){
    const raw=generateTigerRound({bet:10000},createCycleRandom(seed(i),p.hash));
    const actual=playCycle('tiger',10000,'99',seed(i)).rounds[0];
    for(const key of ['steps','initialBoard','endBoard','baseWin','totalWin','multiplier','respinCount','featureSymbol'])assert.deepEqual((actual as any)[key],(raw as any)[key]);
  }
  for(const tier of ['98','99']){
    const result=generateTigerCycle(10000,getProfile('tiger',tier),()=>0);
    const r=result.rounds[0] as any;assert.equal(r.totalWin,r.baseWin*r.multiplier);assert(r.totalWin<=455*10000);
    if(tier==='99')assert.equal(r.totalWin,455*10000);
  }
});
test('Thunder99 preserves uncapped legacy rounds within the new finite cycle rules',()=>{
  const p=getProfile('thunder','99');
  for(let i=0;i<100;i++){
    const rng=createCycleRandom(seed(i),p.hash);const actual=playCycle('thunder',10000,'99',seed(i));
    let free=0,multiplier=0;
    for(const round of actual.rounds){
      const old=generateRound({bet:10000,freeSpins:free,freeMultiplier:multiplier},rng);
      if(!round.cycleWinCapReached&&!round.cycleFreeSpinLimitReached){assert.deepEqual(round.initialBoard,old.initialBoard);assert.equal(round.totalWin,old.totalWin);assert.equal((round as RoundResult).freeSpinsAwarded,old.freeSpinsAwarded);}
      free=round.freeSpinsAfter;multiplier=(round as RoundResult).nextFreeMultiplier;
    }
  }
});
test('Thunder hard gross cap clips last round and reconciles animation attribution',()=>{
  let calls=0;
  const result=generateThunderCycle(10000,getProfile('thunder','99'),()=>0,input=>{
    const raw=generateRound({bet:input.bet,freeSpins:1,freeMultiplier:100},()=>0);
    return {...raw,isFreeSpin:input.freeSpins>0,totalWin:input.bet*(calls++===0?700:1000),freeSpinsAwarded:input.freeSpins?5:15,nextFreeMultiplier:100};
  });
  assert.equal(result.grossPayoutMinor,10000*10000);assert(result.cycleWinCapReached);
  const last=result.rounds.at(-1)! as RoundResult & any;assert.equal(last.totalWin,300*10000);assert.equal(last.freeSpinsAfter,0);assert.equal(last.freeSpinsAwarded,0);
  assert.equal(last.steps.reduce((sum:number,s:any)=>sum+s.settledWin,0),last.totalWin);
});
test('Thunder perpetual retrigger fixture terminates after exactly 100 free spins',()=>{
  const result=generateThunderCycle(10000,getProfile('thunder','99'),()=>0,input=>({
    ...generateRound({bet:input.bet,freeSpins:0,freeMultiplier:0},()=>0),steps:[],baseWin:0,totalWin:0,
    isFreeSpin:input.freeSpins>0,freeSpinsAwarded:input.freeSpins?5:15,nextFreeMultiplier:0,
  }));
  assert.equal(result.freeSpinsPlayed,100);assert.equal(result.rounds.length,101);assert.equal(result.rounds.at(-1)!.freeSpinsAfter,0);assert(result.cycleFreeSpinLimitReached);
});
test('unsupported stake and profile are rejected before RNG is used',()=>{
  assert.throws(()=>playCycle('thunder',100,'99',seed(1)));assert.throws(()=>playCycle('tiger',10000,'97',seed(1)));
});
