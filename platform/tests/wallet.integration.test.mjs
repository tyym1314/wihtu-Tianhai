import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import http from 'node:http';
import fs from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { randomBytes } from 'node:crypto';
import { migrateWallet,provisionWallet,registerMathProfiles,createWalletServer,signWalletRequest,readWalletSnapshot,giftForTest } from '../server/wallet/index.mjs';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/oasis_platform',max:16});
let server,origin;
const spec=JSON.parse(await fs.readFile(new URL('../specs/openapi.json',import.meta.url),'utf8'));const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);const responseValidators=new Map();
function validateResponse(name,value){let v=responseValidators.get(name);if(!v){v=ajv.compile({$ref:`#/components/schemas/${name}`,components:spec.components});responseValidators.set(name,v);}assert.ok(v(value),name+': '+ajv.errorsText(v.errors));}
before(async()=>{await migrateWallet(pool);server=createWalletServer(pool);await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;});
after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
const math={game_id:'thunder',math_version:'wallet-test-approved-v1',math_config_hash:'a'.repeat(64),max_payout_multiplier:'10000'};
async function fixture(extra={}){
 const f={scope:{partner_id:uid('partner'),app_id:'app_a',environment:'sandbox',wallet_scope_id:'main',currency_id:'GOLD'},key_id:uid('key'),secret_base64:randomBytes(32).toString('base64'),users:['a','b','c','d'].map(external_user_id=>({external_user_id,balance_minor:'100000'})),treasury_minor:'1000000000000',math_profiles:[math],...extra};
 await provisionWallet(pool,f);return f;
}
async function call(f,path,body,opts={}){
 const method=body===undefined?'GET':'POST';const raw=opts.raw??(body===undefined?'':JSON.stringify({...f.scope,...body}));const request_id=opts.request_id||body?.request_id||uid('query');
 const headers=opts.headers||signWalletRequest({...f,request_id,method,path,raw_body:raw,nonce:randomBytes(16).toString('hex'),...opts.sign});
 const res=await fetch(origin+path,{method,headers,...(method==='POST'?{body:raw}:{})});const result=res.status===204?null:await res.json();if(result){const schema=res.status>=400?'Error':method==='POST'?'Operation':path.endsWith('/balance')?'BalanceResponse':path.includes('/operations/')?'Operation':path.includes('/authorizations/')?'ProbabilityAuthorization':'WalletMatch';validateResponse(schema,result);}return {status:res.status,body:result,headers,raw};
}
const terms={game_id:'carrom',rule_version:'carrom-1.0.0',payout_template_version:'winner-all-v1',fee_bps:500,entry_minor:'10000',player_count:2,team_size:1};
const rq=(match_id,user,seat,other={})=>({request_id:uid('reserve'),match_id,reservation_id:uid('hold'),external_user_id:user,seat_index:seat,amount_minor:'10000',terms,expires_at:new Date(Date.now()+110000).toISOString(),...other});
async function prepare(f,match_id=uid('match')){const holds=[rq(match_id,'a',0),rq(match_id,'b',1)];for(const h of holds){const r=await call(f,'/wallet/v1/reservations',h);assert.equal(r.body.state,'SUCCEEDED',JSON.stringify(r.body));}const capture={request_id:uid('capture'),match_id,terms,participants:holds.map(h=>({external_user_id:h.external_user_id,seat_index:h.seat_index,reservation_id:h.reservation_id,entry_minor:h.amount_minor}))};return {holds,capture,match_id};}
function settleBody(m,extra={}){return {request_id:uid('settle'),match_id:m,result_hash:'b'.repeat(64),resolution:'completed',fee_minor:'1000',payouts:[{external_user_id:'a',seat_index:0,rank:1,payout_minor:'19000'},{external_user_id:'b',seat_index:1,rank:2,payout_minor:'0'}],...extra};}
function probBody(extra={}){return {request_id:uid('authorize'),authorization_id:uid('auth'),cycle_id:uid('cycle'),external_user_id:'a',...math,max_payout_multiplier:undefined,stake_minor:'10000',max_payout_minor:'100000000',expires_at:new Date(Date.now()+55000).toISOString(),...extra};}
const state=f=>readWalletSnapshot(pool,{scope:f.scope});
function amounts(s){return Object.fromEntries(s.users.map(u=>[u.external_user_id,{available:u.available,reserved:u.reserved,credit_pending:u.credit_pending}]))}
function conserved(s){const delta=s.ledger.reduce((n,x)=>n+BigInt(x.delta_available)+BigInt(x.delta_reserved),0n);assert.equal(delta,0n,'ledger delta conservation');}

