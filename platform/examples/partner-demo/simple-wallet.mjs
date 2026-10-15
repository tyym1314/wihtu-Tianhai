/**
 * Reference implementation of the OASIS simple-v1 partner wallet (3 endpoints).
 * A real partner implements the same contract on top of its own user balance ledger:
 *   GET  /wallet/simple/v1/users/{external_user_id}/balance
 *   POST /wallet/simple/v1/debit   {request_id, external_user_id, amount_minor, ...}
 *   POST /wallet/simple/v1/credit  {request_id, external_user_id, amount_minor, ...}
 * Rules: verify the platform signature; each request_id takes effect at most once and a
 * repeated request_id returns the original result; a debit never overdraws.
 */
import {verifySignature} from '../../server/security.mjs';

export async function migrateSimpleDemoWallet(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS demo_simple_accounts (external_user_id text PRIMARY KEY, balance_minor bigint NOT NULL CHECK(balance_minor>=0));
  CREATE TABLE IF NOT EXISTS demo_simple_transactions (request_id text PRIMARY KEY, external_user_id text NOT NULL, kind text NOT NULL, amount_minor bigint NOT NULL,
   status text NOT NULL, code text, created_at timestamptz NOT NULL DEFAULT now());`);
}
export async function seedSimpleDemoUsers(pool,users){
 for(const u of users)await pool.query('INSERT INTO demo_simple_accounts(external_user_id,balance_minor) VALUES($1,$2) ON CONFLICT DO NOTHING',[u.external_user_id,u.balance_minor]);
}
export async function simpleBalance(pool,user){return(await pool.query('SELECT balance_minor FROM demo_simple_accounts WHERE external_user_id=$1',[user])).rows[0]?.balance_minor??null;}

const nonces=new Map();
/** Returns true when it handled the request. */
export async function handleSimpleWallet(pool,{keyId,secretBase64},req,res,raw){
 const path=(req.url||'').split('?')[0];if(!path.startsWith('/wallet/simple/v1/'))return false;
 const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 try{
  if(req.headers['x-gp-key-id']!==keyId)return send(401,{code:'SIGNATURE_INVALID'}),true;
  const {nonce}=verifySignature(req,raw,{secret_base64:secretBase64},'platform-to-wallet');
  const now=Date.now();for(const [k,t] of nonces)if(t<now-610000)nonces.delete(k);
  if(nonces.has(nonce))return send(401,{code:'NONCE_REPLAY'}),true;nonces.set(nonce,now);
  const balance=path.match(/^\/wallet\/simple\/v1\/users\/([A-Za-z0-9_-]{1,128})\/balance$/);
  if(req.method==='GET'&&balance){const b=await simpleBalance(pool,balance[1]);if(b===null)return send(404,{code:'USER_NOT_FOUND'}),true;return send(200,{external_user_id:balance[1],available_minor:String(b),currency_scale:2}),true;}
  const kind={'/wallet/simple/v1/debit':'debit','/wallet/simple/v1/credit':'credit'}[path];
  if(req.method!=='POST'||!kind)return send(404,{code:'NOT_FOUND'}),true;
  const b=JSON.parse(raw);
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(b.request_id||'')||req.headers['x-gp-request-id']!==b.request_id||!/^[A-Za-z0-9_-]{1,128}$/.test(b.external_user_id||'')||!/^[1-9][0-9]{0,18}$/.test(b.amount_minor||''))return send(400,{code:'INVALID_REQUEST'}),true;
  const c=await pool.connect();
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['simple:'+b.request_id]);
   const prior=(await c.query('SELECT * FROM demo_simple_transactions WHERE request_id=$1',[b.request_id])).rows[0];
   if(prior){await c.query('ROLLBACK');
    if(prior.kind!==kind||prior.external_user_id!==b.external_user_id||String(prior.amount_minor)!==b.amount_minor)return send(409,{request_id:b.request_id,status:'REJECTED',code:'IDEMPOTENCY_CONFLICT'}),true;
    return send(200,{request_id:b.request_id,status:prior.status,...(prior.code?{code:prior.code}:{})}),true;}
   const account=(await c.query('SELECT balance_minor FROM demo_simple_accounts WHERE external_user_id=$1 FOR UPDATE',[b.external_user_id])).rows[0];
   let status='SUCCEEDED',code=null;
   if(!account){status='REJECTED';code='USER_NOT_FOUND';}
   else if(kind==='debit'&&BigInt(account.balance_minor)<BigInt(b.amount_minor)){status='REJECTED';code='INSUFFICIENT_FUNDS';}
   else await c.query('UPDATE demo_simple_accounts SET balance_minor=balance_minor+$2 WHERE external_user_id=$1',[b.external_user_id,(kind==='debit'?-1n:1n)*BigInt(b.amount_minor)]);
   await c.query('INSERT INTO demo_simple_transactions(request_id,external_user_id,kind,amount_minor,status,code) VALUES($1,$2,$3,$4,$5,$6)',[b.request_id,b.external_user_id,kind,b.amount_minor,status,code]);
   await c.query('COMMIT');
   return send(200,{request_id:b.request_id,status,...(code?{code}:{})}),true;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }catch(e){send(e.status||500,{code:e.code||'INTERNAL_ERROR'});return true;}
}
