import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { visit } from 'jsonc-parser';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export class WalletError extends Error { constructor(code,message,status=409){super(message);this.code=code;this.status=status;} }
export function parseRaw(raw){
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw new WalletError('INVALID_REQUEST','Body must be UTF-8',400);}
 if(text.charCodeAt(0)===0xfeff)throw new WalletError('INVALID_REQUEST','BOM forbidden',400);
 let value;try{value=JSON.parse(text);}catch{throw new WalletError('INVALID_REQUEST','Invalid JSON',400);}
 const stack=[];let duplicate=false;
 visit(text,{onObjectBegin(){stack.push(new Set());},onObjectProperty(name){const keys=stack.at(-1);if(keys.has(name))duplicate=true;keys.add(name);},onObjectEnd(){stack.pop();}},{disallowComments:true,allowTrailingComma:false});
 if(duplicate||!value||Array.isArray(value)||typeof value!=='object')throw new WalletError('INVALID_REQUEST','Duplicate keys or non-object JSON',400);
 return value;
}
export function canonical({direction,key_id,timestamp,nonce,request_id,method,path,raw_body}){return ['GP-HMAC-SHA256-V1',direction,key_id,String(timestamp),nonce,request_id,method.toUpperCase(),path,sha256(raw_body)].join('\n');}
export function signWalletRequest({key_id,secret_base64,request_id,method='POST',path,raw_body='',nonce,timestamp=Math.floor(Date.now()/1000)}){
 const p={direction:'platform-to-wallet',key_id,timestamp,nonce,request_id,method,path,raw_body};
 return {'content-type':'application/json','x-gp-key-id':key_id,'x-gp-direction':p.direction,'x-gp-timestamp':String(timestamp),'x-gp-nonce':nonce,'x-gp-request-id':request_id,'x-gp-signature':'v1='+createHmac('sha256',Buffer.from(secret_base64,'base64')).update(canonical(p)).digest('hex')};
}
export async function verifyWalletRequest(pool,req,raw){
 const h=req.headers;const p={direction:h['x-gp-direction'],key_id:h['x-gp-key-id'],timestamp:h['x-gp-timestamp'],nonce:h['x-gp-nonce'],request_id:h['x-gp-request-id'],method:req.method,path:req.url,raw_body:raw};
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(p.key_id||'')||!/^\d{10,12}$/.test(p.timestamp||'')||!/^[a-f0-9]{32}$/.test(p.nonce||'')||!/^[A-Za-z0-9_-]{1,128}$/.test(p.request_id||'')||!/^v1=[a-f0-9]{64}$/.test(h['x-gp-signature']||'')||p.direction!=='platform-to-wallet')throw new WalletError('SIGNATURE_INVALID','Invalid authentication headers',401);
 if(Math.abs(Date.now()/1000-Number(p.timestamp))>300)throw new WalletError('TIMESTAMP_EXPIRED','Timestamp outside 300 seconds',401);
 const row=(await pool.query('SELECT k.*,s.* FROM wallet_keys k JOIN wallet_scopes s USING(scope_id) WHERE key_id=$1 AND active=true',[p.key_id])).rows[0];
 if(!row)throw new WalletError('SIGNATURE_INVALID','Unknown credential',401);
 const expected=createHmac('sha256',Buffer.from(row.secret_base64,'base64')).update(canonical(p)).digest();const actual=Buffer.from(h['x-gp-signature'].slice(3),'hex');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new WalletError('SIGNATURE_INVALID','Signature mismatch',401);
 const inserted=await pool.query('INSERT INTO wallet_nonces(key_id,nonce,expires_at) VALUES($1,$2,now()+interval \'610 seconds\') ON CONFLICT DO NOTHING RETURNING nonce',[p.key_id,p.nonce]);
 if(!inserted.rowCount)throw new WalletError('NONCE_REPLAY','Nonce already used',401);
 return {row,request_id:p.request_id};
}
