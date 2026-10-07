/** Public HTTPS sandbox host. Guest cookies identify test wallets, never real App users. */
import {createServer} from 'node:http';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {mkdir,open,readFile,lstat,readdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseTree} from 'jsonc-parser';
import {demoRateConfiguration} from '../server/rate-limit.mjs';
import {clientAddress} from '../server/proxy-context.mjs';
import {NATIVE_GAME_IDS} from './native-game-host.mjs';

export const COOKIE='__Host-oasis_demo';
const GUEST_LIFETIME=30*24*60*60;
const publicDir=fileURLToPath(new URL('../specs/examples/partner-host/public/',import.meta.url));
const sdkPath=fileURLToPath(new URL('../public/sdk/oasis-h5.mjs',import.meta.url));
const STATIC_CACHE_SECONDS=30*24*60*60;
const STATIC_ARCHIVE_SECONDS=45*24*60*60;
const STATIC_ARCHIVE_MAX_FILES=512;
const STATIC_ARCHIVE_MAX_BYTES=16*1024*1024;
const STATIC_FILE_MAX_BYTES=1024*1024;
// This registry is independent of the current bundle's filenames. A renamed
// public module remains readable by its old content-addressed URL until its
// cache promise expires; no other extension can be served from the archive.
const STATIC_ARCHIVE_TYPES=Object.freeze({mjs:'text/javascript',css:'text/css'});
const staticName=/^[a-z0-9-]+\.(mjs|css)$/;
const staticRoute=/^\/demo\/static\/([a-f0-9]{64})\/([a-z0-9-]+\.(mjs|css))$/;
const error=(status,code,message=code)=>Object.assign(new Error(message),{status,code});
const mac=(key,value)=>createHmac('sha256',key).update(value).digest('hex');
const sha256=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};

async function archivePublicStatic(dir,entries){
 await mkdir(dir,{recursive:true,mode:0o700});
 const directory=await lstat(dir);
 if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o777)!==0o700)throw new Error('DEMO_STATIC_ARCHIVE_UNSAFE');
 const protectedNames=new Set();
 for(const {digest,name,bytes,type} of entries){
  if(!staticName.test(name)||STATIC_ARCHIVE_TYPES[name.split('.').at(-1)]!==type)throw new Error('DEMO_STATIC_TYPE_UNSAFE');
  if(bytes.length>STATIC_FILE_MAX_BYTES)throw new Error('DEMO_STATIC_FILE_TOO_LARGE');
  const filename=digest+'-'+name,destination=path.join(dir,filename);protectedNames.add(filename);
  try{const info=await lstat(destination);if(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600&&info.size<=STATIC_FILE_MAX_BYTES&&Date.now()-info.mtimeMs<STATIC_ARCHIVE_SECONDS*1000){const old=await readFile(destination);if(sha256(old)===digest)continue;}}catch(e){if(e.code!=='ENOENT')throw e;}
  // A temporary 0600 file and atomic rename ensure a previous release cannot
  // observe a truncated asset while a new release is warming its archive.
  const temp=path.join(dir,'.'+randomBytes(12).toString('hex')+'.tmp');
  try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await rename(temp,destination);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 const now=Date.now(),files=[];
 for(const name of await readdir(dir)){
  const match=/^([a-f0-9]{64})-([a-z0-9-]+\.(mjs|css))$/.exec(name);
  if(!match)continue;
  const stat=await lstat(path.join(dir,name));
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.size>STATIC_FILE_MAX_BYTES)throw new Error('DEMO_STATIC_ARCHIVE_UNSAFE');
  if(!protectedNames.has(name)&&now-stat.mtimeMs>STATIC_ARCHIVE_SECONDS*1000){await unlink(path.join(dir,name));continue;}
  files.push({name,mtimeMs:stat.mtimeMs,size:stat.size});
 }
 // Every unexpired file may have advertised 30 days of immutable caching at
 // its last response. Never evict it merely to admit a new release.
 if(files.length>STATIC_ARCHIVE_MAX_FILES||files.reduce((sum,file)=>sum+file.size,0)>STATIC_ARCHIVE_MAX_BYTES)throw new Error('DEMO_STATIC_ARCHIVE_CAPACITY');
}

