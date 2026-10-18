/**
 * Demo third-party partner, deployable on its own HTTPS host. It plays both partner roles:
 *  - Partner wallet: the simple-v1 protocol (balance / debit / credit) on /wallet/simple/v1/*, own database.
 *  - Partner backend: signs POST /v1/sessions with the App key and opens /launch/ on the platform.
 * The page only offers fixed demo users with demo coins. Real partners authenticate their own users.
 */
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {OasisClient} from '../../specs/examples/sdk-node.mjs';
import {migrateSimpleDemoWallet,seedSimpleDemoUsers,handleSimpleWallet} from './simple-wallet.mjs';

const GAMES=[['match','三消对战'],['golf','绿洲高尔夫'],['bowling','保龄球'],['carrom','Carrom 弹盘'],['darts','飞镖'],['ludo','Ludo'],['jackaroo','Jackaroo'],['domino','多米诺'],['pool','八球'],['run','沙丘竞速'],['towerlink','连线占塔'],['thunder','雷霆'],['tiger','虎虎生财'],['greedylion','GreedyLion'],['rocketstar2','RocketStar2'],['teenpatti','TeenPatti'],['olympus','Olympus'],['greedycat2','GreedyCat2'],['greedyking','GreedyKing'],['greedybrutal','GreedyBrutal'],['bigeater','BigEater'],['fruitparty','FruitParty']];

async function loadConfig(path){
 const info=await stat(path);if(!info.isFile()||(info.mode&0o077)!==0)throw Error('Config must be a regular file with mode 0600');
 const c=JSON.parse(await readFile(path,'utf8'));
 for(const k of ['platform_base_url','key_id','secret_base64','scope','wallet'])if(!c[k])throw Error('Missing config '+k);
 if(!Array.isArray(c.wallet.users)||!c.wallet.users.length)throw Error('wallet.users required');
 return c;
}
const html=(users,platform)=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Demo Partner App</title>
<style>body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#0f1530;color:#eef}header{padding:22px 18px 8px}h1{margin:0;font-size:20px}small{opacity:.7}
.langs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:4px 18px}.users,.games{display:grid;gap:10px;padding:10px 18px}.users{grid-template-columns:repeat(2,1fr)}.games{grid-template-columns:repeat(3,1fr)}
button{border:1px solid #3d4a85;background:#18214a;color:#eef;border-radius:12px;padding:12px 8px;font-size:14px}button.sel{border-color:#f3c76b;background:#2a2a52}
.bal{display:block;font-size:12px;color:#f3c76b;margin-top:4px}#msg{padding:6px 18px;color:#f99;min-height:20px}</style></head><body>
<header><h1>Demo Partner App</h1><small>第三方接入演示 · 演示币 · 平台 ${platform}</small></header>
<div class="users" id="users">${users.map((u,i)=>`<button data-user="${u}" class="${i?'':'sel'}">${u}<span class="bal" id="bal-${u}">…</span></button>`).join('')}</div>
<div class="langs" id="langs">${[['zh','中文'],['en','English'],['ar','العربية']].map(([l,n],i)=>`<button data-lang="${l}" class="${i?'':'sel'}">${n}</button>`).join('')}</div><div id="msg"></div><div class="games">${GAMES.map(([id,name])=>`<button data-game="${id}">${name}</button>`).join('')}</div>
<script>
let user=${JSON.stringify(users[0])},lang='zh';
document.getElementById('langs').onclick=e=>{const b=e.target.closest('[data-lang]');if(!b)return;lang=b.dataset.lang;for(const x of document.querySelectorAll('[data-lang]'))x.classList.toggle('sel',x===b);};
document.getElementById('users').onclick=e=>{const b=e.target.closest('[data-user]');if(!b)return;user=b.dataset.user;for(const x of document.querySelectorAll('[data-user]'))x.classList.toggle('sel',x===b);};
async function balances(){try{const r=await fetch('/demo/balances',{cache:'no-store'});const d=await r.json();for(const [u,v] of Object.entries(d))document.getElementById('bal-'+u).textContent=(Number(v)/100).toLocaleString()+' 币';}catch{}}
document.querySelector('.games').onclick=async e=>{const b=e.target.closest('[data-game]');if(!b)return;document.getElementById('msg').textContent='';
 try{const r=await fetch('/demo/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user,game:b.dataset.game,lang})});const d=await r.json();if(!r.ok)throw new Error(d.error||r.status);location.href=d.url;}
 catch(err){document.getElementById('msg').textContent='启动失败：'+err.message;}};
balances();addEventListener('pageshow',balances);
</script></body></html>`;

export async function startPartnerDemo({configPath=process.env.OASIS_DEMO_CONFIG,databaseUrl=process.env.OASIS_DEMO_WALLET_DATABASE_URL,port=Number(process.env.OASIS_DEMO_PORT||18901)}={}){
 if(!configPath||!databaseUrl)throw Error('Set OASIS_DEMO_CONFIG and OASIS_DEMO_WALLET_DATABASE_URL');
 const config=await loadConfig(resolve(configPath));
 const pool=new pg.Pool({connectionString:databaseUrl,max:10});
 await migrateSimpleDemoWallet(pool);await seedSimpleDemoUsers(pool,config.wallet.users);
 const client=new OasisClient({baseUrl:config.platform_base_url,keyId:config.key_id,secretBase64:config.secret_base64,scope:config.scope});
 const users=config.wallet.users.map(u=>u.external_user_id);
 const page=html(users,config.platform_base_url);
 const send=(res,status,body,type='application/json')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(type==='application/json'?JSON.stringify(body):body);};
 const server=createServer(async(req,res)=>{
  try{
   const path=(req.url||'/').split('?')[0];
   if(path.startsWith('/wallet/simple/')){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)return send(res,413,{error:'too large'});}await handleSimpleWallet(pool,{keyId:config.wallet.key_id,secretBase64:config.wallet.secret_base64},req,res,raw);return;}
   if(path==='/'&&req.method==='GET')return send(res,200,page,'text/html; charset=utf-8');
   if(path==='/demo/balances'&&req.method==='GET'){const rows=(await pool.query('SELECT external_user_id,balance_minor AS available FROM demo_simple_accounts')).rows;return send(res,200,Object.fromEntries(rows.filter(r=>users.includes(r.external_user_id)).map(r=>[r.external_user_id,r.available])));}
   if(path==='/demo/launch'&&req.method==='POST'){
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024)return send(res,413,{error:'too large'});}
    const {user,game,lang='zh'}=JSON.parse(raw||'{}');
    if(!users.includes(user)||!GAMES.some(([id])=>id===game)||!['zh','en','ar'].includes(lang))return send(res,400,{error:'invalid user or game'});
    const s=await client.createSession({requestId:'demo_'+randomBytes(12).toString('hex'),externalUserId:user,gameId:game,locale:lang,hostPlatform:'web'});
    return send(res,200,{url:`${config.platform_base_url}/launch/?game=${game}&lang=${lang}#code=${encodeURIComponent(s.launch_code)}&session=${encodeURIComponent(s.session_id)}`});
   }
   send(res,404,{error:'not found'});
  }catch(error){send(res,error.status&&error.status<500?error.status:502,{error:error.code||error.message||'error'});}
 });
 await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});
 return{server,pool,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();}};
}
if(import.meta.url===`file://${process.argv[1]}`){
 const service=await startPartnerDemo();
 console.log(JSON.stringify({service:'oasis-partner-demo',port:service.server.address().port}));
 const stop=async()=>{await service.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
