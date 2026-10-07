import {createHash,createHmac,randomBytes,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseTree} from 'jsonc-parser';
import {finishRoomReadTiming} from './request-timing.mjs';
export const localDir=(process.env.OASIS_LOCAL_DIR||fileURLToPath(new URL('../.local/',import.meta.url))).replace(/\/?$/,'/');
mkdirSync(localDir,{recursive:true,mode:0o700});
const masterPath=localDir+'master.key';
if(process.env.OASIS_ENVIRONMENT==='production'&&!existsSync(masterPath))throw Error('PRODUCTION_MASTER_KEY_MISSING');
if(!existsSync(masterPath)) writeFileSync(masterPath,randomBytes(32),{mode:0o600,flag:'wx'});
const master=readFileSync(masterPath);
if(master.length!==32)throw Error('INVALID_MASTER_KEY_LENGTH');
export const id=(prefix='id')=>prefix+'_'+randomBytes(16).toString('hex');
export const hash=value=>createHash('sha256').update(value).digest('hex');
export class ApiError extends Error { constructor(status,code,message=code) {super(message);this.status=status;this.code=code;} }
export const fail=(status,code,message)=>{throw new ApiError(status,code,message);};
export function seal(value) {const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',master,iv),data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');}
export function unseal(value) {const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',master,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());}
export function sign({key_id,secret_base64,direction='partner-to-platform',method='POST',path,raw='',request_id,timestamp=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString('hex')}) {
  const canonical=['GP-HMAC-SHA256-V1',direction,key_id,timestamp,nonce,request_id,method,path,hash(raw)].join('\n');
  const signature=createHmac('sha256',Buffer.from(secret_base64,'base64')).update(canonical).digest('hex');
  return {'content-type':'application/json','X-GP-Key-Id':key_id,'X-GP-Direction':direction,'X-GP-Timestamp':timestamp,'X-GP-Nonce':nonce,'X-GP-Request-Id':request_id,'X-GP-Signature':'v1='+signature};
}
export function verifySignature(req,raw,key,direction) {
  const h=req.headers; const kid=h['x-gp-key-id'],t=h['x-gp-timestamp'],nonce=h['x-gp-nonce'],rid=h['x-gp-request-id'],sig=h['x-gp-signature'];
  if(h['x-gp-direction']!==direction||!/^\d{10}$/.test(t||'')||!/^[a-f0-9]{32}$/.test(nonce||'')||!/^[A-Za-z0-9_-]{1,128}$/.test(rid||'')||!/^v1=[a-f0-9]{64}$/.test(sig||'')||!/^(\/[A-Za-z0-9_-]+)+$/.test(req.url||'')) fail(401,'SIGNATURE_INVALID');
  if(Math.abs(Date.now()/1000-Number(t))>300) fail(401,'TIMESTAMP_EXPIRED');
  const expected=sign({key_id:kid,secret_base64:key.secret_base64,direction,method:req.method,path:req.url,raw,request_id:rid,timestamp:t,nonce})['X-GP-Signature'];
  if(!timingSafeEqual(Buffer.from(expected),Buffer.from(sig))) fail(401,'SIGNATURE_INVALID');
  return {request_id:rid,nonce};
}
export async function readBody(req) {
  if(req.headers['content-encoding']) fail(400,'INVALID_REQUEST');
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)fail(413,'BODY_TOO_LARGE');chunks.push(chunk);}
  const buf=Buffer.concat(chunks);let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(buf);}catch{fail(400,'INVALID_REQUEST','Body must be valid UTF-8');}
  if(!raw)return {raw:'',body:{}};
  if(!req.headers['content-type']?.startsWith('application/json')||raw.charCodeAt(0)===0xfeff)fail(400,'INVALID_REQUEST');
  const errors=[],tree=parseTree(raw,errors,{allowTrailingComma:false,disallowComments:true});
  function walk(n){if(n?.type==='object'){const seen=new Set();for(const p of n.children||[]){const key=p.children[0].value;if(seen.has(key))fail(400,'DUPLICATE_JSON_KEY');seen.add(key);walk(p.children[1]);}}else for(const child of n?.children||[])walk(child);}
  if(errors.length||tree?.type!=='object')fail(400,'INVALID_REQUEST');walk(tree);return {raw,body:JSON.parse(raw)};
}
export function send(res,status,value){const body=JSON.stringify(value);finishRoomReadTiming(res);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(body);}
