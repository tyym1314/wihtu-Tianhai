import pg from 'pg';
const connectionString=process.env.OASIS_DATABASE_URL || 'postgres://oasis_local@127.0.0.1:5487/oasis_platform';
export const pool = new pg.Pool({connectionString,max:20});
// The optional reference wallet has its own bounded connection budget. Its
// scope transactions must not occupy the gameplay/authentication SQL pool.
export const walletPool = new pg.Pool({connectionString,max:8});
// Waiting for an advisory lock must never exhaust connections needed by the
// holder to write a result or ask the independent wallet for a receipt.
const sessionLocks=new pg.Pool({connectionString,max:16});
const cycleLocks=new pg.Pool({connectionString,max:16});
// Physics can hold a room lock for hundreds of milliseconds. Keep those
// connections separate from probability settlement/recovery locks.
const pvpLocks=new pg.Pool({connectionString,max:16});
// Check runners call back into normal gameplay over HTTP. They must never hold
// connections from the gameplay lock pool while waiting for that work.
const integrationLocks=new pg.Pool({connectionString,max:2});
// Serialize one process before checking out a PostgreSQL lock connection. Four
// seats waiting for the same physics action must not consume four connections
// and prevent unrelated rooms or wallet recovery from acquiring their locks.
// The database advisory lock remains authoritative across processes/restarts.
const localLocks=new Map();
let localLockCount=0;
function enqueueLocal(key){
 const state=localLocks.get(key)||{tail:undefined,depth:0};
 if(state.depth>=64||localLockCount>=2048){const e=new Error('Lock queue is full; retry the original request');e.code='LOCK_QUEUE_FULL';e.status=503;throw e;}
 const before=state.tail;let resolve;const done=new Promise(r=>resolve=r);state.tail=done;state.depth++;localLockCount++;localLocks.set(key,state);
 return{before,release(){resolve();state.depth--;localLockCount--;if(!state.depth)localLocks.delete(key);}};
}
const lockPool=key=>key.startsWith('integration:')?integrationLocks:key.startsWith('session:')?sessionLocks:key.startsWith('pvp:')?pvpLocks:cycleLocks;
export async function tx(fn) {
  const c=await pool.connect();
  try { await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result; }
  catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export async function locked(key,fn) {
  const local=enqueueLocal(key);let c,acquired=false,error;
  try{await local.before;c=await lockPool(key).connect();
   try{await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);acquired=true;}catch(e){error=e;throw e;}
   return await fn(c);
  }finally{try{if(acquired)await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch(e){error=e;throw e;}finally{c?.release(error);local.release();}}
}
// Background maintenance never joins the HTTP lock-wait queue. Its lock
// connection comes from the same independent pool, not the business SQL pool.
export async function tryLocked(key,fn){
  if(localLocks.has(key))return;
  const local=enqueueLocal(key);let c,acquired=false,error;
  try{c=await lockPool(key).connect();try{acquired=(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;}catch(e){error=e;throw e;}if(acquired)return await fn(c);}
  finally{try{if(acquired)await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch(e){error=e;throw e;}finally{c?.release(error);local.release();}}
}
export const dbPoolStats=()=>({local_lock_keys:localLocks.size,local_lock_waiters:localLockCount,...Object.fromEntries(Object.entries({main:pool,wallet:walletPool,session:sessionLocks,cycle:cycleLocks,pvp:pvpLocks,integration:integrationLocks}).map(([name,p])=>[name,{total:p.totalCount,idle:p.idleCount,waiting:p.waitingCount}]))});
export async function closePools(){await Promise.all([pool.end(),walletPool.end(),sessionLocks.end(),cycleLocks.end(),pvpLocks.end(),integrationLocks.end()]);}