test('A01/A02 real PG concurrent capture and settlement replay produce one durable effect',async()=>{
 const f=await fixture(),p=await prepare(f);const captures=await Promise.all(Array.from({length:10},()=>call(f,'/wallet/v1/matches/capture',p.capture)));assert.ok(captures.every(r=>r.body.state==='SUCCEEDED'));for(const r of captures)assert.deepEqual(r.body,captures[0].body);
 const b=settleBody(p.match_id),settlements=await Promise.all(Array.from({length:10},()=>call(f,'/wallet/v1/matches/settle',b)));assert.ok(settlements.every(r=>r.body.state==='SUCCEEDED'));
 const s=await state(f);assert.equal(amounts(s).a.available,'109000');assert.equal(amounts(s).b.available,'90000');assert.equal(s.fee_minor,'1000');assert.equal(s.fee_pending_minor,'0');assert.ok(s.users.every(u=>u.reserved==='0'&&u.credit_pending==='0'));assert.equal(s.operations.length,4);conserved(s);
 const conflict=await call(f,'/wallet/v1/matches/settle',{...b,fee_minor:'1001'});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'IDEMPOTENCY_CONFLICT');
 const duplicateNewId=await call(f,'/wallet/v1/matches/settle',{...b,request_id:uid('other')});assert.equal(duplicateNewId.body.state,'REJECTED');assert.equal((await state(f)).fee_minor,'1000');
});

test('A03 durable receipt survives new HTTP server instance and original-ID query',async()=>{
 const f=await fixture(),p=await prepare(f);await call(f,'/wallet/v1/matches/capture',p.capture);const b=settleBody(p.match_id);const first=await call(f,'/wallet/v1/matches/settle',b);
 await new Promise(r=>server.close(r));server=createWalletServer(pool);await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const queried=await call(f,'/wallet/v1/operations/'+b.request_id);assert.deepEqual(queried.body,first.body);const replay=await call(f,'/wallet/v1/matches/settle',b);assert.deepEqual(replay.body,first.body);assert.equal(amounts(await state(f)).a.available,'109000');
});

test('A04 cancellation tombstone blocks late reserve and late capture',async()=>{
 const f=await fixture(),m=uid('cancel');const release=await call(f,'/wallet/v1/matches/release',{request_id:uid('release'),match_id:m,reason:'matchmaking_timeout'});assert.equal(release.body.receipt.resource.state,'CANCELLED');
 const late=await call(f,'/wallet/v1/reservations',rq(m,'a',0));assert.equal(late.body.rejection.code,'CANCELLED_TOMBSTONE');assert.equal(amounts(await state(f)).a.available,'100000');
 const p=await prepare(f);await call(f,'/wallet/v1/matches/release',{request_id:uid('release'),match_id:p.match_id,reason:'lobby_cancelled'});const cap=await call(f,'/wallet/v1/matches/capture',p.capture);assert.equal(cap.body.rejection.code,'CANCELLED_TOMBSTONE');assert.ok((await state(f)).users.every(u=>u.reserved==='0'));conserved(await state(f));
});

test('A05 expired member rejects whole capture; captured void refunds everybody and no fee',async()=>{
 const f=await fixture(),p=await prepare(f);await pool.query("UPDATE wallet_reservations SET expires_at=now()-interval '1 second' WHERE reservation_id=$1 AND scope_id=$2",[p.holds[1].reservation_id,Object.values(f.scope).join(':')]);
 const cap=await call(f,'/wallet/v1/matches/capture',p.capture);assert.equal(cap.body.rejection.code,'RESERVATION_EXPIRED');const untouched=await state(f);assert.equal(amounts(untouched).a.reserved,'10000');assert.equal(amounts(untouched).b.reserved,'0');assert.equal(untouched.fee_minor,'0');
 await call(f,'/wallet/v1/matches/release',{request_id:uid('release'),match_id:p.match_id,reason:'capture_failed'});
 const good=await prepare(f);await call(f,'/wallet/v1/matches/capture',good.capture);const refuseRelease=await call(f,'/wallet/v1/matches/release',{request_id:uid('release'),match_id:good.match_id,reason:'platform_unavailable'});assert.equal(refuseRelease.body.rejection.code,'ALREADY_CAPTURED');
 const v=await call(f,'/wallet/v1/matches/settle',settleBody(good.match_id,{resolution:'void',reason:'reference failure injection',fee_minor:'0',payouts:[{external_user_id:'a',seat_index:0,payout_minor:'10000'},{external_user_id:'b',seat_index:1,payout_minor:'10000'}]}));assert.equal(v.body.receipt.resource.state,'VOIDED');const s=await state(f);assert.equal(amounts(s).a.available,'100000');assert.equal(amounts(s).b.available,'100000');assert.equal(s.fee_minor,'0');conserved(s);
});

