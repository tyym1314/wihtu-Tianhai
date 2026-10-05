import {readFileSync} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {pool as defaultPool} from './db.mjs';
import {id,seal,unseal,sign,fail,ApiError} from './security.mjs';

let pool=defaultPool;
const scopeFields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=a=>({partner_id:a.partner_id,app_id:a.id,environment:a.environment,wallet_scope_id:a.wallet_scope_id,currency_id:a.currency_id});
const safeId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const MAX_RESPONSE=131072,TIMEOUT=3000;
const ajv=new Ajv({strict:false});addFormats(ajv);
const contract=JSON.parse(readFileSync(new URL('../specs/openapi.json',import.meta.url),'utf8'));
const validBalance=ajv.compile({$ref:'#/components/schemas/BalanceResponse',components:contract.components});

export async function migrateWalletBindings(db=defaultPool){
  pool=db;
  await pool.query(`CREATE TABLE IF NOT EXISTS gp_wallet_bindings (
    app_id text PRIMARY KEY REFERENCES gp_apps(id),
    wallet_url text NOT NULL,
    wallet_key_id text NOT NULL REFERENCES gp_keys(id),
    scope jsonb NOT NULL,
    configured_by text NOT NULL,
    configured_at timestamptz NOT NULL DEFAULT now()
  )`);
}

