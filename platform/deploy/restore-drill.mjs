/** Isolated restore drill. Never connect to or modify the running application database. */
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {copyFile,lstat,mkdir,mkdtemp,open,readFile,realpath,rm,stat,link,unlink} from 'node:fs/promises';
import {createHash,createDecipheriv,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TRANSFER_AUDIT_SQL,TRANSFER_TABLES} from '../server/transfers/audit.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const hashes=['database.dump','private-config.tar.gz','release.txt'];
const fixedErrors=new Set(['UNSAFE_BACKUP_PATH','UNSAFE_REPORT_PATH','UNSAFE_DATABASE_NAME','DATABASE_ALREADY_EXISTS','DATABASE_CREATE_UNCONFIRMED','CHECKSUM_MANIFEST_INVALID','CHECKSUM_MISMATCH','BACKUP_INCOMPLETE','ARCHIVE_UNSAFE','MASTER_KEY_INVALID','KEY_DECRYPTION_FAILED','SCHEMA_INVALID','LEDGER_INCONSISTENT','RESTORE_COMMAND_FAILED','DATABASE_CLEANUP_FAILED','PRIVATE_CLEANUP_FAILED','REPORT_EXISTS','ROOT_REQUIRED','DRILL_FAILED']);
const codeOf=error=>fixedErrors.has(error?.code)?error.code:'DRILL_FAILED';
export function validateDatabaseName(name){
 if(!/^oasis_restore_\d{8}_[a-f0-9]{16}$/.test(name))fail('UNSAFE_DATABASE_NAME');
 return name;
}
export function validatePaths(backup,report){
 if(typeof backup!=='string'||!/^\/opt\/oasis\/backups\/\d{8}T\d{6}Z$/.test(backup)||path.normalize(backup)!==backup)fail('UNSAFE_BACKUP_PATH');
 if(typeof report!=='string'||!['/opt/oasis/private/restore-drills','/opt/oasis/acceptance'].includes(path.dirname(report))||!/^restore-drill-[a-zA-Z0-9_-]{1,80}\.json$/.test(path.basename(report))||path.normalize(report)!==report)fail('UNSAFE_REPORT_PATH');
 return {backup,report};
}
export function parseChecksums(text){
 const result={};
 for(const line of text.trim().split('\n')){
  const match=/^([a-f0-9]{64}) [ *]([a-zA-Z0-9.-]+)$/.exec(line);
  if(!match||!hashes.includes(match[2])||result[match[2]])fail('CHECKSUM_MANIFEST_INVALID');
  result[match[2]]=match[1];
 }
 if(Object.keys(result).length!==hashes.length)fail('CHECKSUM_MANIFEST_INVALID');
 return result;
}
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function decryptCheck(master,encrypted){
 try{
  if(!Buffer.isBuffer(master)||master.length!==32)fail('MASTER_KEY_INVALID');
  const raw=Buffer.from(encrypted,'base64');if(raw.length<29)fail('KEY_DECRYPTION_FAILED');
  const decipher=createDecipheriv('aes-256-gcm',master,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));
  const secret=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'));
  if(typeof secret!=='string'||Buffer.from(secret,'base64').length<32)fail('KEY_DECRYPTION_FAILED');
  return true;
 }catch(error){fail(error?.code==='MASTER_KEY_INVALID'?'MASTER_KEY_INVALID':'KEY_DECRYPTION_FAILED');}
}

