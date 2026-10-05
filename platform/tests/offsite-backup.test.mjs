import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,realpath,readdir,rm,stat,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildArchive,encryptArchive,inspectArchive,MAX_ARCHIVE_BYTES,parseManifest,readBounded,restoreBackup,validateBackupEntries,validateExportPaths,verifyBackup,verifyEnvelope,writeExclusive} from '../deploy/offsite-backup.mjs';

const pair=generateKeyPairSync('rsa',{modulusLength:2048}),stamp='20260920T120000Z';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const exec=promisify(execFile);
function fixture(){
 const entries={
  'database.dump':Buffer.from('restorable database bytes'),
  'private-config.tar.gz':Buffer.from('PRIVATE_KEY_MUST_NOT_APPEAR_IN_SUMMARY'),
  'release.txt':Buffer.from('/opt/oasis/releases/test\n'),
  'database-contents.txt':Buffer.from('public database objects\n'),
 };
 entries.SHA256SUMS=Buffer.from(['database.dump','private-config.tar.gz','release.txt'].map(name=>digest(entries[name])+'  '+name).join('\n')+'\n');
 const archive=buildArchive(entries),envelope=encryptArchive(archive,pair.publicKey,{sourceStamp:stamp,createdAt:'2026-09-20T12:00:00.000Z'});
 return {entries,archive,envelope};
}

test('RSA OAEP SHA256 and AES-GCM roundtrip verifies complete archive and exposes hashes only',()=>{
 const {archive,envelope,entries}=fixture(),result=verifyEnvelope(envelope,pair.privateKey);
 assert.equal(result.status,'ok');assert.equal(result.source_stamp,stamp);assert.equal(result.archive_sha256,digest(archive));assert.equal(result.manifest_sha256,digest(entries.SHA256SUMS));assert.equal(result.verified_files,5);
 assert.equal(result.envelope_sha256,digest(envelope));assert.equal(JSON.stringify(result).includes('PRIVATE_KEY_MUST_NOT_APPEAR_IN_SUMMARY'),false);
 assert.equal(JSON.stringify(result).includes('wrapped_key'),false);assert.equal(envelope.includes(entries['private-config.tar.gz']),false);
 const another=encryptArchive(archive,pair.publicKey,{sourceStamp:stamp});assert.notDeepEqual(another,envelope);
});

test('ciphertext, nonce, authenticated metadata, wrapped key, tag and truncation tampering all fail closed',()=>{
 const {envelope}=fixture(),magicBytes=10,headerBytes=envelope.readUInt32BE(magicBytes),headerStart=magicBytes+4,cipherStart=headerStart+headerBytes;
 for(const kind of ['cipher','nonce','source','archive_hash','wrapped_key','tag','truncated','magic','length']){
  let changed=Buffer.from(envelope);
  if(kind==='cipher')changed[cipherStart+19]^=1;
  else if(kind==='tag')changed[changed.length-1]^=1;
  else if(kind==='truncated')changed=changed.subarray(0,changed.length-7);
  else if(kind==='magic')changed[0]^=1;
  else if(kind==='length')changed.writeUInt32BE(9000,magicBytes);
  else{
   const header=JSON.parse(changed.subarray(headerStart,cipherStart));
   if(kind==='source')header.source_stamp='20260921T120000Z';
   if(kind==='archive_hash')header.archive_sha256='0'.repeat(64);
   if(kind==='nonce')header.iv=Buffer.alloc(12,1).toString('base64');
   if(kind==='wrapped_key')header.wrapped_key=(header.wrapped_key[0]==='A'?'B':'A')+header.wrapped_key.slice(1);
   const updated=Buffer.from(JSON.stringify(header));assert.equal(updated.length,headerBytes);updated.copy(changed,headerStart);
  }
  assert.throws(()=>verifyEnvelope(changed,pair.privateKey),{code:'ENVELOPE_VERIFY_FAILED'},kind);
 }
});

