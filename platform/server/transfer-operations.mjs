import {fail,send} from './security.mjs';

const ID=/^[A-Za-z0-9_-]{1,128}$/;
const STATES=new Set(['PENDING','SUCCEEDED','REJECTED']);
const OBSERVATIONS=new Set(['QUEUED','PENDING','NOT_FOUND','SUCCEEDED','REJECTED','TRANSFER_UNKNOWN','TRANSFER_RECEIPT_INVALID','TRANSFER_DUPLICATE_EXTERNAL_TRANSACTION']);
const errors={TRANSFER_UNKNOWN:'OUTCOME_UNKNOWN',TRANSFER_RECEIPT_INVALID:'RECEIPT_INVALID',TRANSFER_DUPLICATE_EXTERNAL_TRANSACTION:'DUPLICATE_EXTERNAL_TRANSACTION'};
const timestamp="to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
const select=`t.id,t.request_id,t.app_id,a.name AS app_name,a.partner_id,a.environment,t.binding_id,t.account_id,
 t.external_user_id,t.direction,t.amount_minor::text,t.currency_id,s.currency_scale,t.state,t.observation,
 t.created_at,t.updated_at,${timestamp} AS sort_time,t.ledger_transaction_id,
 t.receipt->>'external_transaction_id' AS receipt_external_id,t.receipt->>'rejection_code' AS rejection_code,
 t.request_sha256,o.operation_id,o.external_transaction_id,o.attempts,o.next_attempt_at,o.lease_until,
 b.status AS binding_status,a.status AS app_status,ta.active AS account_active`;
const from=`FROM gp_transfers t JOIN gp_apps a ON a.id=t.app_id
 JOIN wallet_scopes s ON s.scope_id=t.scope_id AND s.app_id=a.id AND s.partner_id=a.partner_id AND s.environment=a.environment
 LEFT JOIN gp_transfer_outbox o ON o.transfer_id=t.id
 LEFT JOIN gp_transfer_bindings b ON b.id=t.binding_id AND b.app_id=t.app_id
 LEFT JOIN gp_transfer_accounts ta ON ta.id=t.account_id AND ta.app_id=t.app_id`;

function parameters(target,detail){
 if(typeof target!=='string'||target.length>4096||target.includes('#'))fail(400,'INVALID_TRANSFER_QUERY');
 const search=new URL(target,'http://console.invalid').searchParams,allowed=detail?['app_id']:['app_id','state','request_id','limit','cursor'];
 for(const key of search.keys())if(!allowed.includes(key)||search.getAll(key).length!==1)fail(400,'INVALID_TRANSFER_QUERY');
 const p=Object.fromEntries(search);
 for(const key of ['app_id','request_id'])if(p[key]!==undefined&&!ID.test(p[key]))fail(400,'INVALID_TRANSFER_QUERY');
 if(p.state!==undefined&&!STATES.has(p.state))fail(400,'INVALID_TRANSFER_QUERY');
 if(p.limit!==undefined&&(!/^[1-9][0-9]{0,2}$/.test(p.limit)||Number(p.limit)>100))fail(400,'INVALID_TRANSFER_QUERY');
 return{...p,limit:Number(p.limit||25)};
}
function key(value){
 if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||typeof value[1]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value[0])||!ID.test(value[1]))return false;
 const ms=Date.parse(value[0]);return !value[0].startsWith('0000-')&&Number.isFinite(ms)&&new Date(ms).toISOString()===value[0].slice(0,23)+'Z';
}
function decodeCursor(value,scope){
 if(typeof value!=='string'||value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))fail(400,'INVALID_TRANSFER_CURSOR');
 let c;try{const raw=Buffer.from(value,'base64url');if(raw.toString('base64url')!==value)throw Error();c=JSON.parse(raw.toString());}catch{fail(400,'INVALID_TRANSFER_CURSOR');}
 if(!c||Object.keys(c).sort().join(',')!=='after,scope,through,v'||c.v!==1||JSON.stringify(c.scope)!==JSON.stringify(scope)||!key(c.after)||!key(c.through)||c.after[0]>c.through[0]||(c.after[0]===c.through[0]&&c.after[1]>c.through[1]))fail(400,'INVALID_TRANSFER_CURSOR');
 return c;
}
const safeId=value=>typeof value==='string'&&ID.test(value)?value:null;
function publicRow(r,asOf,{detail=false}={}){
 const pending=r.state==='PENDING',observation=OBSERVATIONS.has(r.observation)?r.observation:'UNKNOWN',outboxKnown=Number.isInteger(r.attempts),age=Math.max(0,Math.floor((asOf-new Date(r.created_at))/1000));
 const row={status_basis:'stored_order_not_reconciled',transfer_id:r.id,request_id:r.request_id,app_id:r.app_id,app_name:r.app_name,partner_id:r.partner_id,environment:r.environment,
  direction:r.direction,amount_minor:r.amount_minor,currency_id:r.currency_id,currency_scale:r.currency_scale,state:r.state,observation,
  age_seconds:age,pending_age_seconds:pending?age:null,attempts:r.attempts??null,next_attempt_at:pending?r.next_attempt_at:null,
  error_category:!outboxKnown?'OUTBOX_MISSING':errors[observation]||(observation==='UNKNOWN'?'UNCLASSIFIED':null),
  retry_state:!pending?'TERMINAL':!outboxKnown?'UNAVAILABLE':r.lease_until&&new Date(r.lease_until)>asOf?'IN_FLIGHT':new Date(r.next_attempt_at)>asOf?'BACKOFF':'DUE',
  hold:{kind:pending?(r.direction==='OUT'?'FUNDS_RESERVED':'CREDIT_CAPACITY_RESERVED'):'NONE',amount_minor:pending?r.amount_minor:'0'},
  local_state:pending?(r.direction==='OUT'?'FUNDS_HELD':'CAPACITY_HELD'):r.state==='REJECTED'?'HOLD_RELEASED':r.direction==='IN'?'CREDITED':'DEBITED',
  external_state:['SUCCEEDED','REJECTED','PENDING','NOT_FOUND'].includes(observation)?observation:observation==='QUEUED'?'NOT_OBSERVED':'UNKNOWN',
  admission:{app_status:r.app_status,binding_status:r.binding_status,account_active:r.account_active},created_at:r.created_at,updated_at:r.updated_at};
 if(detail)Object.assign(row,{request_sha256:/^[a-f0-9]{64}$/.test(r.request_sha256)?r.request_sha256:null,binding_id:r.binding_id,account_id:r.account_id,external_user_id:r.external_user_id,
  external_operation_id:safeId(r.operation_id),external_transaction_id:safeId(r.external_transaction_id),ledger_transaction_id:safeId(r.ledger_transaction_id),
  receipt:r.state==='PENDING'?null:{transfer_id:r.id,request_id:r.request_id,external_operation_id:safeId(r.operation_id),
   external_transaction_id:safeId(r.receipt_external_id),ledger_transaction_id:safeId(r.ledger_transaction_id),
   body_sha256:/^[a-f0-9]{64}$/.test(r.request_sha256)?r.request_sha256:null,rejection_code:safeId(r.rejection_code)}});
 return row;
}

