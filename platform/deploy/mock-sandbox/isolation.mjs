/** Mandatory preflight for the separate online, test-credit Android game stack. */
import {readFile,realpath,lstat} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {isIP} from 'node:net';
import pg from 'pg';

const required=['OASIS_PUBLIC_ORIGIN','OASIS_DATABASE_URL','OASIS_LOCAL_DIR','OASIS_API_PORT','OASIS_WALLET_PORT','OASIS_DEMO_PORT'];
const privateFiles=['master.key','hosted-demo-guest.key'];
const issue=code=>{throw new Error(code);};

export function parseEnvironmentFile(source){
 const result=Object.create(null);
 for(const original of source.split(/\r?\n/)){
  const line=original.trim();
  if(!line||line.startsWith('#'))continue;
  const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if(!match||Object.hasOwn(result,match[1]))issue('MOCK_ENV_FILE_INVALID');
  let value=match[2];
  if(value.startsWith('"')||value.startsWith("'")){
   if(value.length<2||value.at(-1)!==value[0])issue('MOCK_ENV_FILE_INVALID');
   value=value.slice(1,-1);
  }
  if(/[\r\n]/.test(value)||value.includes('$(')||value.includes('`'))issue('MOCK_ENV_FILE_INVALID');
  result[match[1]]=value;
 }
 return result;
}

