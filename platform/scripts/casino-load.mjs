// Local load test: N simulated players on real sessions (admin launch -> exchange -> game API), mixed across game families.
// usage: node scripts/casino-load-provision.mjs 320 && node scripts/casino-load.mjs <players> <seconds>  (local sandbox only)
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const [N=300,SECS=180]=process.argv.slice(2).map(Number);
const base='http://127.0.0.1:8797',origin='http://127.0.0.1:8795',creds=JSON.parse(readFileSync(new URL('../.local/development-credentials.json',import.meta.url)));
let cookie='';const rid=()=>randomUUID().replaceAll('-','');
async function admin(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin,cookie},body:body&&JSON.stringify(body)});const s=r.headers.get('set-cookie');if(s)cookie=s.split(';')[0];return r.json();}
const stats={};const rec=(k,ms,ok,code)=>{const s=stats[k]||(stats[k]={n:0,err:0,lat:[],codes:{}});s.n++;s.lat.push(ms);if(!ok){s.err++;s.codes[code]=(s.codes[code]||0)+1;}};
async function call(token,path,body,k){const t=performance.now();try{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin,authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined});const d=await r.json();rec(k,performance.now()-t,r.ok,d.error?.code||r.status);return r.ok?d:null;}catch(e){rec(k,performance.now()-t,false,'NET');return null;}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await admin('/api/admin/login',{username:creds.username,password:creds.password});
const app=(await admin('/api/admin/apps')).apps.find(a=>a.environment==='sandbox'&&a.status==='active');
// Mix: shared-round wheel 40%, crash 20%, line slot 20%, tumble slot 10%, arcade 10%.
const plan=i=>{const r=i%10;return r<4?['greedylion','greedycat2','fruitparty','roulette'][i%4]:r<6?['rocketstar2','crash'][i%2]:r<8?['oceanslot','mahjongslot','sphinxlegend'][i%3]:r<9?'olympus':'monster';};
async function session(i){const game=plan(i);
 const l=await admin(`/api/admin/apps/${app.id}/launch`,{game_id:game,external_user_id:`lt_${i}`});
 const t=performance.now();const r=await fetch(base+'/v1/launch/exchange',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({launch_code:l.launch_code,client_instance_id:`lt${i}`,host_origin:origin,game_id:game})});
 const d=await r.json();rec('exchange',performance.now()-t,r.ok,d.error?.code||d.code);return {game,token:d.access_token};}
const end=Date.now()+SECS*1000;
async function player(i){
 const {game,token}=await session(i);if(!token)return;
 const G=(await import('../shared/casino-games.mjs')).CASINO_GAMES[game];
 await sleep(Math.random()*3000);
 while(Date.now()<end){
  if(G.kind==='instant'){const s=await call(token,'/api/casino/spin',{request_id:rid(),stake_minor:G.stakes[0]},'spin');
   if(s?.status==='CHOOSING')await call(token,'/api/casino/choose',{spin_id:s.id,choice:Math.floor(Math.random()*4)},'choose');await sleep(1800+Math.random()*1500);}
  else if(G.family==='arcade'){const a=await call(token,'/api/casino/arcade/open',{request_id:rid(),bet_minor:G.arcade.bets[0],shots:30},'arcade.open');if(!a){await sleep(2000);continue;}
   for(let k=1;k<=30&&Date.now()<end;k++){await call(token,'/api/casino/arcade/shoot',{arcade_id:a.id,seq:k,weapon:'arrow',targets:['goblin']},'arcade.shoot');await sleep(600+Math.random()*400);}
   await call(token,'/api/casino/arcade/close',{arcade_id:a.id},'arcade.close');}
  else{const st=await call(token,'/api/casino/state',null,'state');if(!st){await sleep(1000);continue;}
   const r=st.round,now=st.server_now;
   if(now<r.bet_until-1500&&!st.my_bets.length){
    if(G.family==='crash'){const b=await call(token,'/api/casino/bets',{request_id:rid(),round_id:r.id,option_id:'a',stake_minor:G.chips[0],auto_x100:[150,200,300][i%3]},'bet');
     if(b&&i%2){await sleep(r.bet_until-now+800+Math.random()*1500);await call(token,'/api/casino/cashout',{bet_id:b.id},'cashout');}}
    else for(const o of G.options.slice(0,2))await call(token,'/api/casino/bets',{request_id:rid(),round_id:r.id,option_id:o.id,stake_minor:G.chips[0]},'bet');}
   await sleep(1000);}
 }
}
const t0=Date.now();const players=[];for(let i=0;i<N;i++){players.push(player(i));if(i%20===19)await sleep(250);}
const mon=setInterval(()=>{const tot=Object.values(stats).reduce((a,s)=>a+s.n,0);process.stdout.write(`t=${Math.round((Date.now()-t0)/1000)}s requests=${tot}\n`);},15000);
await Promise.all(players);clearInterval(mon);
const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return Math.round(s[Math.min(s.length-1,Math.floor(s.length*p))]);};
const secs=(Date.now()-t0)/1000;console.log(`\nplayers=${N} duration=${Math.round(secs)}s`);
for(const [k,s] of Object.entries(stats))console.log(k.padEnd(14),'n',String(s.n).padStart(6),'rps',(s.n/secs).toFixed(1).padStart(6),'p50',String(pct(s.lat,.5)).padStart(5),'p95',String(pct(s.lat,.95)).padStart(5),'p99',String(pct(s.lat,.99)).padStart(5),'err',s.err,JSON.stringify(s.codes));