async function archivedStatic(dir,pathname,{current=false}={}){
 const match=staticRoute.exec(pathname);
 if(!match)return null;
 try{
  const file=path.join(dir,match[1]+'-'+match[2]),handle=await open(file,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
  try{
   const info=await handle.stat();
   if(!info.isFile()||(info.mode&0o777)!==0o600||info.size>STATIC_FILE_MAX_BYTES||(!current&&Date.now()-info.mtimeMs>STATIC_ARCHIVE_SECONDS*1000))return null;
   const body=await handle.readFile();
   if(sha256(body)!==match[1])return null;
   // mtime is the last successful service, not the release date. Touch before
   // sending a 200 or 304 so every 30-day max-age has at least 45 days of
   // archive availability behind it, including a request on day 44.
   const servedAt=new Date();await handle.utimes(servedAt,servedAt);
   return {body,type:STATIC_ARCHIVE_TYPES[match[3]],etag:'"'+match[1]+'"',cache:`public,max-age=${STATIC_CACHE_SECONDS},immutable`};
  }finally{await handle.close();}
 }catch{return null;}
}

export function parseConfig(env=process.env){
 const raw=env.OASIS_PUBLIC_ORIGIN;if(!raw)throw new Error('OASIS_PUBLIC_ORIGIN is required');
 const url=new URL(raw);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==raw.replace(/\/$/,''))throw new Error('OASIS_PUBLIC_ORIGIN must be an exact HTTPS origin');
 const port=Number(env.OASIS_DEMO_PORT||18885);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid OASIS_DEMO_PORT');
 return {origin:url.origin,host:url.host,port,localDir:env.OASIS_LOCAL_DIR||fileURLToPath(new URL('../.local/',import.meta.url)),rateLimits:demoRateConfiguration(env)};
}

export async function loadGuestKey(localDir){
 await mkdir(localDir,{recursive:true,mode:0o700});
 const filename=path.join(localDir,'hosted-demo-guest.key');
 try{const file=await open(filename,'wx',0o600);try{await file.writeFile(randomBytes(32));await file.sync();}finally{await file.close();}}catch(e){if(e.code!=='EEXIST')throw e;}
 const st=await lstat(filename);
 if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600)throw new Error('Guest key must be a regular private 0600 file');
 const key=await readFile(filename);if(key.length!==32)throw new Error('Guest key must contain 32 bytes');return key;
}

export function issueGuest(key,now=Date.now()){
 const guest='guest_'+randomBytes(16).toString('hex'),payload=guest+'.'+Math.floor(now/1000);
 return {guest,cookie:payload+'.'+mac(key,'guest:'+payload)};
}
export function verifyGuest(key,cookie,now=Date.now()){
 const match=/^(guest_[a-f0-9]{32})\.(\d{10})\.([a-f0-9]{64})$/.exec(cookie||'');
 if(!match||!same(match[3],mac(key,'guest:'+match[1]+'.'+match[2])))throw error(401,'DEMO_GUEST_INVALID','试玩身份无效，请刷新页面重新进入');
 const age=Math.floor(now/1000)-Number(match[2]);
 if(age<0||age>GUEST_LIFETIME)throw error(401,'DEMO_GUEST_EXPIRED','试玩身份已过期，请刷新页面重新进入');
 return match[1];
}
export const csrfFor=(key,guest)=>mac(key,'csrf:'+guest);
// Platform idempotency keys are App-wide. Bind user-supplied IDs to this guest.
export const launchRequestId=(key,guest,requestId)=>'demo_'+mac(key,'launch:'+guest+':'+requestId);