test('a different RSA private key cannot verify the encrypted backup',()=>{
 const other=generateKeyPairSync('rsa',{modulusLength:2048});
 assert.throws(()=>verifyEnvelope(fixture().envelope,other.privateKey),{code:'ENVELOPE_VERIFY_FAILED'});
});

test('invalid or incomplete manifests and modified source artifacts are rejected before encryption',()=>{
 const {entries}=fixture();
 assert.throws(()=>parseManifest(Buffer.from('bad manifest')),{code:'BACKUP_MANIFEST_INVALID'});
 assert.throws(()=>parseManifest(Buffer.from(entries.SHA256SUMS.toString().replace('release.txt','../runtime.env'))),{code:'BACKUP_MANIFEST_INVALID'});
 const incomplete={...entries};delete incomplete['database-contents.txt'];assert.throws(()=>validateBackupEntries(incomplete),{code:'BACKUP_INCOMPLETE'});
 assert.throws(()=>buildArchive({...entries,'database.dump':Buffer.from('modified')}),{code:'BACKUP_CHECKSUM_MISMATCH'});
});

test('archive structure and raw tar hash are checked, not just successful RSA decryption',()=>{
 const {archive}=fixture(),changed=Buffer.from(archive);changed[10]^=1;
 assert.throws(()=>inspectArchive(changed),{code:'ARCHIVE_INVALID'});
 assert.throws(()=>inspectArchive(Buffer.alloc(MAX_ARCHIVE_BYTES+1)),{code:'ARCHIVE_INVALID'});
 assert.throws(()=>encryptArchive(archive,pair.publicKey,{sourceStamp:'../../private'}),{code:'SOURCE_STAMP_INVALID'});
});

test('export accepts only completed backup directories and fixed private encrypted output paths',()=>{
 const backup='/opt/oasis/backups/'+stamp,output='/opt/oasis/private/offsite/oasis-backup-'+stamp+'.oasis-backup';
 assert.deepEqual(validateExportPaths(backup,output),{backup,output});
 for(const invalid of ['/tmp/backup','/opt/oasis/private','/opt/oasis/backups/'+stamp+'/../private'])assert.throws(()=>validateExportPaths(invalid,output),{code:'UNSAFE_BACKUP_PATH'});
 for(const invalid of ['/opt/oasis/private/runtime.env','/opt/oasis/current/platform/dist/export.oasis-backup','/tmp/oasis-backup-'+stamp+'.oasis-backup',output.replace(stamp,'20260921T120000Z')])assert.throws(()=>validateExportPaths(backup,invalid),{code:'UNSAFE_OUTPUT_PATH'});
});

test('encrypted output is private, atomically created once and never overwrites another file',async()=>{
 const temporary=await mkdtemp(path.join(tmpdir(),'oasis-offsite-'));
 try{
  const directory=await realpath(temporary),file=path.join(directory,'oasis-backup-'+stamp+'.oasis-backup'),{envelope}=fixture();
  await writeExclusive(file,envelope);assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(await readFile(file),envelope);
  await assert.rejects(writeExclusive(file,Buffer.from('overwrite')),{code:'OUTPUT_EXISTS'});assert.deepEqual(await readFile(file),envelope);
  assert.deepEqual(await readdir(directory),[path.basename(file)]);
  await assert.rejects(writeExclusive(path.join(directory,'runtime.env'),envelope),{code:'UNSAFE_OUTPUT_PATH'});
 }finally{await rm(temporary,{recursive:true,force:true});}
});