test('A06 simultaneous gift and game reserve cannot spend frozen funds or overdraw',async()=>{
 const f=await fixture({users:[{external_user_id:'a',balance_minor:'10000'},{external_user_id:'b',balance_minor:'0'}]});const m=uid('race');const [hold,gift]=await Promise.allSettled([call(f,'/wallet/v1/reservations',rq(m,'a',0)),giftForTest(pool,{scope:f.scope,request_id:uid('gift'),from_user_id:'a',to_user_id:'b',amount_minor:'10000'})]);
 const holdSuccess=hold.status==='fulfilled'&&hold.value.body.state==='SUCCEEDED',giftSuccess=gift.status==='fulfilled';assert.notEqual(holdSuccess,giftSuccess);const s=await state(f);assert.ok(s.users.every(u=>BigInt(u.available)>=0n));assert.equal(s.users.reduce((n,u)=>n+BigInt(u.available)+BigInt(u.reserved),0n),10000n);conserved(s);
});

test('A07 tenant/App/environment and wallet/currency scope isolation',async()=>{
 const f=await fixture(),other=await fixture({scope:{...f.scope,app_id:'app_b'}}),p=await prepare(f);await call(f,'/wallet/v1/matches/capture',p.capture);
 assert.equal((await call(other,'/wallet/v1/matches/'+p.match_id)).status,404);
 const wrong=await call(other,'/wallet/v1/reservations',rq(uid('wrong'),'a',0),{raw:JSON.stringify({...f.scope,...rq(uid('wrong'),'a',0)}),request_id:uid('wrong')});assert.equal(wrong.status,403);
 assert.equal((await call(f,'/wallet/v1/scopes/main/currencies/OTHER/users/a/balance')).status,403);
 const prod={scope:{...f.scope,environment:'production'},key_id:uid('key'),secret_base64:randomBytes(32).toString('base64')},productionScopeId=Object.values(prod.scope).join(':');
 await assert.rejects(provisionWallet(pool,{...prod,users:[{external_user_id:'a',balance_minor:'100000'}],treasury_minor:'1000000'}),{code:'REFERENCE_PROVISION_SANDBOX_ONLY'});
 await pool.query('INSERT INTO wallet_scopes(scope_id,partner_id,app_id,environment,wallet_scope_id,currency_id,treasury_available) VALUES($1,$2,$3,$4,$5,$6,0)',[productionScopeId,...Object.values(prod.scope)]);
 await pool.query('INSERT INTO wallet_keys(key_id,scope_id,secret_base64) VALUES($1,$2,$3)',[prod.key_id,productionScopeId,prod.secret_base64]);
 assert.equal((await call(prod,'/wallet/v1/matches/'+p.match_id)).status,404);assert.deepEqual((await state(prod)).users,[]);assert.deepEqual((await state(prod)).ledger,[]);
});

