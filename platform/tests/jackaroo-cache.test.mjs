import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as E from '../arena/jackaroo/engine.mjs';
import {createActionCache} from '../arena/jackaroo/action-cache.mjs';
const card=(rank,suit='C')=>({id:`${suit}${rank}`,rank,suit});
const make=()=>E.createState('41'.repeat(32),1000,{players:Array.from({length:4},(_,seatIndex)=>({key:`p${seatIndex}`,seatIndex}))});
function setPieces(s,key,positions){s.players.find(p=>p.key===key).pieces.forEach((p,i)=>{p.progress=positions[i]??-1;p.protected=false;});}
function fixture(){const s=make();s.phase='play';s.turnKey='p0';s.pendingNext=false;s.busyUntil=1000;s.turnDeadlineAt=21000;s.players[0].hand=[card(7)];setPieces(s,'p0',[0,10,20,30]);return s;}
const original=(s,key='p0')=>E.view(s,key);
const cached=(s,key='p0',roomId='room-a')=>E.view(s,key,{roomId});
const reset=()=>E.testing.actionCache.clear();
const stats=()=>E.testing.actionCache.stats();

test('Jackaroo cache: canonical seven action hashes, full-view parity and JSON hydration hits',()=>{
 reset();const s=fixture(),before=structuredClone(s),first=cached(s);assert.deepEqual(first,original(s));assert.deepEqual(cached(JSON.parse(JSON.stringify(s))),first);assert.equal(stats().hits,1);assert.deepEqual(s,before);
 // Ordered action hashes captured from the unchanged pre-optimization rules.
 // Keep these standalone: the permanent suite never imports review artifacts.
 const digest=state=>createHash('sha256').update(JSON.stringify(original(state).legalActions)).digest('hex');
 assert.equal(digest(s),'3233be1d010943b590007c59b9774cd69d5e906d6507d3250ff68bf21b169d29');
 const four=fixture();four.players[0].hand=['C','D','H','S'].map(suit=>card(7,suit));assert.equal(digest(four),'9bb4c937ca261186eaabb805ba3c823cf9b11771160c44ebbbfb215dafd0c743');
 const partner=fixture();setPieces(partner,'p0',[65,66,67,61]);setPieces(partner,'p2',[10,20,30,40]);assert.equal(digest(partner),'dbb1d15d9bec87e3efb3fb14ca218f6625473919f1d27409a30db03ceb3f7332');
});
test('Jackaroo cache: returned and compute-owned nested arrays cannot pollute cache',()=>{reset();const s=fixture(),a=cached(s);a.legalActions[0].segments[0].steps=999;a.legalActions.pop();const b=cached(s);assert.deepEqual(b,original(s));b.legalActions[0].segments[0].steps=888;assert.deepEqual(cached(s),original(s));const c=createActionCache(),owned=[{segments:[{steps:1}]}];c.get('room','fp',()=>owned);owned[0].segments[0].steps=2;assert.equal(c.get('room','fp',()=>assert.fail('must hit'))[0].segments[0].steps,1);});
test('Jackaroo cache: equal seats in different rooms are separate',()=>{reset();const s=fixture();cached(s);cached(s,'p0','room-b');assert.equal(stats().misses,2);assert.equal(stats().entries,2);});
test('Jackaroo cache: each viewer retains their own private hand',()=>{reset();const s=fixture();cached(s);s.turnKey='p2';s.players[2].hand=[card(1)];assert.deepEqual(cached(s,'p2'),original(s,'p2'));assert.equal(stats().misses,2);assert.equal(stats().entries,2);});
for(const[name,mutate]of[
 ['card id',s=>s.players[0].hand[0].id='D7'],
 ['card rank',s=>s.players[0].hand[0]=card(11)],
 ['card suit',s=>s.players[0].hand[0].suit='D'],
 ['hand order',s=>s.players[0].hand.reverse()],
 ['own progress',s=>s.players[0].pieces[0].progress=1],
 ['own protection',s=>s.players[0].pieces[0].protected=true],
 ['piece id',s=>s.players[0].pieces[0].id='p0:changed'],
 ['enemy progress',s=>s.players[1].pieces[0].progress=48],
 ['enemy protection',s=>{s.players[1].pieces[0].progress=48;s.players[1].pieces[0].protected=true;}],
 ['partner control after all own pieces home',s=>setPieces(s,'p0',[64,65,66,67])],
 ['team identity',s=>{for(const p of s.players)p.teamId=p.teamId==='team_a'?'emerald':'ivory';}],
 ['seat coordinates',s=>{s.players[1].seatIndex=3;s.players[3].seatIndex=1;}],
 ['roster order',s=>s.players.reverse()],
 ['piece order',s=>s.players[0].pieces.reverse()]
])test(`Jackaroo cache: invalidate ${name} without relying on state.version`,()=>{reset();const s=fixture();s.players[0].hand.push(card(2));cached(s);const version=s.version;mutate(s);assert.equal(s.version,version);assert.deepEqual(cached(s),original(s));assert.equal(stats().misses,2);});
test('Jackaroo cache: clocks, display metadata and version keep legality hit but view is fresh',()=>{reset();const s=fixture();cached(s);s.now+=10;s.version++;s.players[0].name='Updated name';s.lastEvent={id:55};E.shiftTime(s,5000);assert.deepEqual(cached(s),original(s));assert.equal(stats().hits,1);});
for(const[name,mutate]of[
 ['finished',s=>s.status='finished'],['forfeited',s=>s.players[0].forfeited=true],['pending animation',s=>s.pendingNext=true],['other turn',s=>s.turnKey='p1'],['exchange choice',s=>s.phase='exchange'],['already passed',s=>{s.phase='exchange';s.passes.p0='C7';}]
])test(`Jackaroo cache: authority gate stays live for ${name}`,()=>{reset();const s=fixture();cached(s);mutate(s);assert.deepEqual(cached(s),original(s));assert.equal(stats().hits,0);});
test('Jackaroo cache: successful move then animation completion without a version bump',()=>{reset();const s=fixture(),action=cached(s).legalActions[0];E.act(s,'p0',action,1001);assert.deepEqual(cached(s).legalActions,[]);const version=s.version;E.tick(s,1501);assert.equal(s.version,version);assert.deepEqual(cached(s),original(s));});
test('Jackaroo cache: actual forfeit cannot return old actions',()=>{reset();const s=fixture();cached(s);E.forfeit(s,['p0'],1001);assert.deepEqual(cached(s),original(s));assert.deepEqual(cached(s).legalActions,[]);});
test('Jackaroo cache: old replay snapshot is revalidated by content',()=>{reset();const s=fixture(),older=structuredClone(s);cached(s);s.players[0].pieces[0].progress=2;cached(s);assert.deepEqual(cached(older),original(older));assert.equal(stats().misses,3);});
test('Jackaroo cache: legacy missing version metadata cannot hide a board change',()=>{reset();const s=fixture();delete s.version;delete s.ruleVersion;assert.deepEqual(cached(s),original(s));s.players[0].pieces[0].progress=4;assert.deepEqual(cached(s),original(s));assert.equal(stats().misses,2);});
test('Jackaroo cache: absent, empty or non-string room scope bypasses cache',()=>{reset();const s=fixture();setPieces(s,'p0',[]);s.players[0].hand=[card(2)];for(const roomId of [undefined,'',null,1,{}])assert.deepEqual(E.view(s,'p0',{roomId}),original(s));assert.equal(stats().entries,0);assert.equal(stats().misses,0);});
test('Jackaroo cache: LRU entry/serialized-byte bounds and oversize bypass',()=>{let calls=0;const c=createActionCache({maxEntries:2,maxBytes:10000}),compute=()=>{calls++;return[{x:1}];};c.get('a','f',compute);c.get('b','f',compute);c.get('a','f',compute);c.get('c','f',compute);assert.equal(c.stats().entries,2);c.get('a','f',compute);assert.equal(calls,3);c.get('b','f',compute);assert.equal(calls,4);const bytes=createActionCache({maxEntries:4,maxBytes:300});for(const key of ['a','b','c'])bytes.get(key,'f',()=>[{data:'x'.repeat(140)}]);assert.equal(bytes.stats().entries,1);assert.ok(bytes.stats().bytes<=300);const oversized=createActionCache({maxEntries:3,maxBytes:100});assert.equal(oversized.get('a','f',()=>[{data:'x'.repeat(200)}])[0].data.length,200);assert.equal(oversized.stats().entries,0);assert.equal(oversized.stats().bytes,0);});
test('Jackaroo cache: TTL expires at boundary, including active entries',()=>{let now=1000,calls=0;const c=createActionCache({clock:()=>now,ttlMs:60000}),compute=()=>{calls++;return[{n:calls}];};assert.equal(c.get('a','f',compute)[0].n,1);now=60999;assert.equal(c.get('a','f',compute)[0].n,1);now=61000;assert.equal(c.get('a','f',compute)[0].n,2);assert.deepEqual(c.stats(),{hits:1,misses:2,entries:1,bytes:new TextEncoder().encode('af'+JSON.stringify([{n:2}])).byteLength});});
test('Jackaroo cache: failed enumeration never caches an incomplete result and clear resets',()=>{const c=createActionCache();assert.throws(()=>c.get('a','f',()=>{throw new Error('enumeration failed');}),/enumeration failed/);assert.equal(c.stats().entries,0);assert.deepEqual(c.get('a','f',()=>[{ok:true}]),[{ok:true}]);assert.equal(c.stats().misses,2);c.clear();assert.deepEqual(c.stats(),{hits:0,misses:0,entries:0,bytes:0});});
