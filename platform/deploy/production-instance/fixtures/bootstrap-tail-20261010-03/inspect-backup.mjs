/** Pure restore inspection and AES-GCM proof. No API, credentials or rows on stdout. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {restoreInspectSQL,decryptCheck,REQUIRED_TABLES} from '../restore-drill.mjs';

export function inspectSQL(){return restoreInspectSQL().replace(/COMMIT;$/,`SELECT json_build_object(
 'environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),
 'sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment!='production'),
 'reference_keys',(SELECT count(*) FROM gp_keys WHERE direction='platform-to-wallet'),
 'database',current_database()) AS identity;\nCOMMIT;`);}
export function validateInspection(value,identity,master){
 if(value?.transfer_schema!=='present'||!Array.isArray(value?.keys)||value.keys.length<1||value.rows?.gp_keys!==value.keys.length||identity?.environment!=='production'||identity.sandbox_apps!==0||identity.reference_keys!==0)throw Error('PRODUCTION_RESTORE_IDENTITY_INVALID');
 if(Object.keys(value.rows||{}).length!==REQUIRED_TABLES.length||REQUIRED_TABLES.some(k=>!Number.isSafeInteger(value.rows[k])||value.rows[k]<0))throw Error('PRODUCTION_RESTORE_SCHEMA_INVALID');
 if(Object.keys(value.audit||{}).length!==15||Object.values(value.audit).some(x=>!Number.isSafeInteger(x)||x<0))throw Error('PRODUCTION_RESTORE_AUDIT_INVALID');
 const pending=['pending_cycles','pending_probability_operations','pending_pvp_operations','active_rooms','pending_wallet_operations','pending_transfers'];
 for(const [key,count] of Object.entries(value.audit))if(!pending.includes(key)&&count!==0)throw Error('PRODUCTION_RESTORE_LEDGER_INVALID');
 for(const secret of value.keys)decryptCheck(master,secret);
 return {environment:identity.environment,master_key_sha256:createHash('sha256').update(master).digest('hex'),decrypted_keys:value.keys.length,row_counts:value.rows,audit:value.audit};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{
  if(process.argv[2]==='sql'&&process.argv.length===3)process.stdout.write(inspectSQL());
  else if(process.argv[2]==='verify'&&process.argv.length===4){
   const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>8388608)throw Error('PRODUCTION_RESTORE_INPUT_TOO_LARGE');chunks.push(chunk);}
   const {data,identity}=JSON.parse(Buffer.concat(chunks)),master=await readFile(process.argv[3]);
   try{process.stdout.write(JSON.stringify(validateInspection(data,identity,master))+'\n');}finally{master.fill(0);}
  }else throw Error('PRODUCTION_RESTORE_ARGUMENT_INVALID');
 }catch(error){process.stderr.write((/^[A-Z0-9_]+$/.test(error.message)?error.message:'PRODUCTION_RESTORE_VERIFY_FAILED')+'\n');process.exitCode=2;}
}