test('A08 approved full-cycle liability, accept fence and settlement while available budget is zero',async()=>{
 const f=await fixture({treasury_minor:'200000000'}),a=probBody(),b=probBody({external_user_id:'b'});const authorizations=await Promise.all([call(f,'/wallet/v1/probability/authorize',a),call(f,'/wallet/v1/probability/authorize',b)]);assert.ok(authorizations.every(x=>x.body.state==='SUCCEEDED'));
 assert.equal((await state(f)).treasury.available_minor,'0');const acceptBody={request_id:uid('accept'),authorization_id:a.authorization_id,cycle_id:a.cycle_id};const accepted=await call(f,'/wallet/v1/probability/accept',acceptBody);assert.equal(accepted.body.receipt.resource.state,'ACCEPTED');
 const third=await call(f,'/wallet/v1/probability/authorize',probBody({external_user_id:'c'}));assert.equal(third.body.rejection.code,'LIABILITY_CAPACITY_EXCEEDED');const cancel=await call(f,'/wallet/v1/probability/cancel',{request_id:uid('cancel'),authorization_id:a.authorization_id,cycle_id:a.cycle_id,reason:'user_cancelled'});assert.equal(cancel.body.rejection.code,'ALREADY_ACCEPTED');
 await pool.query("UPDATE wallet_probability SET expires_at=now()-interval '1 second' WHERE authorization_id=$1",[a.authorization_id]);assert.equal((await call(f,'/wallet/v1/probability/authorizations/'+a.authorization_id)).body.state,'ACCEPTED');
 const sb={request_id:uid('settleprob'),authorization_id:a.authorization_id,cycle_id:a.cycle_id,game_id:a.game_id,math_version:a.math_version,math_config_hash:a.math_config_hash,stake_minor:a.stake_minor,gross_payout_minor:'50000',result_hash:'c'.repeat(64)};const settled=await Promise.all(Array.from({length:10},()=>call(f,'/wallet/v1/probability/settle',sb)));assert.ok(settled.every(x=>x.body.state==='SUCCEEDED'));
 const s=await state(f);assert.equal(amounts(s).a.available,'140000');assert.equal(amounts(s).a.credit_pending,'0');assert.equal(s.treasury.reserved_minor,'100000000');assert.equal(s.treasury.available_minor,'99960000');conserved(s);
});

test('probability refuses unapproved profiles, wrong caps, expired pre-accept and cancellation races',async()=>{
 const f=await fixture();let r=await call(f,'/wallet/v1/probability/authorize',probBody({math_config_hash:'d'.repeat(64)}));assert.equal(r.body.rejection.code,'GAME_DISABLED');r=await call(f,'/wallet/v1/probability/authorize',probBody({max_payout_minor:'999'}));assert.equal(r.body.rejection.code,'AMOUNT_MISMATCH');
 const a=probBody();await call(f,'/wallet/v1/probability/authorize',a);await pool.query("UPDATE wallet_probability SET expires_at=now()-interval '1 second' WHERE authorization_id=$1",[a.authorization_id]);r=await call(f,'/wallet/v1/probability/accept',{request_id:uid('accept'),authorization_id:a.authorization_id,cycle_id:a.cycle_id});assert.equal(r.body.rejection.code,'AUTHORIZATION_EXPIRED');assert.equal(amounts(await state(f)).a.available,'100000');
 const b=probBody();await call(f,'/wallet/v1/probability/cancel',{request_id:uid('cancel'),authorization_id:b.authorization_id,cycle_id:b.cycle_id,reason:'authorization_timeout'});r=await call(f,'/wallet/v1/probability/authorize',b);assert.equal(r.body.rejection.code,'CANCELLED_TOMBSTONE');conserved(await state(f));
});

test('A09 nonce replay, tampered raw body, duplicate JSON key and event duplicates never pay',async()=>{
 const f=await fixture(),h=rq(uid('m'),'a',0);const first=await call(f,'/wallet/v1/reservations',h);const replay=await call(f,'/wallet/v1/reservations',h,{headers:first.headers,raw:first.raw});assert.equal(replay.body.code,'NONCE_REPLAY');
 const tampered=await call(f,'/wallet/v1/reservations',h,{headers:first.headers,raw:first.raw+' '});assert.equal(tampered.body.code,'SIGNATURE_INVALID');
 const duplicateRaw=JSON.stringify({...f.scope,...h}).replace('"amount_minor":"10000"','"amount_minor":"10000","amount_minor":"1"');const dup=await call(f,'/wallet/v1/reservations',h,{raw:duplicateRaw});assert.equal(dup.status,400);
 const before=await state(f);const event={scope:f.scope,request_id:uid('event'),type:'settlement.completed',aggregate_id:'test_match',aggregate_version:'1',operation_id:'test_operation',occurred_at:new Date().toISOString(),trace_id:'test_trace'};event.event_id=event.request_id;
 const raw=JSON.stringify(event);for(let i=0;i<3;i++){const r=await call(f,'/wallet/v1/events',event,{raw});assert.equal(r.status,204,JSON.stringify(r.body));}
 const after=await state(f);assert.deepEqual(after.users,before.users);assert.equal(after.ledger.length,before.ledger.length);const events=await pool.query('SELECT COUNT(*) FROM wallet_events WHERE event_id=$1',[event.event_id]);assert.equal(events.rows[0].count,'1');
});

