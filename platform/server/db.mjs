import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
const connectionString=process.env.OASIS_DATABASE_URL || 'postgres://oasis_local@127.0.0.1:5487/oasis_platform';
// Pool budgets per process; in cluster mode lower them so all workers fit max_connections.
const budget=(name,fallback)=>Number(process.env[name]||fallback);
export const pool = new pg.Pool({connectionString,max:budget('OASIS_DB_POOL_MAX',20)});
// Queries inside an already-owned gameplay lock need no second checkout.
// Keep transactions and explicit connect() on their original independent pool;
// only promise text queries use this private, lifetime-bounded autocommit lease.
const lockQueries=new AsyncLocalStorage(),mainQuery=pool.query.bind(pool),mainConnect=pool.connect.bind(pool);
function lockQueryContext(key,fn,client){
 return typeof fn==='function'&&fn.length===0&&['session:','cycle:','pvp:'].some(prefix=>key.startsWith(prefix))?{client,active:true,queryError:null}:null;
}
// A failed borrowed query cannot continue writes through a fresh connection
// after ownership of the lock socket becomes uncertain. No automatic retry.
pool.connect=function(...args){
 const context=lockQueries.getStore();
 if(context?.active&&context.queryError){if(typeof args[0]==='function'){queueMicrotask(()=>args[0](context.queryError));return;}return Promise.reject(context.queryError);}
 return mainConnect(...args);
};
pool.query=function(...args){
 const context=lockQueries.getStore(),textQuery=typeof args[0]==='string'&&(args.length===1||args.length===2&&Array.isArray(args[1]));
 if(!context?.active||!textQuery)return mainQuery(...args);
 // Never retry on another client after a query error: the original failure and
 // the authoritative lock connection remain one ownership boundary.
 if(context.queryError)return Promise.reject(context.queryError);
 try{return context.client.query(...args).catch(error=>{context.queryError??=error;throw error;});}
 catch(error){context.queryError??=error;throw error;}
};
// The optional reference wallet has its own bounded connection budget. Its
// scope transactions must not occupy the gameplay/authentication SQL pool.
// Per-player wallet transactions run in parallel; size with OASIS_WALLET_POOL_MAX.
export const walletPool = new pg.Pool({connectionString,max:Number(process.env.OASIS_WALLET_POOL_MAX||16)});
// Waiting for an advisory lock must never exhaust connections needed by the
// holder to write a result or ask the independent wallet for a receipt.
const sessionLocks=new pg.Pool({connectionString,max:budget('OASIS_DB_LOCK_POOL_MAX',16)});
const cycleLocks=new pg.Pool({connectionString,max:budget('OASIS_DB_LOCK_POOL_MAX',16)});
// Physics can hold a room lock for hundreds of milliseconds. Keep those
// connections separate from probability settlement/recovery locks.
const pvpLocks=new pg.Pool({connectionString,max:budget('OASIS_DB_LOCK_POOL_MAX',16)});
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
  const context=lockQueries.getStore();if(context?.active&&context.queryError)throw context.queryError;
  const c=await pool.connect();
  try { await c.query('BEGIN'); const result=await lockQueries.run(null,()=>fn(c)); await c.query('COMMIT'); return result; }
  catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export async function locked(key,fn) {
  const local=enqueueLocal(key);let c,acquired=false,error,context;
  try{await local.before;c=await lockPool(key).connect();
   try{await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);acquired=true;}catch(e){error=e;throw e;}
   context=lockQueryContext(key,fn,c);return await lockQueries.run(context,()=>fn(c));
  }finally{if(context)context.active=false;try{if(acquired)await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch(e){error=e;throw e;}finally{c?.release(error||context?.queryError);local.release();}}
}
// Background maintenance never joins the HTTP lock-wait queue. Its lock
// connection comes from the same independent pool, not the business SQL pool.
export async function tryLocked(key,fn){
  if(localLocks.has(key))return;
  const local=enqueueLocal(key);let c,acquired=false,error,context;
  try{c=await lockPool(key).connect();try{acquired=(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;}catch(e){error=e;throw e;}if(acquired){context=lockQueryContext(key,fn,c);return await lockQueries.run(context,()=>fn(c));}}
  finally{if(context)context.active=false;try{if(acquired)await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch(e){error=e;throw e;}finally{c?.release(error||context?.queryError);local.release();}}
}
export const dbPoolStats=()=>({local_lock_keys:localLocks.size,local_lock_waiters:localLockCount,...Object.fromEntries(Object.entries({main:pool,wallet:walletPool,session:sessionLocks,cycle:cycleLocks,pvp:pvpLocks,integration:integrationLocks}).map(([name,p])=>[name,{total:p.totalCount,idle:p.idleCount,waiting:p.waitingCount}]))});
export async function closePools(){await Promise.all([pool.end(),walletPool.end(),sessionLocks.end(),cycleLocks.end(),pvpLocks.end(),integrationLocks.end()]);}
