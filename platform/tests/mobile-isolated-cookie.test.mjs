import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createLoopbackCookieIsolation,clearOwnedLoopbackCookie,withOwnedLoopbackCookie} from '../scripts/mobile-isolated-cookie.mjs';
import {serveLoopbackFavicon} from '../scripts/profile-mobile-isolated.mjs';
import {createDemoHost,issueGuest,verifyGuest,csrfFor} from '../deploy/demo-host.mjs';

test('each invocation owns a distinct random alias, including in the same process',()=>{
 const names=new Set(Array.from({length:100},()=>createLoopbackCookieIsolation().name));
 assert.equal(names.size,100);for(const name of names)assert.match(name,/^oasis_quality_demo_[a-f0-9]{32}$/);
});
test('only the current alias enters the backend; unrelated browser cookies remain untouched',()=>{
 const current=createLoopbackCookieIsolation(),old=createLoopbackCookieIsolation();
 const original={cookie:`other=value; oasis_quality_demo=legacy; ${old.name}=old; __Host-oasis_demo=forged; ${current.name}=current`,origin:'http://localhost:1234','x-host-csrf':'same'};
 const headers=Object.freeze({...original});
 assert.deepEqual(current.requestHeaders(headers),{cookie:'other=value; __Host-oasis_demo=current',origin:headers.origin,'x-host-csrf':'same'});
 assert.deepEqual(headers,original);
 assert.deepEqual(current.requestHeaders({cookie:'oasis_quality_demo=old; __Host-oasis_demo=forged'}),{});
 assert.deepEqual(current.requestHeaders({origin:'same'}),{origin:'same'});
});
test('response mapping preserves signed payload, HttpOnly, SameSite, expiry and other cookies',()=>{
 const isolation=createLoopbackCookieIsolation(),key=Buffer.alloc(32,1),now=1791415200000,issued=issueGuest(key,now);
 const values=Object.freeze([`__Host-oasis_demo=${issued.cookie}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,'another=x; Secure']);
 const result=isolation.responseHeaders(Object.freeze({'set-cookie':values}));
 assert.equal(result['set-cookie'][0],`${isolation.name}=${issued.cookie}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
 assert.equal(result['set-cookie'][1],values[1]);assert.match(values[0],/; Secure;/);
 const mapped=isolation.requestHeaders({cookie:result['set-cookie'][0].split(';')[0]}).cookie.slice('__Host-oasis_demo='.length);
 assert.equal(mapped,issued.cookie);assert.equal(verifyGuest(key,mapped,now),issued.guest);
 assert.equal(csrfFor(key,verifyGuest(key,mapped,now)),csrfFor(key,issued.guest));
 assert.throws(()=>verifyGuest(Buffer.alloc(32,2),mapped,now));assert.throws(()=>verifyGuest(key,mapped,now+100*86400000));
 assert.deepEqual(isolation.responseHeaders({foo:'bar'}),{foo:'bar'});
 assert.equal(isolation.responseHeaders({'set-cookie':['__Host-oasis_demo=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax']})['set-cookie'][0],`${isolation.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
});
test('duplicate current aliases and invalid signed values reach the original validation unchanged',()=>{
 const isolation=createLoopbackCookieIsolation();
 assert.equal(isolation.requestHeaders({cookie:`${isolation.name}=a; ${isolation.name}=b`}).cookie,'__Host-oasis_demo=a; __Host-oasis_demo=b');
 assert.equal(isolation.requestHeaders({cookie:`${isolation.name}=invalid`}).cookie,'__Host-oasis_demo=invalid');
});

async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
async function close(server){if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
test('real demo host rejects malformed/current stale cookies and bad CSRF while ignoring other instances',async()=>{
 const isolation=createLoopbackCookieIsolation(),old=createLoopbackCookieIsolation(),key=Buffer.alloc(32,3);let upstreamPort,launches=0;
 const gateway=createServer((req,res)=>{
  const upstream=request({host:'127.0.0.1',port:upstreamPort,path:req.url,method:req.method,headers:isolation.requestHeaders(req.headers)},response=>{res.writeHead(response.statusCode,isolation.responseHeaders(response.headers));response.pipe(res);});
  upstream.on('error',error=>res.destroy(error));req.pipe(upstream);
 });
 let host;
 try{
  const port=await listen(gateway),origin=`http://localhost:${port}`;
  host=await createDemoHost({origin},{key,backend:{games:async()=>({games:[]}),launch:async()=>{launches++;return{test_only:true};}}});upstreamPort=await listen(host);
  const stale=issueGuest(Buffer.alloc(32,2)).cookie;
  const first=await fetch(origin+'/api/demo/config',{headers:{cookie:`oasis_quality_demo=${stale}; ${old.name}=${stale}; __Host-oasis_demo=forged`}});
  assert.equal(first.status,200);const config=await first.json(),cookie=first.headers.get('set-cookie').split(';')[0];assert(cookie.startsWith(isolation.name+'='));
  const launch=csrf=>fetch(origin+'/api/demo/launch',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-host-csrf':csrf},body:JSON.stringify({game_id:'run',request_id:'test_request'})});
  const invalid=await launch('invalid');assert.equal(invalid.status,403);assert.equal((await invalid.json()).error.code,'CSRF_REJECTED');assert.equal(launches,0);
  const valid=await launch(config.csrf);assert.equal(valid.status,200);await valid.json();assert.equal(launches,1);
  for(const incoming of [`${isolation.name}=invalid`,`${isolation.name}=${stale}`,`${cookie}; ${cookie}`]){
   const response=await fetch(origin+'/api/demo/config',{headers:{cookie:incoming}});assert.equal(response.status,401);assert.equal((await response.json()).error.code,'DEMO_GUEST_INVALID');
   assert.match(response.headers.get('set-cookie'),new RegExp('^'+isolation.name+'=;'));assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  }
 }finally{await close(gateway);await close(host);}
});

const scope=()=>({origin:'http://localhost:34567',name:createLoopbackCookieIsolation().name});
test('finally cleanup is exact and runs for successful and failed owned browser work',async()=>{
 for(const failing of [false,true]){
  const owned=scope(),filters=[],context={clearCookies:async filter=>filters.push(filter),cookies:async origin=>{assert.equal(origin,owned.origin);return[{name:'unrelated',domain:'localhost',path:'/'}];}},original=new Error('original');
  const run=withOwnedLoopbackCookie(context,owned,async()=>{if(failing)throw original;return 42;});
  if(failing)await assert.rejects(run,error=>error===original);else assert.equal(await run,42);
  assert.deepEqual(filters,[{name:owned.name,domain:'localhost',path:'/'}]);
 }
});
test('cleanup rejects nonlocal scope before mutation and cannot claim success without readback',async()=>{
 const owned=scope(),never={clearCookies:async()=>assert.fail('scope must fail first')};
 for(const invalid of [{...owned,origin:'https://game.tianyahuyu.com'},{...owned,origin:'http://localhost'},{...owned,origin:'http://localhost:34567/path'},{...owned,name:'oasis_quality_demo'}])await assert.rejects(clearOwnedLoopbackCookie(never,invalid));
 const sticky={clearCookies:async()=>{},cookies:async()=>[{name:owned.name,domain:'localhost',path:'/'}]};
 await assert.rejects(clearOwnedLoopbackCookie(sticky,owned),/cleanup readback/);
 const original=new Error('original');await assert.rejects(withOwnedLoopbackCookie(sticky,owned,async()=>{throw original;}),error=>error instanceof AggregateError&&error.errors[0]===original&&/readback/.test(error.errors[1].message));
});
test('local favicon fixture handles only exact GET/HEAD and never filters API errors',()=>{
 for(const method of ['GET','HEAD']){
  const calls=[];assert.equal(serveLoopbackFavicon({url:'/favicon.ico',method},{writeHead:(...args)=>calls.push(args),end:()=>calls.push('end')}),true);assert.deepEqual(calls,[[204,{'cache-control':'no-store'}],'end']);
 }
 for(const [url,method]of [['/favicon.ico?x','GET'],['/favicon.ico/','GET'],['/api/demo/config','GET'],['/favicon.ico','POST']])assert.equal(serveLoopbackFavicon({url,method},{writeHead:()=>assert.fail('not fixture'),end:()=>assert.fail('not fixture')}),false);
});