/** Console cookie principals only. No transfer service/adapter or write API is imported. */
export async function readTransferOperations(dbPool,user,environment,target){
 const match=target.split('?')[0].match(/^\/api\/(admin|partner)\/transfers(?:\/([A-Za-z0-9_-]{1,128}))?$/);
 if(!match)fail(404,'NOT_FOUND');
 if(!user)fail(401,'LOGIN_REQUIRED');
 if(match[1]==='admin'?user.role!=='platform_admin':user.role!=='partner_developer'||!ID.test(user.partner_id||''))fail(403,'SCOPE_FORBIDDEN');
 if(!['sandbox','production'].includes(environment))fail(503,'ENVIRONMENT_UNAVAILABLE');
 const p=parameters(target,Boolean(match[2])),partner=match[1]==='partner'?user.partner_id:null;
 const scope=[match[1],user.id,partner,environment,p.app_id||null,p.state||null,p.request_id||null];
 const cursor=p.cursor!==undefined?decodeCursor(p.cursor,scope):null;
 const db=await dbPool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='5s'");
  const asOf=(await db.query('SELECT transaction_timestamp() AS at')).rows[0].at;
  if(p.app_id&&!(await db.query('SELECT 1 FROM gp_apps WHERE id=$1 AND environment=$2 AND ($3::text IS NULL OR partner_id=$3)',[p.app_id,environment,partner])).rowCount)fail(404,'NOT_FOUND');
  const args=[environment,partner],where=['a.environment=$1','($2::text IS NULL OR a.partner_id=$2)'];
  const add=(sql,value)=>{args.push(value);where.push(sql.replace('?',`$${args.length}`));};
  if(p.app_id)add('t.app_id=?',p.app_id);
  if(p.state)add('t.state=?',p.state);
  if(p.request_id)add('t.request_id=?',p.request_id);
  if(match[2]){
   add('t.id=?',match[2]);const r=(await db.query(`SELECT ${select} ${from} WHERE ${where.join(' AND ')}`,args)).rows[0];
   if(!r)fail(404,'NOT_FOUND');await db.query('COMMIT');return{as_of:asOf,transfer:publicRow(r,asOf,{detail:true})};
  }
  const max=cursor?.through||(await db.query(`SELECT ${timestamp} AS time,t.id ${from} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC,t.id COLLATE "C" DESC LIMIT 1`,args)).rows.map(r=>[r.time,r.id])[0];
  if(!max){await db.query('COMMIT');return{as_of:asOf,transfers:[],next_cursor:null};}
  args.push(...max);where.push(`(t.created_at,t.id COLLATE "C")<=($${args.length-1}::timestamptz,$${args.length}::text COLLATE "C")`);
  if(cursor){args.push(...cursor.after);where.push(`(t.created_at,t.id COLLATE "C")<($${args.length-1}::timestamptz,$${args.length}::text COLLATE "C")`);}
  args.push(p.limit+1);const rows=(await db.query(`SELECT ${select} ${from} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC,t.id COLLATE "C" DESC LIMIT $${args.length}`,args)).rows;
  const page=rows.slice(0,p.limit),last=page.at(-1),next=rows.length>p.limit?Buffer.from(JSON.stringify({v:1,scope,through:max,after:[last.sort_time,last.id]})).toString('base64url'):null;
  await db.query('COMMIT');return{as_of:asOf,transfers:page.map(r=>publicRow(r,asOf)),next_cursor:next};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function routeTransferOperations(req,res,path,user,{pool,environment}){
 if(!/^\/api\/(admin|partner)\/transfers(?:[/?]|$)/.test(path))return false;
 if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
 const body=await readTransferOperations(pool,user,environment,path);
 res.setHeader('Cache-Control','no-store');send(res,200,body);return true;
}