test('invalid payout rolls back every user/fee then a new valid settlement succeeds',async()=>{
 const f=await fixture(),p=await prepare(f);await call(f,'/wallet/v1/matches/capture',p.capture);const before=await state(f);const bad=settleBody(p.match_id,{payouts:[{external_user_id:'a',seat_index:0,rank:1,payout_minor:'10000'},{external_user_id:'b',seat_index:1,rank:2,payout_minor:'9000'}]});const r=await call(f,'/wallet/v1/matches/settle',bad);assert.equal(r.body.state,'REJECTED');assert.deepEqual((await state(f)).users,before.users);assert.equal((await state(f)).fee_minor,'0');
 const original=await call(f,'/wallet/v1/operations/'+bad.request_id);assert.equal(original.body.state,'REJECTED');const good=await call(f,'/wallet/v1/matches/settle',settleBody(p.match_id));assert.equal(good.body.state,'SUCCEEDED');conserved(await state(f));
});

test('business IDs cannot be reused across wallet scopes in same App/environment',async()=>{
 const f=await fixture(),second=await fixture({scope:{...f.scope,wallet_scope_id:'secondary'}}),h=rq(uid('m'),'a',0);await call(f,'/wallet/v1/reservations',h);const r=await call(second,'/wallet/v1/reservations',h);assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_CONFLICT');assert.equal(amounts(await state(second)).a.available,'100000');
});

test('actual committed response loss is recovered by query and same business retry',async()=>{
 const f=await fixture(),p=await prepare(f),path='/wallet/v1/matches/capture',raw=JSON.stringify({...f.scope,...p.capture});let committed;
 const proxy=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const headers=Object.fromEntries(Object.entries(req.headers).filter(([k])=>k.startsWith('x-gp-')||k==='content-type'));const r=await fetch(origin+req.url,{method:'POST',headers,body});committed=await r.json();res.socket.destroy();}catch(e){res.destroy(e);}});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 try{const headers=signWalletRequest({...f,request_id:p.capture.request_id,method:'POST',path,raw_body:raw,nonce:randomBytes(16).toString('hex')});await assert.rejects(fetch('http://127.0.0.1:'+proxy.address().port+path,{method:'POST',headers,body:raw}));assert.equal(committed.state,'SUCCEEDED');const q=await call(f,'/wallet/v1/operations/'+p.capture.request_id);assert.deepEqual(q.body,committed);const retry=await call(f,path,p.capture);assert.deepEqual(retry.body,committed);const s=await state(f);assert.equal(s.ledger.filter(l=>l.operation_id===p.capture.request_id&&l.account.startsWith('user:')).length,2);conserved(s);}finally{await new Promise(r=>proxy.close(r));}
});

test('three-player fee rounding and tied first-place remainder use seat order',async()=>{
 const f=await fixture(),m=uid('three'),t={...terms,game_id:'match',player_count:3,entry_minor:'102'},holds=['a','b','c'].map((u,i)=>rq(m,u,i,{terms:t,amount_minor:'102'}));for(const h of holds)assert.equal((await call(f,'/wallet/v1/reservations',h)).body.state,'SUCCEEDED');
 const cap={request_id:uid('capture'),match_id:m,terms:t,participants:holds.map(h=>({external_user_id:h.external_user_id,seat_index:h.seat_index,reservation_id:h.reservation_id,entry_minor:h.amount_minor}))};assert.equal((await call(f,'/wallet/v1/matches/capture',cap)).body.state,'SUCCEEDED');
 const b={request_id:uid('settle'),match_id:m,result_hash:'f'.repeat(64),resolution:'completed',fee_minor:'15',payouts:[{external_user_id:'a',seat_index:0,rank:1,payout_minor:'146'},{external_user_id:'b',seat_index:1,rank:1,payout_minor:'145'},{external_user_id:'c',seat_index:2,rank:2,payout_minor:'0'}]};assert.equal((await call(f,'/wallet/v1/matches/settle',b)).body.state,'SUCCEEDED');const s=await state(f);assert.equal(amounts(s).a.available,'100044');assert.equal(amounts(s).b.available,'100043');assert.equal(amounts(s).c.available,'99898');assert.equal(s.fee_minor,'15');conserved(s);
});

