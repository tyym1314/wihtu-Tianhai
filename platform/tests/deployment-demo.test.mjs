import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {demoRateConfiguration} from '../server/rate-limit.mjs';
import {COOKIE,parseConfig,loadGuestKey,issueGuest,verifyGuest,csrfFor,launchRequestId,createRateLimiter,createDemoHost,demoSessionBody} from '../deploy/demo-host.mjs';
const origin='https://games.example.test:18880',key=Buffer.alloc(32,7),now=1900000000000;

async function fixture(t,env={}){
 const calls=[],sessions=new Map(),intents=new Map();let next=0;
 const backend={async games(){return {games:[{game_id:'match',title:'Match',category:'competitive',available:true,modes:[{player_counts:[2,3,4]}]},{game_id:'hidden',available:false}]};},async launch(guest,b){
  calls.push({guest,body:{...b}});
  if(b.resume_session_id){const prior=sessions.get(b.resume_session_id);if(!prior||prior.guest!==guest||prior.game!==b.game_id)throw Object.assign(new Error('SCOPE_FORBIDDEN'),{status:403,code:'SCOPE_FORBIDDEN'});}
  if(intents.has(b.request_id)){const old=intents.get(b.request_id);if(old.raw!==JSON.stringify(b))throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'),{status:409,code:'IDEMPOTENCY_CONFLICT'});return old.result;}
  const sid=b.resume_session_id||'session_'+(++next),result={session_id:sid,entry_url:origin+'/play/'+b.game_id,launch_code:'one_time_code_'+next,expires_in:60};
  sessions.set(sid,{guest,game:b.game_id});intents.set(b.request_id,{raw:JSON.stringify(b),result});return result;
 }};
 const server=await createDemoHost({origin,rateLimits:demoRateConfiguration(env)},{key,backend,clock:()=>now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const send=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:{Host:new URL(origin).host,...headers}},res=>{let raw='';res.setEncoding('utf8');res.on('data',x=>raw+=x);res.on('end',()=>{let data;try{data=JSON.parse(raw);}catch{}resolve({status:res.statusCode,headers:res.headers,raw,data});});});req.on('error',reject);req.end(body);
 });
 const guest=async()=>{const config=await send('/api/demo/config');assert.equal(config.status,200);return {cookie:config.headers['set-cookie'][0].split(';')[0],csrf:config.data.csrf,config};};
 const launch=(g,b={},extra={})=>send('/api/demo/launch',{method:'POST',headers:{cookie:g.cookie,Origin:origin,'content-type':'application/json','x-host-csrf':g.csrf,...extra},body:JSON.stringify({game_id:'match',request_id:'same_request_1234',...b})});
 return {send,guest,launch,calls};
}

test('public host accepts only exact HTTPS origins and safe unprivileged ports',()=>{
 assert.equal(parseConfig({OASIS_PUBLIC_ORIGIN:origin}).port,18885);
 for(const bad of ['http://127.0.0.1','https://user:pass@example.test','https://example.test/path','https://example.test?x=1'])assert.throws(()=>parseConfig({OASIS_PUBLIC_ORIGIN:bad}));
 assert.throws(()=>parseConfig({OASIS_PUBLIC_ORIGIN:origin,OASIS_DEMO_PORT:'80'}));
 assert.throws(()=>parseConfig({OASIS_PUBLIC_ORIGIN:origin,OASIS_RATE_DEMO_ANONYMOUS_IP_PER_MINUTE:'0'}),/INVALID_RATE_LIMIT_CONFIG/);
});

test('21 independent visitors behind one IP get cookies and launch, without an hourly people cap',async t=>{
 const f=await fixture(t),cookies=new Set();
 for(let i=0;i<21;i++){const g=await f.guest();cookies.add(g.cookie);assert.equal((await f.launch(g)).status,200);}
 assert.equal(cookies.size,21);assert.equal(new Set(f.calls.map(c=>c.guest)).size,21);
});