// Do not use tar extraction flags alone: reject absolute/traversal paths, links and devices first.
export const SAFE_EXTRACT_PY=`import os, pathlib, tarfile, sys
archive, destination = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    if len(members) > 10000 or sum(m.size for m in members) > 268435456: raise ValueError('ARCHIVE_UNSAFE')
    seen = set()
    for m in members:
        parts = m.name.rstrip('/').split('/')
        if not parts or parts[0] != 'private' or any(p in ('', '.', '..') for p in parts) or not (m.isdir() or m.isfile()): raise ValueError('ARCHIVE_UNSAFE')
        normalized = '/'.join(parts)
        if normalized in seen: raise ValueError('ARCHIVE_UNSAFE')
        seen.add(normalized)
    for m in members:
        target = pathlib.Path(destination, m.name)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if m.isdir(): target.mkdir(exist_ok=True, mode=0o700)
        else:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as out, tar.extractfile(m) as source:
                while True:
                    chunk = source.read(1048576)
                    if not chunk: break
                    out.write(chunk)
`;
function command(program,args,{input,file,timeoutMs=120000,maxOutput=16*1024*1024}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(program,args,{stdio:['pipe','pipe','pipe']}),chunks=[];let bytes=0,failed=false;
  const timeout=setTimeout(()=>{failed=true;child.kill('SIGKILL');},timeoutMs);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutput){failed=true;child.kill('SIGKILL');}else chunks.push(chunk);});
  child.stderr.resume(); // PostgreSQL/tar errors can contain sensitive row values. Never print them.
  child.on('error',()=>{clearTimeout(timeout);reject(Object.assign(new Error('RESTORE_COMMAND_FAILED'),{code:'RESTORE_COMMAND_FAILED'}));});
  child.on('close',code=>{clearTimeout(timeout);if(code!==0||failed)reject(Object.assign(new Error('RESTORE_COMMAND_FAILED'),{code:'RESTORE_COMMAND_FAILED'}));else resolve(Buffer.concat(chunks).toString('utf8'));});
  child.stdin.on('error',()=>{});
  if(file){const stream=createReadStream(file);stream.on('error',()=>{failed=true;child.kill('SIGKILL');});child.on('close',()=>stream.destroy());stream.pipe(child.stdin);}
  else child.stdin.end(input||'');
 });
}
export const LEGACY_REQUIRED_TABLES=['gp_admins','gp_apps','gp_keys','gp_sessions','gp_cycles','gp_operations','gp_plays','gp_audit','gp_partner_accounts','pvp_rooms','pvp_operations','pvp_actions','wallet_scopes','wallet_keys','wallet_users','wallet_operations','wallet_ledger','wallet_matches','wallet_reservations','wallet_probability','wallet_operation_ids'];
export const TRANSFER_REQUIRED_TABLES=TRANSFER_TABLES;
export const REQUIRED_TABLES=[...LEGACY_REQUIRED_TABLES,...TRANSFER_REQUIRED_TABLES];
const legacyIntegrity=['balance_mismatches','scope_mismatches','unbalanced_transactions','ledger_version_mismatches','orphan_records','invalid_constraints'];
const transferIntegrity=['clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches'];
const legacyPending=['pending_cycles','pending_probability_operations','pending_pvp_operations','active_rooms','pending_wallet_operations'];
export const RESTORE_AUDIT_SQL=`WITH ledger AS (
 SELECT scope_id,account,sum(delta_available) available,sum(delta_reserved) reserved FROM wallet_ledger GROUP BY scope_id,account
), accounts AS (
 SELECT scope_id,'user:'||external_user_id account,available::numeric available,reserved::numeric reserved FROM wallet_users
 UNION ALL SELECT scope_id,'treasury',treasury_available,treasury_reserved FROM wallet_scopes
 UNION ALL SELECT scope_id,'fee',fee_available,0 FROM wallet_scopes
 UNION ALL SELECT scope_id,'match:'||match_id,pool_minor,0 FROM wallet_matches
), mismatches AS (
 SELECT 1 FROM accounts a FULL JOIN ledger l USING(scope_id,account)
 WHERE COALESCE(a.account,l.account)!='reference_funding' AND
 (COALESCE(a.available,0)!=COALESCE(l.available,0) OR COALESCE(a.reserved,0)!=COALESCE(l.reserved,0))
), scope_errors AS (
 SELECT 1 FROM wallet_scopes s LEFT JOIN gp_apps a ON a.id=s.app_id WHERE a.id IS NULL OR
 s.partner_id!=a.partner_id OR s.environment!=a.environment OR s.wallet_scope_id!=a.wallet_scope_id OR s.currency_id!=a.currency_id OR s.currency_scale!=a.currency_scale OR
 s.scope_id!=concat_ws(':',s.partner_id,s.app_id,s.environment,s.wallet_scope_id,s.currency_id)
), transaction_errors AS (
 SELECT scope_id,transaction_id FROM wallet_ledger GROUP BY scope_id,transaction_id HAVING sum(delta_available+delta_reserved)!=0
), scope_version_errors AS (
 SELECT s.scope_id FROM wallet_scopes s LEFT JOIN wallet_ledger l USING(scope_id) GROUP BY s.scope_id HAVING s.ledger_version!=count(l.id)
), orphan_errors AS (
 SELECT 1 FROM wallet_reservations r LEFT JOIN wallet_users u USING(scope_id,external_user_id) WHERE u.external_user_id IS NULL
 UNION ALL SELECT 1 FROM wallet_probability p LEFT JOIN wallet_users u USING(scope_id,external_user_id) WHERE p.external_user_id IS NOT NULL AND u.external_user_id IS NULL
 UNION ALL SELECT 1 FROM gp_operations o LEFT JOIN gp_cycles c ON c.id=o.aggregate_id WHERE c.id IS NULL OR o.app_id!=c.app_id
 UNION ALL SELECT 1 FROM pvp_operations o JOIN pvp_rooms r ON r.id=o.room_id WHERE o.app_id!=r.app_id
 UNION ALL SELECT 1 FROM wallet_operation_ids o JOIN wallet_scopes s USING(scope_id) WHERE o.partner_id!=s.partner_id OR o.app_id!=s.app_id OR o.environment!=s.environment
), invalid_constraints AS (
 SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated
)
SELECT json_build_object(
 'balance_mismatches',(SELECT count(*) FROM mismatches),
 'scope_mismatches',(SELECT count(*) FROM scope_errors),
 'unbalanced_transactions',(SELECT count(*) FROM transaction_errors),
 'ledger_version_mismatches',(SELECT count(*) FROM scope_version_errors),
 'orphan_records',(SELECT count(*) FROM orphan_errors),
 'invalid_constraints',(SELECT count(*) FROM invalid_constraints),
 'pending_cycles',(SELECT count(*) FROM gp_cycles WHERE status NOT IN ('SETTLED','REJECTED')),
 'pending_probability_operations',(SELECT count(*) FROM gp_operations WHERE state='PENDING'),
 'pending_pvp_operations',(SELECT count(*) FROM pvp_operations WHERE state='PENDING'),
 'active_rooms',(SELECT count(*) FROM pvp_rooms WHERE status NOT IN ('settled','voided','cancelled')),
 'pending_wallet_operations',(SELECT count(*) FROM wallet_operations WHERE state='PENDING')
);`;

