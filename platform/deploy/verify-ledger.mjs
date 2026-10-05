/** External sandbox only: two isolated guest wallets and one 10-coin duel. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const origin=process.env.OASIS_VERIFY_ORIGIN||'https://game.tianyahuyu.com';
const id=()=>crypto.randomUUID().replaceAll('-','');
const report={at:new Date().toISOString(),origin,scope:'Two independent HTTP guests, reference-wallet test credits only; not native-phone multiplayer acceptance.',passed:false};
async function api(path,{cookie,csrf,token,body,expected=200}={}){
 const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json',origin}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-host-csrf':csrf}:{}),...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 const data=await r.json();assert.equal(r.status,expected,`${path}: ${JSON.stringify(data)}`);return {data,cookie:r.headers.getSetCookie?.()[0]?.split(';')[0]};
}
async function guest(){const {data,cookie}=await api('/api/demo/config');return {cookie,csrf:data.csrf,name:data.profile.name};}
async function launch(g,body){return (await api('/api/demo/launch',{...g,body})).data;}
async function balance(g){const r=(await api('/api/arena/session',g)).data;return r.balance.balance.available_minor;}
async function post(g,path,body){return (await api(path,{...g,body})).data;}
async function until(fn){for(let i=0;i<40;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,250));}throw Error('Settlement timeout');}
const a=await guest(),b=await guest();assert.notEqual(a.cookie,b.cookie);
const request={game_id:'match',request_id:'ledger_'+id()},la=await launch(a,request),repeated=await launch(a,request),lb=await launch(b,request);assert.deepEqual(repeated,la);assert.notEqual(la.session_id,lb.session_id);
await api('/api/demo/launch',{...b,body:{game_id:'match',request_id:id(),resume_session_id:la.session_id},expected:403});
for(const [g,l]of [[a,la],[b,lb]])g.token=(await post(g,'/v1/launch/exchange',{launch_code:l.launch_code,client_instance_id:id(),host_origin:origin,game_id:'match'})).access_token;
const before=[await balance(a),await balance(b)];
const room=(await api('/api/pvp/rooms',{...a,body:{request_id:id(),game_id:'match',capacity:2,entry_minor:'1000',practice:false},expected:201})).data;
await post(b,`/api/pvp/rooms/${room.code}/join`,{request_id:id()});
await post(a,`/api/pvp/rooms/${room.id}/ready`,{request_id:id()});
await post(b,`/api/pvp/rooms/${room.id}/ready`,{request_id:id()});
await until(async()=>{const r=(await api(`/api/pvp/rooms/${room.id}`,a)).data;return r.status==='active'&&r;});
const leave={request_id:id()};await post(a,`/api/pvp/rooms/${room.id}/leave`,leave);
const settled=await until(async()=>{const r=(await api(`/api/pvp/rooms/${room.id}`,b)).data;return r.status==='settled'&&r;});
const after=[await balance(a),await balance(b)];
await post(a,`/api/pvp/rooms/${room.id}/leave`,leave);
const replay=[await balance(a),await balance(b)];assert.deepEqual(after,replay);
const stake=BigInt(room.entry_minor),fee=stake*2n*BigInt(room.fee_bps)/10000n;
assert.equal(BigInt(after[0]),BigInt(before[0])-stake);
assert.equal(BigInt(after[1]),BigInt(before[1])+stake-fee);
Object.assign(report,{guestIsolation:true,crossGuestResumeRejected:true,launchRetryStable:true,room:room.id,status:settled.status,entry_minor:room.entry_minor,fee_minor:String(fee),before,after,replayUnchanged:true,passed:true});
await fs.writeFile(new URL('../.local/deployment-restart-probe.json',import.meta.url),JSON.stringify({origin,a,b,after,session:la.session_id}),{mode:0o600});
await fs.writeFile(new URL('../review/deployment/public-ledger.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