test('guest API and launch budgets isolate identities on a shared IP and include Retry-After',async t=>{
 const f=await fixture(t,{OASIS_RATE_DEMO_GUEST_API_PER_MINUTE:'4',OASIS_RATE_DEMO_GUEST_LAUNCH_PER_MINUTE:'2'}),a=await f.guest(),b=await f.guest();
 assert.equal((await f.launch(a)).status,200);assert.equal((await f.launch(a)).status,200);
 const exceeded=await f.launch(a);assert.equal(exceeded.status,429);assert.equal(exceeded.headers['retry-after'],'60');
 assert.equal((await f.launch(b)).status,200);
 assert.equal((await f.send('/api/demo/games',{headers:{Cookie:a.cookie}})).status,429);
 assert.equal((await f.send('/api/demo/games',{headers:{Cookie:b.cookie}})).status,200);
});

test('anonymous abuse is IP-limited while an already signed guest on the same IP remains usable',async t=>{
 const f=await fixture(t,{OASIS_RATE_DEMO_ANONYMOUS_IP_PER_MINUTE:'2'}),a=await f.guest();
 await f.guest();const blocked=await f.send('/api/demo/config');assert.equal(blocked.status,429);assert.equal(blocked.headers['retry-after'],'60');
 assert.equal((await f.send('/api/demo/config',{headers:{Cookie:a.cookie}})).status,200);
 assert.equal((await f.launch(a)).status,200);
});

test('guest key survives restart, is private, and never silently replaces unsafe file',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'oasis-demo-key-'));
 try{const first=await loadGuestKey(dir),second=await loadGuestKey(dir);assert.deepEqual(first,second);const issued=issueGuest(first,now);assert.equal(verifyGuest(second,issued.cookie,now+5000),issued.guest);await chmod(path.join(dir,'hosted-demo-guest.key'),0o644);await assert.rejects(loadGuestKey(dir),/0600/);}finally{await rm(dir,{recursive:true,force:true});}
});

test('forged, expired and future cookies do not identify guests',()=>{
 const issued=issueGuest(key,now);assert.equal(verifyGuest(key,issued.cookie,now),issued.guest);
 assert.throws(()=>verifyGuest(Buffer.alloc(32,8),issued.cookie,now));
 assert.throws(()=>verifyGuest(key,issued.cookie+'0',now));
 assert.throws(()=>verifyGuest(key,issued.cookie,now-1000));
 assert.throws(()=>verifyGuest(key,issued.cookie,now+31*86400000));
 assert.equal(csrfFor(key,issued.guest),csrfFor(key,issued.guest));
});

test('launch request IDs are stable on retry and isolated across guest identities',()=>{
 const a=issueGuest(key,now),b=issueGuest(key,now);
 assert.equal(launchRequestId(key,a.guest,'request123'),launchRequestId(key,a.guest,'request123'));
 assert.notEqual(launchRequestId(key,a.guest,'request123'),launchRequestId(key,b.guest,'request123'));
});

test('bounded limiter rejects overflow without unbounded identity allocation and permits expiry',()=>{
 let time=0;const consume=createRateLimiter({clock:()=>time,maxEntries:2});consume('a',1,100);consume('b',1,100);
 assert.throws(()=>consume('a',1,100),e=>e.status===429);assert.throws(()=>consume('c',1,100),e=>e.status===429);
 time=101;assert.doesNotThrow(()=>consume('c',1,100));
});

test('built session satisfies current platform contract and pins authenticated identity and scope',async()=>{
 const spec=JSON.parse(await readFile(new URL('../specs/openapi.json',import.meta.url),'utf8'));
 const ajv=new Ajv({strict:false});addFormats(ajv);ajv.addSchema(spec,'contract');const validate=ajv.compile({$ref:'contract#/components/schemas/CreateSessionRequest'});
 const guest=issueGuest(key,now).guest,scope={partner_id:'partner_demo',app_id:'app_demo',environment:'sandbox',wallet_scope_id:'wallet_demo',currency_id:'COIN'};
 const body=demoSessionBody(scope,guest,{game_id:'match',request_id:'request_1234',external_user_id:'attacker',app_id:'bad',host_origin:'https://bad.test',resume_session_id:'ses_original'},origin);
 assert.equal(validate(body),true,ajv.errorsText(validate.errors));assert.equal(body.external_user_id,guest);assert.equal(body.app_id,scope.app_id);assert.equal(body.host_origin,origin);
});