export function createRateLimiter({clock=Date.now,maxEntries=10000}={}){
 const buckets=new Map();
 return function consume(id,limit,windowMs){
  const now=clock();let bucket=buckets.get(id);
  if(!bucket||bucket.until<=now){
   if(buckets.size>=maxEntries){for(const [k,b]of buckets)if(b.until<=now)buckets.delete(k);}
   if(!bucket&&buckets.size>=maxEntries)throw Object.assign(error(429,'DEMO_RATE_LIMIT','请求过多，请稍后重试'),{retryAfterSeconds:Math.max(1,Math.ceil(windowMs/1000))});
   bucket={count:0,until:now+windowMs};buckets.set(id,bucket);
  }
  if(++bucket.count>limit)throw Object.assign(error(429,'DEMO_RATE_LIMIT','请求过多，请稍后重试'),{retryAfterSeconds:Math.max(1,Math.ceil((bucket.until-now)/1000))});
 };
}
function guestCookie(req){
 const found=(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
 if(found.length>1)throw error(401,'DEMO_GUEST_INVALID');
 return found[0]?.slice(COOKIE.length+1);
}
async function readBody(req){
 if(req.headers['content-encoding']||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw error(400,'INVALID_REQUEST');
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192)throw error(413,'BODY_TOO_LARGE');chunks.push(chunk);}
 let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw error(400,'INVALID_REQUEST');}
 const errors=[],tree=parseTree(raw,errors,{allowTrailingComma:false,disallowComments:true});
 if(errors.length||tree?.type!=='object')throw error(400,'INVALID_REQUEST');
 const names=(tree.children||[]).map(p=>p.children[0].value);
 if(new Set(names).size!==names.length)throw error(400,'INVALID_REQUEST');
 const b=JSON.parse(raw);
 if(typeof b.game_id!=='string'||typeof b.request_id!=='string'||(b.resume_session_id!==undefined&&typeof b.resume_session_id!=='string')||Object.keys(b).some(k=>!['game_id','request_id','resume_session_id'].includes(k))||!/^[-a-z0-9]{1,40}$/.test(b.game_id||'')||!/^[-A-Za-z0-9_]{8,128}$/.test(b.request_id||'')||(b.resume_session_id!==undefined&&!/^[-A-Za-z0-9_]{1,128}$/.test(b.resume_session_id)))throw error(400,'INVALID_REQUEST','只接受游戏、请求编号和原会话编号');
 return b;
}

export function demoSessionBody(scope,guest,b,origin){
 return {...scope,request_id:b.request_id,external_user_id:guest,game_id:b.game_id,locale:'zh-CN',host_platform:'web',host_origin:origin,...(b.resume_session_id?{resume_session_id:b.resume_session_id}:{})};
}

/** Imports live database modules only on real startup; unit tests inject their own backend. */
export async function createLiveBackend(config){
 const [platform,database,wallet,security]=await Promise.all([import('../server/platform.mjs'),import('../server/db.mjs'),import('../server/wallet/index.mjs'),import('../server/security.mjs')]);
 const partnerId='partner_hosted_public_demo';
 const appId=await database.locked('hosted-demo:app',async()=>{
  const rows=(await database.pool.query('SELECT id FROM gp_apps WHERE partner_id=$1 ORDER BY created_at',[partnerId])).rows;
  if(rows.length>1)throw new Error('Multiple hosted demo Apps exist; explicit operator repair required');
  if(rows.length)return rows[0].id;
  return (await platform.createApp('Hosted Demo · 测试币体验',{partnerId,actor:'hosted-demo'})).app.id;
 });
 async function getApp(){const app=await platform.appById(appId);if(app.environment!=='sandbox'||app.wallet_url!==(process.env.OASIS_REFERENCE_WALLET_URL||'http://127.0.0.1:8798'))throw error(503,'DEMO_SCOPE_UNAVAILABLE');return app;}
 await getApp();
 return {
  async games(){return platform.gamesFor(await getApp());},
  async launch(guest,b){
   const app=await getApp();
   const key=(await database.pool.query("SELECT * FROM gp_keys WHERE app_id=$1 AND direction='platform-to-wallet' AND active ORDER BY created_at DESC LIMIT 1",[app.id])).rows[0];
   if(!key)throw error(503,'DEMO_SCOPE_UNAVAILABLE');
   // provisionWallet uses INSERT ... ON CONFLICT DO NOTHING, including its initial
   // credit ledger entry. Repeated launch/restart never refills a spent balance.
   await wallet.provisionWallet(database.pool,{scope:platform.scope(app),key_id:key.id,secret_base64:security.unseal(key.secret_enc),users:[{external_user_id:guest,balance_minor:'1200000'}],treasury_minor:'1000000000000'});
   const body=demoSessionBody(platform.scope(app),guest,b,config.origin);
   // createSession performs the original App / user / game ownership checks on resume.
   return platform.createSession(app,body,JSON.stringify(body));
  }
 };
}

