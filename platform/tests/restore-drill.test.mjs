import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {decryptCheck,dockerAdapter,parseChecksums,prepareBackup,LEGACY_REQUIRED_TABLES,REQUIRED_TABLES,restoreAuditSQL,restoreInspectSQL,runRestoreDrill,SAFE_EXTRACT_PY,validateDatabaseName,validatePaths} from '../deploy/restore-drill.mjs';
import {TRANSFER_AUDIT_SQL} from '../server/transfers/audit.mjs';

const exec=promisify(execFile),name='oasis_restore_20260920_0123456789abcdef';
const paths={backup:'/opt/oasis/backups/20260920T000000Z',report:'/opt/oasis/acceptance/restore-drill-test.json',databaseName:name};
const secret='a-private-wallet-secret-must-not-be-logged';
function encrypted(master){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv),bytes=Buffer.concat([cipher.update(JSON.stringify(Buffer.from(secret).toString('base64'))),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');}
function fixture({existing=false,restoreFails=false,decryptFails=false,dropFails=false,auditMismatch=false,transfers=true,pendingTransfers=0,transferMismatch={}}={}){
 const master=randomBytes(32),events=[],reports=[];let present=existing,temp=false;
 const dependencies={
  makeTemp:async()=>{temp=true;events.push('temp');return '/tmp/oasis-restore-test';},
  removeTemp:async()=>{temp=false;events.push('remove-temp');},tempExists:async()=>temp,
  prepare:async()=>{events.push('checksums');return {manifest_sha256:'a'.repeat(64),files:{'database.dump':'b'.repeat(64)}};},
  extract:async()=>{events.push('extract');return Buffer.from(master);},
  writeReport:async(_,report)=>reports.push(report),
  adapter:{
   exists:async()=>present,
   create:async()=>{events.push('create');assert.equal(present,false);present=true;},
   restore:async()=>{events.push('restore');if(restoreFails)throw new Error(secret);},
   inspect:async()=>{events.push('inspect');return {
    transfer_schema:transfers?'present':'absent',rows:Object.fromEntries((transfers?REQUIRED_TABLES:LEGACY_REQUIRED_TABLES).map(table=>[table,1])),keys:[encrypted(decryptFails?randomBytes(32):master)],
    audit:{balance_mismatches:auditMismatch?1:0,scope_mismatches:0,unbalanced_transactions:0,ledger_version_mismatches:0,orphan_records:0,invalid_constraints:0,pending_cycles:2,pending_probability_operations:1,pending_pvp_operations:0,active_rooms:0,pending_wallet_operations:0,
     ...(transfers?{pending_transfers:pendingTransfers,clearing_mismatches:0,transfer_order_mismatches:0,wallet_hold_mismatches:0,...transferMismatch}:{})},
   };},
   drop:async()=>{events.push('drop');if(dropFails)throw new Error(secret);present=false;},
  },
 };
 return {dependencies,events,reports,present:()=>present,temp:()=>temp};
}

test('restore paths and generated database whitelist reject current database, traversal and arbitrary targets',()=>{
 assert.deepEqual(validatePaths(paths.backup,paths.report),{backup:paths.backup,report:paths.report});assert.equal(validateDatabaseName(name),name);
 for(const bad of ['oasis_platform','postgres','oasis_restore_existing','oasis_restore_20260920_0123456789abcdef;DROP DATABASE oasis_platform'])assert.throws(()=>validateDatabaseName(bad),/UNSAFE_DATABASE_NAME/);
 for(const bad of ['/opt/oasis/private','/opt/oasis/backups/20260920T000000Z/../private','/tmp/backup','relative'])assert.throws(()=>validatePaths(bad,paths.report),/UNSAFE_BACKUP_PATH/);
 for(const bad of ['/opt/oasis/private/runtime.env','/opt/oasis/current/platform/dist/report.json','/opt/oasis/acceptance/../private/restore-drill-x.json'])assert.throws(()=>validatePaths(paths.backup,bad),/UNSAFE_REPORT_PATH/);
});

test('checksum manifest requires exactly the three named complete-backup artifacts',()=>{
 const valid=['database.dump','private-config.tar.gz','release.txt'].map(file=>'a'.repeat(64)+'  '+file).join('\n')+'\n';
 assert.equal(Object.keys(parseChecksums(valid)).length,3);
 for(const bad of [valid+'a'.repeat(64)+'  database.dump\n',valid.replace('release.txt','../runtime.env'),valid.split('\n')[0],valid.replace('a','z')])assert.throws(()=>parseChecksums(bad),/CHECKSUM_MANIFEST_INVALID/);
});

test('existing isolated-name database is never restored or deleted',async()=>{
 const fixtureValue=fixture({existing:true}),result=await runRestoreDrill(paths,fixtureValue.dependencies);
 assert.equal(result.exitCode,1);assert.equal(result.report.error,'DATABASE_ALREADY_EXISTS');assert.deepEqual(fixtureValue.events,[]);assert.equal(fixtureValue.present(),true);
});

test('successful restore verifies copied master key, reports only counts, and proves isolated resources removed',async()=>{
 const fixtureValue=fixture(),result=await runRestoreDrill(paths,fixtureValue.dependencies);
 assert.equal(result.exitCode,0);assert.equal(result.report.checks.master_key_decrypts,1);assert.equal(result.report.ledger_audit.pending_cycles,2);
 assert.deepEqual(result.report.cleanup,{database_created:true,database_removed:true,private_directory_removed:true});
 assert.deepEqual(fixtureValue.events,['temp','checksums','extract','create','restore','inspect','drop','remove-temp']);assert.equal(fixtureValue.present(),false);assert.equal(fixtureValue.temp(),false);
 assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(result).includes('secret_enc'),false);
});

test('transfer restore reports durable pending obligations without treating them as corrupt or settling them',async()=>{
 const f=fixture({pendingTransfers:7}),result=await runRestoreDrill(paths,f.dependencies);
 assert.equal(result.exitCode,0);assert.equal(result.report.transfer_schema,'present');
 assert.equal(result.report.ledger_audit.pending_transfers,7);
 assert.equal(result.report.row_counts.gp_transfer_outbox,1);
 assert.deepEqual(f.events,['temp','checksums','extract','create','restore','inspect','drop','remove-temp']);
});

test('each clearing, order and exact-owned-hold mismatch independently fails restored ledger integrity',async()=>{
 for(const field of ['clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches']){
  const f=fixture({transferMismatch:{[field]:1}}),result=await runRestoreDrill(paths,f.dependencies);
  assert.equal(result.exitCode,1);assert.equal(result.report.error,'LEDGER_INCONSISTENT');
  assert.equal(result.report.cleanup.database_removed,true);
 }
});

test('only an explicit complete legacy schema can omit all five transfer tables',async()=>{
 const legacy=await runRestoreDrill(paths,fixture({transfers:false}).dependencies);
 assert.equal(legacy.exitCode,0);assert.equal(legacy.report.transfer_schema,'absent');
 assert.equal(Object.hasOwn(legacy.report.ledger_audit,'pending_transfers'),false);
 for(const damage of [x=>delete x.transfer_schema,x=>x.transfer_schema='partial',x=>delete x.rows.gp_transfer_outbox,
  x=>delete x.audit.clearing_mismatches,x=>x.audit.wallet_hold_mismatches=null,x=>x.transfer_schema='absent']){
  const f=fixture(),inspect=f.dependencies.adapter.inspect;
  f.dependencies.adapter.inspect=async()=>{const value=await inspect();damage(value);return value;};
  const result=await runRestoreDrill(paths,f.dependencies);
  assert.equal(result.report.error,'SCHEMA_INVALID');assert.equal(result.report.cleanup.database_removed,true);
 }
});

test('restore inspector uses one read-only snapshot, conditionally parses tables and projects clearing without exemption',async()=>{
 const audit=restoreAuditSQL(true),legacy=restoreAuditSQL(false);
 assert.match(audit,/UNION ALL SELECT scope_id,account,net_minor,0 FROM wallet_transfer_clearing/);
 assert.ok(audit.includes(TRANSFER_AUDIT_SQL));assert.match(audit,/'pending_transfers'/);
 assert.doesNotMatch(legacy,/wallet_transfer_clearing/);
 assert.doesNotMatch(audit,/COALESCE\(a.account,l.account\).*transfer/);
 const program=restoreInspectSQL();assert.match(program,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
 assert.match(program,/count\(c.oid\)=0/);assert.match(program,/count\(c.oid\)=5 AND bool_and\(c.relkind='r'\)/);
 assert.match(program,/meta->>'kind' LIKE 'transfer_%'/);assert.match(program,/RAISE EXCEPTION 'TRANSFER_SCHEMA_INCOMPLETE'/);
 const calls=[],payload={transfer_schema:'absent',rows:{},audit:{},keys:[]};
 const adapter=dockerAdapter({execute:async(...args)=>{calls.push(args);return JSON.stringify(payload);}});
 assert.deepEqual(await adapter.inspect(name),payload);assert.equal(calls.length,1);
 assert.ok(calls[0][1].includes('ON_ERROR_STOP=1'));assert.equal(calls[0][2].input,program);
 const broken=dockerAdapter({execute:async()=>{throw Error(secret);}});
 await assert.rejects(broken.inspect(name),error=>error.code==='SCHEMA_INVALID'&&!error.message.includes(secret));
});

test('restore failure destroys only the database this invocation created and private temporary files',async()=>{
 const fixtureValue=fixture({restoreFails:true}),result=await runRestoreDrill(paths,fixtureValue.dependencies);
 assert.equal(result.exitCode,1);assert.equal(result.report.cleanup.database_removed,true);assert.equal(result.report.cleanup.private_directory_removed,true);
 assert.ok(fixtureValue.events.includes('drop'));assert.equal(JSON.stringify(result).includes(secret),false);
});

test('wrong master key and inconsistent ledger fail acceptance but still clean up',async()=>{
 for(const [options,error]of [[{decryptFails:true},'KEY_DECRYPTION_FAILED'],[{auditMismatch:true},'LEDGER_INCONSISTENT']]){
  const fixtureValue=fixture(options),result=await runRestoreDrill(paths,fixtureValue.dependencies);
  assert.equal(result.exitCode,1);assert.equal(result.report.error,error);assert.equal(result.report.cleanup.database_removed,true);assert.equal(fixtureValue.temp(),false);
 }
});

test('cleanup failure cannot claim successful restore, and private directory removal still runs',async()=>{
 const fixtureValue=fixture({dropFails:true}),result=await runRestoreDrill(paths,fixtureValue.dependencies);
 assert.equal(result.exitCode,1);assert.equal(result.report.cleanup.database_removed,false);assert.equal(result.report.cleanup.database_error,'DATABASE_CLEANUP_FAILED');assert.equal(fixtureValue.temp(),false);
 assert.equal(JSON.stringify(result).includes(secret),false);
});

test('checksum failure occurs before database creation and cleans copied private files',async()=>{
 const fixtureValue=fixture();fixtureValue.dependencies.prepare=async()=>{throw Object.assign(new Error('CHECKSUM_MISMATCH'),{code:'CHECKSUM_MISMATCH'});};
 const result=await runRestoreDrill(paths,fixtureValue.dependencies);assert.equal(result.report.error,'CHECKSUM_MISMATCH');assert.equal(fixtureValue.events.includes('create'),false);assert.equal(fixtureValue.events.includes('drop'),false);assert.equal(fixtureValue.temp(),false);
});

test('unconfirmed create never drops a possibly pre-existing database and reports the unresolved resource',async()=>{
 const fixtureValue=fixture();fixtureValue.dependencies.adapter.create=async()=>{throw new Error('uncertain');};
 let calls=0;fixtureValue.dependencies.adapter.exists=async()=>++calls>1;
 const result=await runRestoreDrill(paths,fixtureValue.dependencies);
 assert.equal(result.exitCode,1);assert.equal(result.report.cleanup.unconfirmed_database_present,true);assert.equal(result.report.cleanup.database_error,'DATABASE_CREATE_UNCONFIRMED');assert.equal(fixtureValue.events.includes('drop'),false);assert.equal(fixtureValue.temp(),false);
});

test('backup bytes are copied and SHA256 checked; corruption and symlink artifacts are refused',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'oasis-drill-backup-'));
 try{
  const backup=path.join(root,'source'),destination=path.join(root,'copy');await mkdir(backup,{mode:0o700});await mkdir(destination,{mode:0o700});
  const files={'database.dump':'database bytes','private-config.tar.gz':'private bytes','release.txt':'release path'};
  for(const [file,content]of Object.entries(files))await writeFile(path.join(backup,file),content,{mode:0o600});
  await writeFile(path.join(backup,'database-contents.txt'),'table list',{mode:0o600});
  await writeFile(path.join(backup,'SHA256SUMS'),Object.entries(files).map(([file,content])=>createHash('sha256').update(content).digest('hex')+'  '+file).join('\n')+'\n',{mode:0o600});
  // macOS /var resolves to /private/var; production path validation rejects symlink parents.
  const {realpath}=await import('node:fs/promises');const canonical=await realpath(backup);
  const result=await prepareBackup(canonical,destination);assert.equal(Object.keys(result.files).length,3);assert.equal(await readFile(path.join(destination,'database.dump'),'utf8'),'database bytes');
  await writeFile(path.join(backup,'database.dump'),'corrupted',{mode:0o600});await assert.rejects(prepareBackup(canonical,destination),/CHECKSUM_MISMATCH/);
  await rm(path.join(backup,'database.dump'));await symlink(path.join(backup,'release.txt'),path.join(backup,'database.dump'));await assert.rejects(prepareBackup(canonical,destination),/BACKUP_INCOMPLETE/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('AES-GCM key probe rejects truncated, tampered or wrongly keyed ciphertext without returning plaintext',()=>{
 const key=randomBytes(32),value=encrypted(key);assert.equal(decryptCheck(key,value),true);
 assert.throws(()=>decryptCheck(randomBytes(32),value),/KEY_DECRYPTION_FAILED/);assert.throws(()=>decryptCheck(key,'bad'),/KEY_DECRYPTION_FAILED/);assert.throws(()=>decryptCheck(Buffer.alloc(10),value),/MASTER_KEY_INVALID/);
});

test('real archive extraction permits private regular files and rejects traversal, symlinks, hardlinks and devices before writing',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'oasis-restore-archive-'));
 const makeArchive=`import io, tarfile, sys
target, kind = sys.argv[1:]
with tarfile.open(target, 'w:gz') as tar:
    entry=tarfile.TarInfo('private/state/master.key')
    if kind=='traversal': entry.name='private/../../escaped'
    if kind=='absolute': entry.name='/tmp/escaped'
    if kind=='symlink': entry.type=tarfile.SYMTYPE; entry.linkname='/opt/oasis/private'
    if kind=='hardlink': entry.type=tarfile.LNKTYPE; entry.linkname='/opt/oasis/private/runtime.env'
    if kind=='device': entry.type=tarfile.CHRTYPE
    payload=b'x'*32
    if entry.isfile(): entry.size=len(payload); tar.addfile(entry,io.BytesIO(payload))
    else: tar.addfile(entry)
`;
 try{
  for(const kind of ['regular','traversal','absolute','symlink','hardlink','device']){
   const archive=path.join(dir,kind+'.tar.gz'),destination=path.join(dir,kind);await mkdir(destination,{mode:0o700});
   await exec('python3',['-c',makeArchive,archive,kind]);
   if(kind==='regular'){
    await exec('python3',['-c',SAFE_EXTRACT_PY,archive,destination]);const file=path.join(destination,'private/state/master.key');assert.equal((await readFile(file)).length,32);assert.equal((await stat(file)).mode&0o777,0o600);
   }else await assert.rejects(exec('python3',['-c',SAFE_EXTRACT_PY,archive,destination]));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