test('two visitors receive separate secure cookie identities without exposing backend keys',async t=>{
 const f=await fixture(t),a=await f.guest(),b=await f.guest();assert.notEqual(a.cookie,b.cookie);assert.notEqual(a.csrf,b.csrf);
 assert.match(a.config.headers['set-cookie'][0],/Path=\/;.*Secure; HttpOnly; SameSite=Lax/);
 assert.equal(a.config.data.platform_origin,origin);assert.doesNotMatch(a.config.raw,/secret_base64|key_id|wallet_scope_id/);
 const reuse=await f.send('/api/demo/config',{headers:{Cookie:a.cookie}});assert.equal(reuse.data.csrf,a.csrf);assert.equal(reuse.headers['set-cookie'],undefined);
 const games=await f.send('/api/demo/games',{headers:{Cookie:a.cookie}});assert.deepEqual(games.data.games.map(g=>g.id),['match']);
});

test('Host, Origin, cross-site API reads and forged cookies are rejected before backend launch',async t=>{
 const f=await fixture(t),g=await f.guest();
 assert.equal((await f.send('/api/demo/config',{headers:{Host:'attacker.test'}})).status,403);
 assert.equal((await f.send('/api/demo/config',{headers:{Origin:'https://attacker.test'}})).status,403);
 assert.equal((await f.send('/api/demo/config',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal((await f.send('/api/demo/games',{headers:{Cookie:COOKIE+'=forged'}})).status,401);
 assert.equal((await f.launch(g,{}, {Origin:'https://attacker.test'})).status,403);
 assert.equal((await f.launch(g,{}, {'x-host-csrf':'forged'})).status,403);
 assert.equal(f.calls.length,0);
});

test('browser cannot pick identity, wallet scope or App and cannot borrow another guest CSRF',async t=>{
 const f=await fixture(t),a=await f.guest(),b=await f.guest();
 for(const field of ['external_user_id','wallet_scope_id','app_id','partner_id','environment'])assert.equal((await f.launch(a,{[field]:'attacker'})).status,400);
 assert.equal((await f.launch(a,{}, {'x-host-csrf':b.csrf})).status,403);assert.equal(f.calls.length,0);
});

test('retry keeps one launch intent; another guest cannot resume the original guest session',async t=>{
 const f=await fixture(t),a=await f.guest(),b=await f.guest();const one=await f.launch(a),retry=await f.launch(a),other=await f.launch(b);
 assert.equal(one.status,200);assert.deepEqual(retry.data,one.data);assert.notEqual(other.data.session_id,one.data.session_id);
 const stolen=await f.launch(b,{request_id:'resume_attempt_b',resume_session_id:one.data.session_id});assert.equal(stolen.status,403);
 const own=await f.launch(a,{request_id:'resume_attempt_a',resume_session_id:one.data.session_id});assert.equal(own.status,200);assert.equal(own.data.session_id,one.data.session_id);
 assert.equal(f.calls[0].body.request_id,f.calls[1].body.request_id);assert.notEqual(f.calls[0].body.request_id,f.calls[2].body.request_id);
});

test('duplicate JSON keys, compressed bodies, excessive bodies and unknown routes reject',async t=>{
 const f=await fixture(t),g=await f.guest();const headers={Cookie:g.cookie,Origin:origin,'content-type':'application/json','x-host-csrf':g.csrf};
 assert.equal((await f.send('/api/demo/launch',{method:'POST',headers,body:'{"game_id":"match","game_id":"tiger","request_id":"request123"}'})).status,400);
 assert.equal((await f.launch(g,{}, {'content-encoding':'gzip'})).status,400);
 assert.equal((await f.send('/api/demo/launch',{method:'POST',headers,body:' '.repeat(8193)})).status,413);
 assert.equal((await f.send('/api/demo/topup',{method:'POST',headers,body:'{}'})).status,404);assert.equal(f.calls.length,0);
});

test('demo assets reuse existing host, route under /demo, and label test-only currency',async t=>{
 const f=await fixture(t),index=await f.send('/demo/'),script=await f.send('/demo/host.mjs');
 assert.equal(index.status,200);assert.match(index.raw,/12,000 测试币/);assert.match(index.raw,/不可充值或提现/);assert.match(index.raw,/src="\/demo\/host.mjs"/);
 assert.match(script.raw,/\/api\/demo\/launch/);assert.doesNotMatch(script.raw,/\/api\/host\/|固定本地测试/);
 assert.match(index.headers['content-security-policy'],/frame-ancestors 'none'/);
 assert.equal((await f.send('/demo')).headers.location,'/demo/');assert.equal((await f.send('/demo/../../.local/hosted-demo-guest.key')).status,404);
});