function exactHttpsOrigin(value){
 let url;try{url=new URL(value);}catch{issue('MOCK_ORIGIN_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==value)issue('MOCK_ORIGIN_INVALID');
 return url;
}
function databaseUrl(value){
 let url;try{url=new URL(value);}catch{issue('MOCK_DATABASE_CONFIG_INVALID');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.pathname||url.pathname==='/'||url.hash)issue('MOCK_DATABASE_CONFIG_INVALID');
 return url;
}
function port(value){
 const number=Number(value);
 if(!/^[0-9]+$/.test(value||'')||!Number.isInteger(number)||number<1024||number>65535)issue('MOCK_PORT_INVALID');
 return number;
}
function normalizedDatabase(url){
 return `${url.hostname.toLowerCase()}:${url.port||5432}/${decodeURIComponent(url.pathname.slice(1))}`;
}

/** Pure configuration check; live and mock must never share their public host, DB name, keys or ports. */
export function validateIsolationConfig(mock,live){
 for(const key of required)if(!mock[key]||!live[key])issue('MOCK_CONFIG_INCOMPLETE');
 if(mock.MOCK_SANDBOX_KIND!=='isolated-13-game-mock'||mock.OASIS_ENVIRONMENT!=='sandbox'||mock.OASIS_PRODUCTION_ADMISSION_ENABLED!=='0'||mock.OASIS_START_WALLET!=='1')issue('MOCK_MODE_REQUIRED');
 const mockOrigin=exactHttpsOrigin(mock.OASIS_PUBLIC_ORIGIN),liveOrigin=exactHttpsOrigin(live.OASIS_PUBLIC_ORIGIN);
 const mockHost=mockOrigin.hostname.toLowerCase(),ipHost=mockHost.replace(/^\[/,'').replace(/\]$/,'');
 if(/(?:^|\.)(?:localhost|invalid|test|example)$/.test(mockHost)||/^(?:.+\.)?example\.(?:com|org|net)$/.test(mockHost)||isIP(ipHost))issue('MOCK_ORIGIN_INVALID');
 if(mockOrigin.host===liveOrigin.host||mockOrigin.hostname===liveOrigin.hostname)issue('MOCK_ORIGIN_SHARED_WITH_LIVE');
 const mockDb=databaseUrl(mock.OASIS_DATABASE_URL),liveDb=databaseUrl(live.OASIS_DATABASE_URL);
 if(normalizedDatabase(mockDb)===normalizedDatabase(liveDb))issue('MOCK_DATABASE_SHARED_WITH_LIVE');
 for(const [name,env] of [['mock',mock],['live',live]]){
  if(!path.isAbsolute(env.OASIS_LOCAL_DIR))issue('MOCK_PRIVATE_DIR_INVALID');
  const ports=[port(env.OASIS_API_PORT),port(env.OASIS_WALLET_PORT),port(env.OASIS_DEMO_PORT)];
  if(new Set(ports).size!==ports.length)issue(`${name.toUpperCase()}_PORTS_CONFLICT`);
 }
 const mockPorts=[mock.OASIS_API_PORT,mock.OASIS_WALLET_PORT,mock.OASIS_DEMO_PORT].map(port);
 const livePorts=new Set([live.OASIS_API_PORT,live.OASIS_WALLET_PORT,live.OASIS_DEMO_PORT].map(port));
 if(mockPorts.some(value=>livePorts.has(value)))issue('MOCK_PORT_SHARED_WITH_LIVE');
 const referenceWallet=`http://127.0.0.1:${port(mock.OASIS_WALLET_PORT)}`;
 if(mock.OASIS_REFERENCE_WALLET_URL!==referenceWallet)issue('MOCK_WALLET_ROUTE_INVALID');
 // wallet-binding.mjs implicitly allows the reference wallet when this list is
 // empty. Mirror its comma/whitespace handling, but reject any extra target:
 // an inherited live allowlist must never make mock requests reach that wallet.
 const rawAllowed=mock.OASIS_WALLET_ALLOWED_ORIGINS??'';
 if(typeof rawAllowed!=='string'||rawAllowed.split(',').map(value=>value.trim()).filter(Boolean).some(value=>value!==referenceWallet&&value!==referenceWallet+'/'))issue('MOCK_WALLET_ALLOWED_ORIGINS_INVALID');
 return Object.freeze({mockOrigin:mockOrigin.origin,liveOrigin:liveOrigin.origin,mockDatabase:mock.OASIS_DATABASE_URL,liveDatabase:live.OASIS_DATABASE_URL,mockPrivateDir:mock.OASIS_LOCAL_DIR,livePrivateDir:live.OASIS_LOCAL_DIR});
}

async function privateFile(directory,name){
 const location=path.join(directory,name),stat=await lstat(location).catch(()=>issue('MOCK_PRIVATE_KEY_MISSING'));
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600)issue('MOCK_PRIVATE_KEY_INVALID');
 const bytes=await readFile(location);
 if(bytes.length!==32)issue('MOCK_PRIVATE_KEY_INVALID');
 return bytes;
}

/** Reject copied keys and aliased private directories before either server starts. */
export async function validatePrivateKeys(config){
 const mock=await realpath(config.mockPrivateDir).catch(()=>issue('MOCK_PRIVATE_DIR_MISSING'));
 const live=await realpath(config.livePrivateDir).catch(()=>issue('LIVE_PRIVATE_DIR_MISSING'));
 if(mock===live||mock.startsWith(live+path.sep)||live.startsWith(mock+path.sep))issue('MOCK_PRIVATE_DIR_SHARED_WITH_LIVE');
 for(const name of privateFiles){
  const [mockKey,liveKey]=await Promise.all([privateFile(mock,name),privateFile(live,name)]);
  if(timingSafeEqual(mockKey,liveKey))issue('MOCK_PRIVATE_KEY_SHARED_WITH_LIVE');
 }
}

/** A transaction-scoped advisory-lock challenge detects aliases to the same PostgreSQL database. */
export async function probeDistinctDatabases(config,{Client=pg.Client}={}){
 const live=new Client({connectionString:config.liveDatabase,connectionTimeoutMillis:5000});
 const mock=new Client({connectionString:config.mockDatabase,connectionTimeoutMillis:5000});
 let liveReady=false,mockReady=false;
 try{
  await live.connect();liveReady=true;
  await mock.connect();mockReady=true;
  const challenge=randomBytes(8),one=challenge.readInt32BE(0),two=challenge.readInt32BE(4);
  await live.query('BEGIN');
  await live.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)',[one,two]);
  await mock.query('BEGIN');
  const result=await mock.query('SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired',[one,two]);
  if(result.rows[0]?.acquired!==true)issue('MOCK_DATABASE_SHARED_WITH_LIVE');
 }catch(error){if(error.message==='MOCK_DATABASE_SHARED_WITH_LIVE')throw error;issue('MOCK_DATABASE_PROBE_FAILED');}
 finally{
  if(mockReady)await mock.query('ROLLBACK').catch(()=>{});
  if(liveReady)await live.query('ROLLBACK').catch(()=>{});
  await Promise.all([mock.end().catch(()=>{}),live.end().catch(()=>{})]);
 }
}

export async function preflight(mock,live,options){
 const config=validateIsolationConfig(mock,live);
 await validatePrivateKeys(config);
 await probeDistinctDatabases(config,options);
 return {origin:config.mockOrigin,gameCount:13,databaseIsolation:'proven',keyIsolation:'proven'};
}