export async function createDemoHost(config,{backend,key,clock=Date.now}={}){
 if(!backend||!Buffer.isBuffer(key)||key.length!==32)throw new Error('Demo backend and private guest key required');
 const host=new URL(config.origin).host,consume=createRateLimiter({clock}),anonymous=createRateLimiter({clock}),limits=config.rateLimits||demoRateConfiguration();
 const files=new Map(),archiveEntries=[];
 // The HTML and API carry visitor state and must be fetched afresh. The public
 // scripts, styles and SDK are byte-identical for every visitor, so give each
 // build's exact bytes a distinct URL while keeping old unversioned URLs
 // revalidatable for pages already open during a release switch.
 const addStatic=(route,body,type)=>{
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(body);
  const digest=sha256(bytes),name=path.posix.basename(route);
  const file={body:bytes,type,etag:'"'+digest+'"'};
  files.set(route,{...file,cache:'public,max-age=0,must-revalidate'});
  const versioned='/demo/static/'+digest+'/'+name;
  files.set(versioned,{...file,cache:'public,max-age=0,must-revalidate',versioned:true});
  archiveEntries.push({digest,name,bytes,type});
  return versioned;
 };
 const sdkUrl=addStatic('/demo/sdk/oasis-h5.mjs',await readFile(sdkPath),'text/javascript');
 let index=await readFile(path.join(publicDir,'index.html'),'utf8');
 index=index.replaceAll('/host.css','/demo/host.css').replaceAll('/host.mjs','/demo/host.mjs').replace('href="/"','href="/demo/"').replace('<i>L</i><span>Lina<small>本地测试身份</small></span>','<i>G</i><span id="guest-name">试玩访客<small>独立测试身份</small></span>').replace('合作方 H5 自接入示例','OASIS 游戏试玩').replace('独立宿主 · 游戏在平台域内运行<br>仅限本地沙箱与测试币','每位访客独立测试钱包 · 初始 12,000 测试币<br>测试币无现金价值，不可充值或提现');
 let script=await readFile(path.join(publicDir,'host.mjs'),'utf8');
 script=script.replaceAll("'/sdk/oasis-h5.mjs'",`'${sdkUrl}'`).replaceAll('/api/host/','/api/demo/').replace("config=await json('/api/demo/config');","config=await json('/api/demo/config');$('#guest-name').firstChild.textContent=config.profile.name;");
 const scriptUrl=addStatic('/demo/host.mjs',script,'text/javascript');
 const cssUrl=addStatic('/demo/host.css',await readFile(path.join(publicDir,'host.css')),'text/css');
 index=index.replace('/demo/host.css',cssUrl).replace('/demo/host.mjs',scriptUrl);
 files.set('/demo/',{body:index,type:'text/html'});
 const nativePage=await readFile(new URL('./native-game-host.html',import.meta.url),'utf8');
 const nativeModuleUrl=addStatic('/demo/native-game-host.mjs',await readFile(new URL('./native-game-host.mjs',import.meta.url)),'text/javascript');
 const nativeBoot=(await readFile(new URL('./native-game-host-boot.mjs',import.meta.url),'utf8')).replace('/demo/sdk/oasis-h5.mjs',sdkUrl).replace('/demo/native-game-host.mjs',nativeModuleUrl);
 const nativeBootUrl=addStatic('/demo/native-game-host-boot.mjs',nativeBoot,'text/javascript');
 const nativeCssUrl=addStatic('/demo/native-game-host.css',await readFile(new URL('./native-game-host.css',import.meta.url)),'text/css');
 for(const game of NATIVE_GAME_IDS)files.set('/demo/native/'+game,{body:nativePage.replace('__OASIS_NATIVE_GAME__',game).replace('/demo/native-game-host.css',nativeCssUrl).replace('/demo/native-game-host-boot.mjs',nativeBootUrl),type:'text/html'});
 files.set('/demo/native-return',{body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已返回 App</title></head><body><p>已退出游戏，请返回 App 游戏大厅。</p></body></html>',type:'text/html'});
 let archiveDir=null;
 if(config.localDir){
  archiveDir=path.join(config.localDir,'demo-public-static-v1');
  await archivePublicStatic(archiveDir,archiveEntries);
 }
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${config.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`};
 const json=(res,status,value,extra={})=>{res.writeHead(status,{...headers,'content-type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));};
 const cookieHeader=value=>`${COOKIE}=${value}; Path=/; Max-Age=${GUEST_LIFETIME}; Secure; HttpOnly; SameSite=Lax`;
 const server=createServer(async(req,res)=>{try{
  if(req.headers.host!==host)throw error(403,'HOST_REJECTED');
  const parsed=new URL(req.url,'http://loopback.invalid'),pathname=parsed.pathname,rawPath=req.url.split('?')[0];
  if(rawPath.startsWith('/demo/static/')&&(rawPath!==pathname||parsed.search))throw error(404,'NOT_FOUND');
  if(req.headers.origin&&req.headers.origin!==config.origin)throw error(403,'ORIGIN_REJECTED');
  if(pathname.startsWith('/api/demo/')){
   if(req.headers['sec-fetch-site']==='cross-site')throw error(403,'ORIGIN_REJECTED');
   const ip=clientAddress(req,{trustLoopbackProxy:true});
   let cookie,guest;
   try{cookie=guestCookie(req);if(cookie)guest=verifyGuest(key,cookie,clock());}
   catch(e){anonymous('anonymous:'+ip,limits.DEMO_ANONYMOUS_IP,60000);throw e;}
   if(!guest)anonymous('anonymous:'+ip,limits.DEMO_ANONYMOUS_IP,60000);
   if(req.method==='GET'&&pathname==='/api/demo/config'){
    const extra={};
    if(!guest){const issued=issueGuest(key,clock());guest=issued.guest;cookie=issued.cookie;extra['set-cookie']=cookieHeader(cookie);}
    consume('guest:'+guest,limits.DEMO_GUEST_API,60000);
    return json(res,200,{platform_origin:config.origin,csrf:csrfFor(key,guest),profile:{name:'访客 '+guest.slice(-6).toUpperCase(),label:'独立测试身份'},scope:'PUBLIC SANDBOX · TEST CREDITS ONLY'},extra);
   }
   if(!guest)throw error(401,'DEMO_GUEST_INVALID','试玩身份无效，请刷新页面重新进入');
   consume('guest:'+guest,limits.DEMO_GUEST_API,60000);
   if(req.method==='GET'&&pathname==='/api/demo/games'){
    const result=await backend.games();return json(res,200,{games:result.games.filter(g=>g.available).map(g=>({id:g.game_id,title:g.title,category:g.category,players:g.modes?.flatMap(m=>m.player_counts)||[]}))});
   }
   if(req.method==='POST'&&pathname==='/api/demo/launch'){
    if(req.headers.origin!==config.origin||!same(req.headers['x-host-csrf'],csrfFor(key,guest)))throw error(403,'CSRF_REJECTED');
    consume('launch:'+guest,limits.DEMO_GUEST_LAUNCH,60000);
    const body=await readBody(req);body.request_id=launchRequestId(key,guest,body.request_id);
    return json(res,200,await backend.launch(guest,body));
   }
   throw error(404,'NOT_FOUND');
  }
  if(req.method==='GET'&&pathname==='/demo'){res.writeHead(308,{...headers,location:'/demo/'});return res.end();}
  let file=files.get(pathname);
  if(archiveDir&&staticRoute.test(pathname)){
   const archived=await archivedStatic(archiveDir,pathname,{current:!!file?.versioned});
   if(file?.versioned&&!archived)throw error(503,'DEMO_STATIC_ARCHIVE_UNAVAILABLE');
   file=archived;
  }
  if(!file||!['GET','HEAD'].includes(req.method))throw error(404,'NOT_FOUND');
  const cacheHeaders=file.etag?{'cache-control':file.cache,etag:file.etag}:{'cache-control':'no-store'};
  const matched=file.etag&&req.headers['if-none-match']?.split(',').some(tag=>tag.trim()==='*'||tag.trim().replace(/^W\//,'')===file.etag);
  if(matched){res.writeHead(304,{...headers,...cacheHeaders});return res.end();}
  res.writeHead(200,{...headers,...cacheHeaders,'content-type':file.type+'; charset=utf-8','content-length':Buffer.byteLength(file.body)});res.end(req.method==='HEAD'?undefined:file.body);
 }catch(e){
  if(e.status>=500||!e.status)console.error('Hosted demo request failed:',e.code||e.name||'Error');
  const extra=e.status===401?{'set-cookie':`${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`}:e.status===429?{'retry-after':String(e.retryAfterSeconds||60)}:{};
  json(res,e.status||502,{error:{code:e.code||'DEMO_UNAVAILABLE',message:e.status&&e.status<500?e.message:'游戏连接暂时不可用，请稍后重试'}},extra);
 }});
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
 return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const config=parseConfig(),key=await loadGuestKey(config.localDir),backend=await createLiveBackend(config);
 const server=await createDemoHost(config,{key,backend});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
 console.log(`Hosted sandbox demo listening on loopback ${config.port}; public entry ${config.origin}/demo/`);
}