test('2v2 team members share rank and win pool atomically',async()=>{
 const f=await fixture(),m=uid('team'),t={...terms,player_count:4,team_size:2},holds=['a','b','c','d'].map((u,i)=>rq(m,u,i,{terms:t}));for(const h of holds)assert.equal((await call(f,'/wallet/v1/reservations',h)).body.state,'SUCCEEDED');
 const cap={request_id:uid('capture'),match_id:m,terms:t,participants:holds.map(h=>({external_user_id:h.external_user_id,seat_index:h.seat_index,team_id:h.seat_index%2?'blue':'red',reservation_id:h.reservation_id,entry_minor:h.amount_minor}))};assert.equal((await call(f,'/wallet/v1/matches/capture',cap)).body.state,'SUCCEEDED');
 const b={request_id:uid('settle'),match_id:m,result_hash:'e'.repeat(64),resolution:'completed',fee_minor:'2000',payouts:['a','b','c','d'].map((u,i)=>({external_user_id:u,seat_index:i,rank:i%2?2:1,payout_minor:i%2?'0':'19000'}))};assert.equal((await call(f,'/wallet/v1/matches/settle',b)).body.state,'SUCCEEDED');const s=await state(f);assert.equal(amounts(s).a.available,'109000');assert.equal(amounts(s).c.available,'109000');assert.equal(amounts(s).b.available,'90000');assert.equal(amounts(s).d.available,'90000');assert.equal(s.fee_minor,'2000');conserved(s);
});

test('HMAC helper reproduces the published byte-exact fixed vector',async()=>{
 const v=JSON.parse(await fs.readFile(new URL('../specs/examples/signature-vector.json',import.meta.url),'utf8'));const h=signWalletRequest({key_id:v.key_id,secret_base64:v.test_secret_base64,request_id:v.request_id,method:v.method,path:v.canonical_target,raw_body:v.raw_body_utf8,nonce:v.nonce,timestamp:v.timestamp});assert.equal(h['x-gp-signature'],v.signature_header);
});

test('concurrent capture/cancel and accept/cancel serialize to one legal terminal boundary',async()=>{
 const f=await fixture(),p=await prepare(f);const [cap,release]=await Promise.all([call(f,'/wallet/v1/matches/capture',p.capture),call(f,'/wallet/v1/matches/release',{request_id:uid('release'),match_id:p.match_id,reason:'lobby_cancelled'})]);
 assert.equal([cap,release].filter(x=>x.body.state==='SUCCEEDED').length,1);const m=(await call(f,'/wallet/v1/matches/'+p.match_id)).body;assert.ok(['CAPTURED','CANCELLED'].includes(m.state));if(m.state==='CAPTURED')assert.equal(release.body.rejection.code,'ALREADY_CAPTURED');else assert.equal(cap.body.rejection.code,'CANCELLED_TOMBSTONE');
 const a=probBody({external_user_id:'c'});await call(f,'/wallet/v1/probability/authorize',a);const [accept,cancel]=await Promise.all([call(f,'/wallet/v1/probability/accept',{request_id:uid('accept'),authorization_id:a.authorization_id,cycle_id:a.cycle_id}),call(f,'/wallet/v1/probability/cancel',{request_id:uid('cancel'),authorization_id:a.authorization_id,cycle_id:a.cycle_id,reason:'user_cancelled'})]);assert.equal([accept,cancel].filter(x=>x.body.state==='SUCCEEDED').length,1);const ar=(await call(f,'/wallet/v1/probability/authorizations/'+a.authorization_id)).body;assert.ok(['ACCEPTED','CANCELLED'].includes(ar.state));if(ar.state==='ACCEPTED')assert.equal(cancel.body.rejection.code,'ALREADY_ACCEPTED');else assert.equal(accept.body.rejection.code,'CANCELLED_TOMBSTONE');conserved(await state(f));
});
