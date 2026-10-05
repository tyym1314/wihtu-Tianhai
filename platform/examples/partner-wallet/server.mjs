/** Separate sandbox wallet process. It does not import the platform DB pool or serve files. */
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {migrateWallet,provisionWallet,createWalletServer} from '../../server/wallet/index.mjs';

const DEFAULT_PLATFORM_DB='postgres://oasis_local@127.0.0.1:5487/oasis_platform';
function databaseIdentity(value){const u=new URL(value);if(!['postgres:','postgresql:'].includes(u.protocol))throw Error('PostgreSQL URL required');return[['localhost','127.0.0.1','[::1]'].includes(u.hostname)?'loopback':u.hostname,u.port||'5432',decodeURIComponent(u.pathname)].join('|');}
export async function startPartnerWallet({configPath=process.env.OASIS_PARTNER_WALLET_CONFIG,databaseUrl=process.env.OASIS_PARTNER_WALLET_DATABASE_URL,port=Number(process.env.OASIS_PARTNER_WALLET_PORT||8801)}={}){
  if(!configPath||!databaseUrl)throw Error('Set OASIS_PARTNER_WALLET_CONFIG and OASIS_PARTNER_WALLET_DATABASE_URL explicitly');
  if(databaseIdentity(databaseUrl)===databaseIdentity(process.env.OASIS_DATABASE_URL||DEFAULT_PLATFORM_DB))throw Error('Independent partner wallet must not use the platform database');
  if(!Number.isInteger(port)||port<0||port>65535||[5487,8787,8790,8795,8796,8797,8798].includes(port))throw Error('Use a separate wallet port; default 8801');
  const path=resolve(configPath),info=await stat(path);if(!info.isFile()||(info.mode&0o077)!==0)throw Error('Private wallet config must be a regular file with mode 0600');
  const config=JSON.parse(await readFile(path,'utf8'));
  if(config.schema_version!==1||config.scope?.environment!=='sandbox'||config.currency_scale!==2||!Array.isArray(config.math_profiles)||!['thunder','tiger'].every(g=>config.math_profiles.some(p=>p.game_id===g)))throw Error('Use schema_version 1, sandbox scope, scale 2 and explicit approved Thunder/Tiger math profiles');
  const users=config.users||Array.from({length:4},(_,i)=>({external_user_id:i?'demo_player_'+(i+1):'demo_player',balance_minor:'1200000'}));
  const pool=new pg.Pool({connectionString:databaseUrl,max:10});let server;
  try{
    const connected=(await pool.query('SELECT current_database() AS name')).rows[0].name;
    if(connected===decodeURIComponent(new URL(process.env.OASIS_DATABASE_URL||DEFAULT_PLATFORM_DB).pathname.slice(1)))throw Error('Use a uniquely named partner sandbox database, different from the platform database');
    await migrateWallet(pool);
    await provisionWallet(pool,{scope:config.scope,key_id:config.key_id,secret_base64:config.secret_base64,users,treasury_minor:config.treasury_minor,math_profiles:config.math_profiles});
    server=createWalletServer(pool);await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});
    return{server,pool,origin:'http://127.0.0.1:'+server.address().port,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();}};
  }catch(e){if(server?.listening)await new Promise(r=>server.close(r));await pool.end();throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const service=await startPartnerWallet();
    console.log(JSON.stringify({service:'independent-reference-partner-wallet',origin:service.origin,environment:'sandbox',database_isolation:'separate configured PostgreSQL database',production:false}));
    let closing=false;const stop=async()=>{if(closing)return;closing=true;await service.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  }catch(e){console.error('[partner-wallet]',e.code||'START_FAILED',e.message);process.exitCode=1;}
}