test('output symlink parents and symlink input files are rejected',async()=>{
 const temporary=await mkdtemp(path.join(tmpdir(),'oasis-offsite-paths-'));
 try{
  const directory=await realpath(temporary),real=path.join(directory,'real'),alias=path.join(directory,'alias');await mkdir(real,{mode:0o700});await symlink(real,alias);
  await assert.rejects(writeExclusive(path.join(alias,'oasis-backup-'+stamp+'.oasis-backup'),fixture().envelope),{code:'UNSAFE_OUTPUT_PATH'});
  const target=path.join(real,'key.pem');await writeFile(target,'test key');const keyAlias=path.join(directory,'key-link.pem');await symlink(target,keyAlias);
  await assert.rejects(readBounded(keyAlias,65536));
 }finally{await rm(temporary,{recursive:true,force:true});}
});

test('file verification reads a temporary private PEM in memory and creates no extracted files',async()=>{
 const temporary=await mkdtemp(path.join(tmpdir(),'oasis-offsite-verify-'));
 try{
  const directory=await realpath(temporary),input=path.join(directory,'download.oasis-backup'),privateKeyFile=path.join(directory,'temporary-test-rsa.pem');
  await writeFile(input,fixture().envelope,{mode:0o600});await writeFile(privateKeyFile,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  const before=(await readdir(directory)).sort(),result=await verifyBackup({input,privateKeyFile});assert.equal(result.status,'ok');assert.equal(result.verified_files,5);assert.deepEqual((await readdir(directory)).sort(),before);
  await assert.rejects(readBounded(input,10),{code:'FILE_SIZE_OR_TYPE_REJECTED'});
 }finally{await rm(temporary,{recursive:true,force:true});}
});

async function fileFixture(){
 const temporary=await mkdtemp(path.join(tmpdir(),'oasis-offsite-restore-')),directory=await realpath(temporary);
 const input=path.join(directory,'download.oasis-backup'),privateKeyFile=path.join(directory,'temporary-test-rsa.pem'),destination=path.join(directory,'recovered'),data=fixture();
 await writeFile(input,data.envelope,{mode:0o600});await writeFile(privateKeyFile,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
 return {directory,input,privateKeyFile,destination,...data,cleanup:()=>rm(temporary,{recursive:true,force:true})};
}

test('restore writes exactly the authenticated five files with private permissions and preserves original bytes',async()=>{
 const data=await fileFixture();
 try{
  const result=await restoreBackup(data);assert.equal(result.status,'ok');assert.equal(result.restored_files,5);assert.equal(result.output_directory,data.destination);
  assert.equal((await stat(data.destination)).mode&0o777,0o700);assert.deepEqual((await readdir(data.destination)).sort(),Object.keys(data.entries).sort());
  for(const [name,bytes]of Object.entries(data.entries)){const filename=path.join(data.destination,name);assert.deepEqual(await readFile(filename),bytes);assert.equal((await stat(filename)).mode&0o777,0o600);}
  const recoveredEntries=Object.fromEntries(await Promise.all(Object.keys(data.entries).map(async name=>[name,await readFile(path.join(data.destination,name))])));
  assert.equal(validateBackupEntries(recoveredEntries),digest(data.entries.SHA256SUMS));assert.equal(JSON.stringify(result).includes('PRIVATE_KEY_MUST_NOT_APPEAR_IN_SUMMARY'),false);
  await assert.rejects(restoreBackup(data),{code:'RESTORE_DESTINATION_EXISTS'});
  assert.deepEqual(await readFile(path.join(data.destination,'private-config.tar.gz')),data.entries['private-config.tar.gz']);
 }finally{await data.cleanup();}
});

test('tampered backup never creates a restore directory or plaintext files',async()=>{
 const data=await fileFixture();
 try{
  const corrupted=Buffer.from(data.envelope);corrupted[corrupted.length-1]^=1;await writeFile(data.input,corrupted);
  const before=(await readdir(data.directory)).sort();await assert.rejects(restoreBackup(data),{code:'ENVELOPE_VERIFY_FAILED'});
  assert.deepEqual((await readdir(data.directory)).sort(),before);await assert.rejects(stat(data.destination),{code:'ENOENT'});
 }finally{await data.cleanup();}
});

test('restore rejects existing destinations, symlink parents, relative and traversing paths without touching them',async()=>{
 const data=await fileFixture();
 try{
  await mkdir(data.destination,{mode:0o700});await writeFile(path.join(data.destination,'sentinel'),'keep this');
  await assert.rejects(restoreBackup(data),{code:'RESTORE_DESTINATION_EXISTS'});assert.equal(await readFile(path.join(data.destination,'sentinel'),'utf8'),'keep this');
  const alias=path.join(data.directory,'alias');await symlink(data.destination,alias);
  await assert.rejects(restoreBackup({...data,destination:path.join(alias,'new')}),{code:'UNSAFE_RESTORE_PATH'});
  await assert.rejects(restoreBackup({...data,destination:alias}),{code:'RESTORE_DESTINATION_EXISTS'});
  for(const destination of ['relative',data.directory+'/../escaped','/opt/oasis/current/plaintext-backup'])await assert.rejects(restoreBackup({...data,destination}));
  assert.equal(await readFile(path.join(data.destination,'sentinel'),'utf8'),'keep this');
 }finally{await data.cleanup();}
});

test('partial restore write failure cleans only its newly created directory',async()=>{
 const data=await fileFixture();let writes=0;
 try{
  const sentinel=path.join(data.directory,'unrelated');await mkdir(sentinel);await writeFile(path.join(sentinel,'keep'),'keep');
  await assert.rejects(restoreBackup(data,{writeFile:async(filename,bytes)=>{
   if(++writes===2)throw new Error('injected disk failure');await writeFile(filename,bytes,{mode:0o600,flag:'wx'});
  }}),/injected disk failure/);
  await assert.rejects(stat(data.destination),{code:'ENOENT'});assert.equal(await readFile(path.join(sentinel,'keep'),'utf8'),'keep');assert.equal(writes,2);
 }finally{await data.cleanup();}
});

test('real tar excludes only private/offsite envelopes while preserving private runtime keys and configuration',async()=>{
 const temporary=await mkdtemp(path.join(tmpdir(),'oasis-offsite-exclusion-'));
 try{
  const root=await realpath(temporary),privateDir=path.join(root,'private'),archive=path.join(root,'private-config.tar.gz');
  await mkdir(path.join(privateDir,'state'),{recursive:true,mode:0o700});await mkdir(path.join(privateDir,'offsite'));await mkdir(path.join(privateDir,'offsite-other'));
  await writeFile(path.join(privateDir,'runtime.env'),'TEST_ENV=retained');await writeFile(path.join(privateDir,'state','master.key'),Buffer.alloc(32,7));
  await writeFile(path.join(privateDir,'offsite','prior.oasis-backup'),'excluded prior archive');await writeFile(path.join(privateDir,'offsite-other','keep'),'retained sibling');
  const script=await readFile(new URL('../deploy/backup.sh',import.meta.url),'utf8'),tarLine=script.split('\n').find(line=>line.startsWith('tar '));
  assert.ok(tarLine?.includes('--exclude=private/offsite'));
  // Run the actual backup script's tar line with only its source/output roots replaced.
  const substitute=tarLine.replace('"$destination/private-config.tar.gz"','"$OASIS_TEST_ARCHIVE"').replace('-C /opt/oasis','-C "$OASIS_TEST_SOURCE"');
  await exec('sh',['-c',substitute],{env:{...process.env,OASIS_TEST_ARCHIVE:archive,OASIS_TEST_SOURCE:root}});
  const list=(await exec('tar',['-tzf',archive])).stdout.split('\n').filter(Boolean);
  assert.ok(list.includes('private/runtime.env'));assert.ok(list.includes('private/state/master.key'));assert.ok(list.includes('private/offsite-other/keep'));
  assert.equal(list.some(name=>name==='private/offsite/'||name.startsWith('private/offsite/')),false);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