function normalizedOrigin(value){
  if(typeof value!=='string'||value.length>512||value.trim()!==value)fail(400,'INVALID_WALLET_URL');
  let url;try{url=new URL(value);}catch{fail(400,'INVALID_WALLET_URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||![url.origin,url.origin+'/'].includes(value))fail(400,'INVALID_WALLET_URL','Use an exact HTTP(S) origin, without credentials, path, query or fragment');
  // Plain HTTP exists only for an explicitly approved loopback development service.
  if(url.protocol==='http:'&&!['127.0.0.1','[::1]'].includes(url.hostname))fail(400,'WALLET_HTTPS_REQUIRED');
  return url.origin;
}
function referenceOrigin(){return normalizedOrigin(process.env.OASIS_REFERENCE_WALLET_URL||'http://127.0.0.1:8798');}
function allowedOrigins(){return new Set((process.env.OASIS_WALLET_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean).map(normalizedOrigin));}
export function validateWalletOrigin(value,{external=false}={}){
  const origin=normalizedOrigin(value),allowed=allowedOrigins();
  if(!external)allowed.add(referenceOrigin());
  if(!allowed.has(origin))fail(403,'WALLET_ORIGIN_NOT_ALLOWED','Wallet origin is not in this deployment allowlist');
  if(external&&origin===referenceOrigin())fail(409,'REFERENCE_WALLET_NOT_EXTERNAL');
  return origin;
}

async function hasActivity(db,appId){
  return (await db.query(`SELECT
    EXISTS(SELECT 1 FROM gp_sessions WHERE app_id=$1) OR
    EXISTS(SELECT 1 FROM gp_cycles WHERE app_id=$1) OR
    EXISTS(SELECT 1 FROM gp_operations WHERE app_id=$1) OR
    EXISTS(SELECT 1 FROM pvp_rooms WHERE app_id=$1) OR
    EXISTS(SELECT 1 FROM pvp_operations WHERE app_id=$1) AS used`,[appId])).rows[0].used;
}
function publicBinding(app,binding,used,keyId){
  return {app_id:app.id,environment:app.environment,mode:binding?'external':app.environment==='production'?'unconfigured':'reference',wallet_url:binding?.wallet_url||app.wallet_url,
    wallet_key_id:binding?.wallet_key_id||keyId||null,configured_at:binding?.configured_at||null,
    locked:!!binding||used,can_configure:['sandbox','production'].includes(app.environment)&&app.status==='paused'&&!binding&&!used,
    has_activity:used,balance_migration:false};
}
export async function getWalletStatus(appId){
  const app=(await pool.query('SELECT * FROM gp_apps WHERE id=$1',[appId])).rows[0];if(!app)fail(404,'NOT_FOUND');
  const binding=(await pool.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1',[appId])).rows[0];
  const key=(await pool.query("SELECT id FROM gp_keys WHERE app_id=$1 AND direction='platform-to-wallet' AND active ORDER BY created_at DESC LIMIT 1",[appId])).rows[0];
  return publicBinding(app,binding,await hasActivity(pool,appId),key?.id);
}

/** One-time binding for a pristine paused sandbox. No reference balance is read or copied. */
export async function configureWallet(appId,input,actor){
  if(!input||Object.keys(input).some(k=>!['wallet_url','wallet_key_id','wallet_secret_base64'].includes(k)))fail(400,'INVALID_REQUEST');
  const wallet_url=validateWalletOrigin(input.wallet_url,{external:true}),wallet_key_id=input.wallet_key_id,secret=input.wallet_secret_base64;
  if(!safeId(appId)||!safeId(wallet_key_id)||typeof secret!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(secret))fail(400,'INVALID_WALLET_KEY');
  const bytes=Buffer.from(secret,'base64');if(bytes.length<32||bytes.length>128||bytes.toString('base64')!==secret)fail(400,'INVALID_WALLET_KEY','Wallet key must be 32–128 random bytes encoded as canonical Base64');
  if(typeof actor!=='string'||!actor||actor.length>128)fail(400,'INVALID_ACTOR');
  const db=await pool.connect();try{
    await db.query('BEGIN');
    // createSession takes the same row lock. A concurrent launch cannot slip past this check.
    const app=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[appId])).rows[0];if(!app)fail(404,'NOT_FOUND');
    if(!['sandbox','production'].includes(app.environment)||app.status!=='paused')fail(409,'WALLET_BINDING_REQUIRES_PAUSED_SANDBOX');
    if(app.environment==='production'&&!wallet_url.startsWith('https://'))fail(400,'WALLET_HTTPS_REQUIRED');
    if((await db.query('SELECT 1 FROM gp_wallet_bindings WHERE app_id=$1',[appId])).rowCount)fail(409,'WALLET_ALREADY_BOUND');
    if(await hasActivity(db,appId))fail(409,'WALLET_BINDING_HAS_ACTIVITY','Existing sessions or money operations prevent wallet replacement; create a separate sandbox App');
    if((await db.query('SELECT 1 FROM gp_keys WHERE id=$1',[wallet_key_id])).rowCount)fail(409,'WALLET_KEY_ALREADY_USED');
    await db.query("UPDATE gp_keys SET active=false WHERE app_id=$1 AND direction='platform-to-wallet'",[appId]);
    await db.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3)",[wallet_key_id,appId,seal(secret)]);
    const binding=(await db.query('INSERT INTO gp_wallet_bindings(app_id,wallet_url,wallet_key_id,scope,configured_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[appId,wallet_url,wallet_key_id,JSON.stringify(scopeOf(app)),actor])).rows[0];
    await db.query('UPDATE gp_apps SET wallet_url=$2 WHERE id=$1',[appId,wallet_url]);
    await db.query("INSERT INTO gp_audit(actor,action,app_id,detail) VALUES($1,'wallet.bound',$2,$3)",[actor,appId,JSON.stringify({wallet_url,wallet_key_id,balance_migration:false})]);
    await db.query('COMMIT');return publicBinding({...app,wallet_url},binding,false,wallet_key_id);
  }catch(e){await db.query('ROLLBACK');if(e.code==='23505')fail(409,'WALLET_KEY_ALREADY_USED');throw e;}finally{db.release();}
}

const forbidden4=new BlockList(),forbidden6=new BlockList();
for(const [network,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])forbidden4.addSubnet(network,bits,'ipv4');
for(const [network,bits] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32],['2001::',32],['2002::',16]])forbidden6.addSubnet(network,bits,'ipv6');
export function isPublicWalletAddress(address){const family=isIP(address);return family!==0&&!(family===4?forbidden4:forbidden6).check(address,family===4?'ipv4':'ipv6');}
async function resolvedTarget(url,signal){
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(url.protocol==='http:')return{address:hostname,family:isIP(hostname)};
  const candidates=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await Promise.race([
    lookup(hostname,{all:true,verbatim:true}),
    new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('Wallet DNS timeout')),{once:true}))
  ]);
  if(!candidates.length||candidates.some(c=>!isPublicWalletAddress(c.address)))fail(403,'WALLET_ADDRESS_FORBIDDEN','HTTPS wallet DNS must resolve only to public addresses');
  return candidates[0];
}
async function requestJson(origin,method,path,headers,raw){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
  try{
    const url=new URL(origin),target=await resolvedTarget(url,controller.signal);
    if(controller.signal.aborted)fail(503,'WALLET_UNKNOWN');
    return await new Promise((resolve,reject)=>{
      const transport=url.protocol==='https:'?https:http;
      // The one validated DNS answer is used by the socket: no second DNS lookup/rebinding window.
      const req=transport.request({protocol:url.protocol,hostname:url.hostname.replace(/^\[|\]$/g,''),port:url.port||undefined,path,method,headers,
        agent:false,signal:controller.signal,lookup:(_host,opts,callback)=>opts.all?callback(null,[target]):callback(null,target.address,target.family)},res=>{
        if(res.statusCode>=300&&res.statusCode<400){res.destroy();reject(new ApiError(503,'WALLET_REDIRECT_FORBIDDEN'));return;}
        if(!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type']||'')){res.destroy();reject(new ApiError(503,'WALLET_INVALID_RESPONSE'));return;}
        if(res.headers['content-encoding']||Number(res.headers['content-length']||0)>MAX_RESPONSE){res.destroy();reject(new ApiError(503,'WALLET_RESPONSE_TOO_LARGE'));return;}
        const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>MAX_RESPONSE){res.destroy();reject(new ApiError(503,'WALLET_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try{const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));resolve({status:res.statusCode,body:JSON.parse(text)});}catch{reject(new ApiError(503,'WALLET_INVALID_RESPONSE'));}});
      });
      req.on('error',reject);req.end(method==='GET'?undefined:raw);
    });
  }catch(e){if(e instanceof ApiError)throw e;fail(503,'WALLET_UNKNOWN','Wallet outcome is unknown; retain the original operation ID and query it');}finally{clearTimeout(timer);}
}

/** Shared transport for probability, PvP and balance probes. No money retry is performed here. */
export async function walletRequest(app,method,path,raw='',requestId=id('walletquery')){
  if(!app||!safeId(app.id)||!['GET','POST'].includes(method)||typeof raw!=='string'||!/^\/wallet\/v1(?:\/[A-Za-z0-9_-]+)+$/.test(path)||!safeId(requestId)||(method==='GET'&&raw))fail(400,'INVALID_WALLET_REQUEST');
  const binding=(await pool.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1',[app.id])).rows[0];
  if(binding&&(app.wallet_url!==binding.wallet_url||scopeFields.some(k=>scopeOf(app)[k]!==binding.scope[k])))fail(503,'WALLET_BINDING_CHANGED');
  if(app.environment==='production'&&(!binding||!binding.wallet_url.startsWith('https://')))fail(503,'PRODUCTION_EXTERNAL_WALLET_REQUIRED');
  const origin=validateWalletOrigin(binding?.wallet_url||app.wallet_url,{external:!!binding});
  const key=(await pool.query("SELECT * FROM gp_keys WHERE app_id=$1 AND direction='platform-to-wallet' AND active AND ($2::text IS NULL OR id=$2) ORDER BY created_at DESC LIMIT 1",[app.id,binding?.wallet_key_id||null])).rows[0];
  if(!key)fail(503,'WALLET_NOT_CONFIGURED');
  const headers=sign({key_id:key.id,secret_base64:unseal(key.secret_enc),direction:'platform-to-wallet',method,path,raw,request_id:requestId});
  const {status,body}=await requestJson(origin,method,path,headers,raw);
  if(!body||typeof body!=='object'||Array.isArray(body))fail(503,'WALLET_INVALID_RESPONSE');
  if(status>=400&&!(body.state==='REJECTED'&&body.operation_id===requestId))fail(status,body.error?.code||body.code||'WALLET_ERROR','Wallet request rejected; inspect the original operation ID');
  return body;
}
export async function validatedWalletBalance(app,external_user_id){
  if(!safeId(external_user_id))fail(400,'INVALID_USER');
  const response=await walletRequest(app,'GET',`/wallet/v1/scopes/${app.wallet_scope_id}/currencies/${app.currency_id}/users/${external_user_id}/balance`);
  if(!validBalance(response)||scopeFields.some(k=>response[k]!==scopeOf(app)[k])||response.balance.external_user_id!==external_user_id||response.balance.currency_scale!==app.currency_scale)fail(503,'WALLET_INVALID_BALANCE');
  return response;
}
export async function probeWallet(appId,{external_user_id}){
  const app=(await pool.query('SELECT * FROM gp_apps WHERE id=$1',[appId])).rows[0];if(!app)fail(404,'NOT_FOUND');
  const start=Date.now(),balance=await validatedWalletBalance(app,external_user_id);
  return{app_id:app.id,checked_at:new Date().toISOString(),elapsed_ms:Date.now()-start,read_only:true,balance};
}