// Keep the legacy literal usable for pre-transfer backups. New databases must
// project the signed clearing account into the ledger, never exempt it.
export function restoreAuditSQL(transfers=true){
 if(!transfers)return RESTORE_AUDIT_SQL;
 return RESTORE_AUDIT_SQL.replace('), mismatches AS (',
  " UNION ALL SELECT scope_id,account,net_minor,0 FROM wallet_transfer_clearing\n), mismatches AS (")
  .replace(/\);\s*$/,`)::jsonb || (SELECT audit::jsonb FROM (${TRANSFER_AUDIT_SQL.trim().replace(/;$/,'')}) transfer_audit)
 || jsonb_build_object('pending_transfers',(SELECT count(*) FROM gp_transfers WHERE state='PENDING'));`);
}
export const TRANSFERS_RESTORE_AUDIT_SQL=restoreAuditSQL();
// psql conditionals select a statement only after checking the whole feature.
// A SQL CASE cannot guard references to absent relations at parse time.
export function restoreInspectSQL(){
 const values=TRANSFER_REQUIRED_TABLES.map(name=>`('${name}')`).join(',');
 const result=(tables,transfers)=>`SELECT json_build_object('transfer_schema','${transfers?'present':'absent'}',
 'rows',json_build_object(${tables.map(name=>`'${name}',(SELECT count(*) FROM ${name})`).join(',')}),
 'audit',(${restoreAuditSQL(transfers).trim().replace(/;$/,'')}),
 'keys',(SELECT COALESCE(json_agg(secret_enc),'[]'::json) FROM gp_keys));`;
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog,public;
SET LOCAL statement_timeout='30s';
SELECT count(c.oid)=0 AS transfer_absent, count(c.oid)=5 AND bool_and(c.relkind='r') AS transfer_present
 FROM (VALUES ${values}) t(name) LEFT JOIN pg_namespace n ON n.nspname='public'
 LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=t.name
\\gset
\\if :transfer_absent
SELECT NOT EXISTS(SELECT 1 FROM wallet_ledger WHERE account LIKE 'transfer:%' OR meta->>'kind' LIKE 'transfer_%') AS transfer_legacy_clean
\\gset
\\if :transfer_legacy_clean
${result(LEGACY_REQUIRED_TABLES,false)}
\\else
DO $transfer_guard$ BEGIN RAISE EXCEPTION 'TRANSFER_SCHEMA_INCOMPLETE'; END $transfer_guard$;
\\endif
\\else
\\if :transfer_present
${result(REQUIRED_TABLES,true)}
\\else
DO $transfer_guard$ BEGIN RAISE EXCEPTION 'TRANSFER_SCHEMA_INCOMPLETE'; END $transfer_guard$;
\\endif
\\endif
COMMIT;`;
}

export function dockerAdapter({execute=command}={}){
 const sql=async(database,query)=>{
  if(database!=='postgres')validateDatabaseName(database);
  return execute('docker',['exec','-i','oasis-postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','oasis','-d',database],{input:query});
 };
 return {
  exists:async name=>{validateDatabaseName(name);return (await sql('postgres',`SELECT count(*) FROM pg_database WHERE datname='${name}';`)).trim()!=='0';},
  create:async name=>{validateDatabaseName(name);await sql('postgres',`CREATE DATABASE "${name}" WITH TEMPLATE template0;`);},
  restore:async(name,file)=>{validateDatabaseName(name);await command('docker',['exec','-i','oasis-postgres','pg_restore','-U','oasis','--dbname',name,'--no-owner','--no-acl','--exit-on-error','--single-transaction'],{file,timeoutMs:300000});},
  inspect:async name=>{
   try{return JSON.parse((await sql(name,restoreInspectSQL())).trim());}
   catch{fail('SCHEMA_INVALID');}
  },
  drop:async name=>{validateDatabaseName(name);await sql('postgres',`DROP DATABASE "${name}" WITH (FORCE);`);},
 };
}

export async function prepareBackup(backup,temporary){
 if(await realpath(backup)!==backup)fail('UNSAFE_BACKUP_PATH');
 const info=await lstat(backup);if(!info.isDirectory()||(info.mode&0o022))fail('UNSAFE_BACKUP_PATH');
 for(const name of ['SHA256SUMS',...hashes,'database-contents.txt']){
  const file=path.join(backup,name),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size===0||(info.mode&0o022))fail('BACKUP_INCOMPLETE');
  await copyFile(file,path.join(temporary,name));
 }
 const manifest=await readFile(path.join(temporary,'SHA256SUMS'),'utf8'),expected=parseChecksums(manifest);
 for(const name of hashes)if(await digest(path.join(temporary,name))!==expected[name])fail('CHECKSUM_MISMATCH');
 return {manifest_sha256:createHash('sha256').update(manifest).digest('hex'),files:expected};
}
async function extractPrivate(temporary){
 const destination=path.join(temporary,'restored-config');await mkdir(destination,{mode:0o700});
 try{await command('python3',['-c',SAFE_EXTRACT_PY,path.join(temporary,'private-config.tar.gz'),destination]);}catch{fail('ARCHIVE_UNSAFE');}
 for(const file of ['private/runtime.env','private/postgres.env','private/state/master.key']){
  try{if(!(await stat(path.join(destination,file))).isFile())fail('BACKUP_INCOMPLETE');}catch{fail('BACKUP_INCOMPLETE');}
 }
 const master=await readFile(path.join(destination,'private/state/master.key'));
 if(master.length!==32)fail('MASTER_KEY_INVALID');
 return master;
}
async function writeNewReport(filename,report){
 await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
 if(await realpath(path.dirname(filename))!==path.dirname(filename))fail('UNSAFE_REPORT_PATH');
 const temporary=filename+'.'+randomBytes(8).toString('hex')+'.tmp';let handle;
 try{
  handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.sync();await handle.close();handle=null;
  try{await link(temporary,filename);}catch(error){if(error.code==='EEXIST')fail('REPORT_EXISTS');throw error;}
 }finally{if(handle)await handle.close();await unlink(temporary).catch(()=>{});}
}
const numberCount=value=>Number.isSafeInteger(value)&&value>=0;
export async function runRestoreDrill({backup,report,databaseName=`oasis_restore_${new Date().toISOString().slice(0,10).replaceAll('-','')}_${randomBytes(8).toString('hex')}`},{
 adapter=dockerAdapter(),prepare=prepareBackup,extract=extractPrivate,makeTemp=()=>mkdtemp('/tmp/oasis-restore-'),removeTemp=directory=>rm(directory,{recursive:true,force:true}),
 tempExists=async directory=>{try{await lstat(directory);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}},writeReport=writeNewReport,
}={}){
 validatePaths(backup,report);validateDatabaseName(databaseName);
 const result={schema_version:1,started_at:new Date().toISOString(),status:'failed',database:databaseName,backup:path.basename(backup),checks:{},cleanup:{database_created:false,database_removed:false,private_directory_removed:false}};
 let temporary,created=false,createAttempted=false,master;
 try{
  // A pre-existing database is never touched, even if its name passes the whitelist.
  if(await adapter.exists(databaseName))fail('DATABASE_ALREADY_EXISTS');
  temporary=await makeTemp();result.backup_integrity=await prepare(backup,temporary);result.checks.checksums=true;
  master=await extract(temporary);result.checks.private_config_restored=true;
  createAttempted=true;await adapter.create(databaseName);created=true;result.cleanup.database_created=true;
  await adapter.restore(databaseName,path.join(temporary,'database.dump'));result.checks.pg_restore=true;
  const {rows,audit,keys,transfer_schema}=await adapter.inspect(databaseName);
  if(!['present','absent'].includes(transfer_schema))fail('SCHEMA_INVALID');
  const tables=transfer_schema==='present'?REQUIRED_TABLES:LEGACY_REQUIRED_TABLES;
  if(!tables.every(table=>numberCount(rows?.[table]))||Object.keys(rows??{}).length!==tables.length||!Array.isArray(keys)||keys.length===0||rows.gp_keys!==keys.length)fail('SCHEMA_INVALID');
  for(const key of keys)decryptCheck(master,key);
  result.checks.master_key_decrypts=keys.length;result.row_counts=Object.fromEntries(tables.map(table=>[table,rows[table]]));result.transfer_schema=transfer_schema;
  const integrity=transfer_schema==='present'?[...legacyIntegrity,...transferIntegrity]:legacyIntegrity;
  const auditNames=[...integrity,...legacyPending,...(transfer_schema==='present'?['pending_transfers']:[])];
  if(!auditNames.every(name=>numberCount(audit?.[name]))||Object.keys(audit??{}).length!==auditNames.length)fail('SCHEMA_INVALID');
  result.ledger_audit=Object.fromEntries(auditNames.map(name=>[name,audit[name]]));
  if(integrity.some(name=>audit[name]!==0))fail('LEDGER_INCONSISTENT');
  result.checks.schema_and_ledger=true;result.status='ok';
 }catch(error){result.error=codeOf(error);}
 finally{
  if(master)master.fill(0);
  if(createAttempted&&!created){
   // An interrupted CREATE may have committed. Never drop an unconfirmed database.
   try{result.cleanup.unconfirmed_database_present=await adapter.exists(databaseName);}catch{result.cleanup.unconfirmed_database_present=null;}
   if(result.cleanup.unconfirmed_database_present!==false)result.cleanup.database_error='DATABASE_CREATE_UNCONFIRMED';
  }
  if(created){try{await adapter.drop(databaseName);result.cleanup.database_removed=!(await adapter.exists(databaseName));if(!result.cleanup.database_removed)fail('DATABASE_CLEANUP_FAILED');}catch{result.status='failed';result.cleanup.database_error='DATABASE_CLEANUP_FAILED';}}
  if(temporary){try{await removeTemp(temporary);result.cleanup.private_directory_removed=!(await tempExists(temporary));if(!result.cleanup.private_directory_removed)fail('PRIVATE_CLEANUP_FAILED');}catch{result.status='failed';result.cleanup.private_error='PRIVATE_CLEANUP_FAILED';result.cleanup.temporary_directory=path.basename(temporary);}}
 }
 result.finished_at=new Date().toISOString();await writeReport(report,result);
 return {exitCode:result.status==='ok'?0:1,report:result};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.getuid?.()!==0)fail('ROOT_REQUIRED');
  if(process.argv.length!==4)fail('DRILL_FAILED');
  process.umask(0o077);
  const result=await runRestoreDrill({backup:process.argv[2],report:process.argv[3]});
  process.stdout.write(JSON.stringify(result.report)+'\n');process.exitCode=result.exitCode;
 }catch(error){process.stderr.write(JSON.stringify({status:'failed',code:codeOf(error)})+'\n');process.exitCode=1;}
}
