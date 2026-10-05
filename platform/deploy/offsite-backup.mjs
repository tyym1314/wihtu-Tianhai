/** One-shot encrypted backup export/verification. No SSH, network, extraction or scheduling. */
import {constants as FS} from 'node:fs';
import {chmod,lstat,mkdir,open,realpath,link,unlink,rm} from 'node:fs/promises';
import {constants as CRYPTO,createHash,createCipheriv,createDecipheriv,createPublicKey,createPrivateKey,publicEncrypt,privateDecrypt,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const MAX_ARCHIVE_BYTES=64*1024*1024;
const MAX_HEADER_BYTES=8192,MAGIC=Buffer.from('OASISBKP1\n'),TAG_BYTES=16;
const FILES=['SHA256SUMS','database.dump','private-config.tar.gz','release.txt','database-contents.txt'];
const HASHED=['database.dump','private-config.tar.gz','release.txt'];
const fileLimit=name=>({'SHA256SUMS':8192,'release.txt':4096,'database-contents.txt':1048576}[name]||MAX_ARCHIVE_BYTES);
const STAMP=/^\d{8}T\d{6}Z$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function validateExportPaths(backup,output){
 if(typeof backup!=='string'||!/^\/opt\/oasis\/backups\/\d{8}T\d{6}Z$/.test(backup)||path.normalize(backup)!==backup)fail('UNSAFE_BACKUP_PATH');
 if(typeof output!=='string'||path.dirname(output)!=='/opt/oasis/private/offsite'||path.basename(output)!==`oasis-backup-${path.basename(backup)}.oasis-backup`||path.normalize(output)!==output)fail('UNSAFE_OUTPUT_PATH');
 return {backup,output};
}
function validateAbsolute(filename){if(typeof filename!=='string'||!path.isAbsolute(filename)||path.normalize(filename)!==filename||filename.includes('\0'))fail('UNSAFE_FILE_PATH');}
export async function readBounded(filename,limit){
 validateAbsolute(filename);
 const handle=await open(filename,FS.O_RDONLY|FS.O_NOFOLLOW);
 try{
  const info=await handle.stat();if(!info.isFile()||info.size<=0||info.size>limit)fail('FILE_SIZE_OR_TYPE_REJECTED');
  const bytes=Buffer.alloc(info.size);let offset=0;
  while(offset<bytes.length){const chunk=await handle.read(bytes,offset,bytes.length-offset,offset);if(!chunk.bytesRead)fail('FILE_CHANGED_DURING_READ');offset+=chunk.bytesRead;}
  if((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead)fail('FILE_CHANGED_DURING_READ');
  return bytes;
 }finally{await handle.close();}
}
export function parseManifest(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>8192)fail('BACKUP_MANIFEST_INVALID');
 const result={};
 for(const line of bytes.toString('utf8').trim().split('\n')){
  const match=/^([a-f0-9]{64}) [ *]([a-zA-Z0-9.-]+)$/.exec(line);
  if(!match||!HASHED.includes(match[2])||result[match[2]])fail('BACKUP_MANIFEST_INVALID');result[match[2]]=match[1];
 }
 if(Object.keys(result).length!==HASHED.length)fail('BACKUP_MANIFEST_INVALID');return result;
}
export function validateBackupEntries(entries){
 if(Object.keys(entries).length!==FILES.length||!FILES.every(name=>Buffer.isBuffer(entries[name])&&entries[name].length>0&&entries[name].length<=fileLimit(name)))fail('BACKUP_INCOMPLETE');
 if(FILES.reduce((sum,name)=>sum+entries[name].length,0)>MAX_ARCHIVE_BYTES)fail('BACKUP_TOO_LARGE');
 const expected=parseManifest(entries.SHA256SUMS);
 for(const name of HASHED)if(sha(entries[name])!==expected[name])fail('BACKUP_CHECKSUM_MISMATCH');
 return sha(entries.SHA256SUMS);
}
export async function readBackup(backup){
 if(await realpath(backup)!==backup)fail('UNSAFE_BACKUP_PATH');
 const info=await lstat(backup);if(!info.isDirectory()||(info.mode&0o022))fail('UNSAFE_BACKUP_PATH');
 const entries={};let total=0;
 try{
  for(const name of FILES){entries[name]=await readBounded(path.join(backup,name),Math.min(fileLimit(name),MAX_ARCHIVE_BYTES-total));total+=entries[name].length;}
  validateBackupEntries(entries);return entries;
 }catch(error){for(const bytes of Object.values(entries))bytes.fill(0);throw error;}
}

function tarField(header,offset,length,value){const bytes=Buffer.from(value);if(bytes.length>=length)fail('TAR_FIELD_INVALID');bytes.copy(header,offset);}
function tarOctal(header,offset,length,value){tarField(header,offset,length,value.toString(8).padStart(length-1,'0'));}
export function buildArchive(entries){
 validateBackupEntries(entries);
 const size=FILES.reduce((total,name)=>total+512+Math.ceil(entries[name].length/512)*512,1024);
 if(size>MAX_ARCHIVE_BYTES)fail('BACKUP_TOO_LARGE');
 const archive=Buffer.alloc(size);let offset=0;
 for(const name of FILES){
  const data=entries[name],header=archive.subarray(offset,offset+512);tarField(header,0,100,'backup/'+name);
  tarOctal(header,100,8,0o600);tarOctal(header,108,8,0);tarOctal(header,116,8,0);tarOctal(header,124,12,data.length);tarOctal(header,136,12,0);
  header.fill(32,148,156);header[156]=48;Buffer.from('ustar\0').copy(header,257);Buffer.from('00').copy(header,263);
  const checksum=header.reduce((sum,byte)=>sum+byte,0);Buffer.from(checksum.toString(8).padStart(6,'0')+'\0 ').copy(header,148);
  data.copy(archive,offset+512);offset+=512+Math.ceil(data.length/512)*512;
 }
 return archive;
}
function archiveContents(archive){
 if(!Buffer.isBuffer(archive)||archive.length>MAX_ARCHIVE_BYTES||archive.length<1024||archive.length%512)fail('ARCHIVE_INVALID');
 const entries={};let offset=0;
 while(offset+512<=archive.length){
  const header=archive.subarray(offset,offset+512);
  if(header.every(byte=>byte===0))break;
  const text=(start,length)=>header.subarray(start,start+length).toString('ascii').replace(/\0.*$/s,'');
  const name=text(0,100),sizeText=text(124,12),sumText=text(148,8).trim();
  const file=name.startsWith('backup/')?name.slice(7):'';
  if(!FILES.includes(file)||entries[file]||header[156]!==48||text(257,6)!=='ustar'||text(345,155)!==''||!/^0*[0-7]+$/.test(sizeText)||!/^0*[0-7]+$/.test(sumText))fail('ARCHIVE_INVALID');
  const checksum=header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0);
  if(checksum!==parseInt(sumText,8))fail('ARCHIVE_INVALID');
  const size=parseInt(sizeText,8),padded=Math.ceil(size/512)*512;
  if(size<=0||!Number.isSafeInteger(size)||offset+512+padded>archive.length)fail('ARCHIVE_INVALID');
  entries[file]=archive.subarray(offset+512,offset+512+size);
  if(!archive.subarray(offset+512+size,offset+512+padded).every(byte=>byte===0))fail('ARCHIVE_INVALID');
  offset+=512+padded;
 }
 if(archive.length-offset<1024||!archive.subarray(offset).every(byte=>byte===0))fail('ARCHIVE_INVALID');
 return {manifestSha256:validateBackupEntries(entries),fileCount:Object.keys(entries).length,entries};
}
export function inspectArchive(archive){const {entries,...summary}=archiveContents(archive);return summary;}

function rsaKey(key){if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048||key.asymmetricKeyDetails.modulusLength>8192)fail('RSA_KEY_REJECTED');return key;}
const fingerprint=key=>sha(createPublicKey(key.type==='public'?key.export({format:'pem',type:'spki'}):key).export({format:'der',type:'spki'}));
export function encryptArchive(archive,publicKey,{sourceStamp,createdAt=new Date().toISOString()}={}){
 if(!STAMP.test(sourceStamp||''))fail('SOURCE_STAMP_INVALID');rsaKey(publicKey);
 const inspected=inspectArchive(archive),key=randomBytes(32),iv=randomBytes(12);
 try{
  const wrapped=publicEncrypt({key:publicKey,padding:CRYPTO.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
  const header={version:1,cipher:'AES-256-GCM',key_wrap:'RSA-OAEP-SHA256',source_stamp:sourceStamp,created_at:createdAt,
   manifest_sha256:inspected.manifestSha256,archive_sha256:sha(archive),archive_bytes:archive.length,recipient_sha256:fingerprint(publicKey),wrapped_key:wrapped.toString('base64'),iv:iv.toString('base64')};
  const rawHeader=Buffer.from(JSON.stringify(header));if(rawHeader.length>MAX_HEADER_BYTES)fail('HEADER_TOO_LARGE');
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(rawHeader);
  const encrypted=Buffer.concat([cipher.update(archive),cipher.final()]),length=Buffer.alloc(4);length.writeUInt32BE(rawHeader.length);
  return Buffer.concat([MAGIC,length,rawHeader,encrypted,cipher.getAuthTag()]);
 }finally{key.fill(0);}
}
const summary=(header,envelope)=>({status:'ok',version:1,source_stamp:header.source_stamp,created_at:header.created_at,manifest_sha256:header.manifest_sha256,
 archive_sha256:header.archive_sha256,archive_bytes:header.archive_bytes,recipient_sha256:header.recipient_sha256,envelope_sha256:sha(envelope),encrypted_bytes:envelope.length});
function splitEnvelope(envelope){
 if(!Buffer.isBuffer(envelope)||envelope.length>MAX_ARCHIVE_BYTES+MAX_HEADER_BYTES+MAGIC.length+4+TAG_BYTES||envelope.length<MAGIC.length+4+TAG_BYTES||!envelope.subarray(0,MAGIC.length).equals(MAGIC))fail('ENVELOPE_VERIFY_FAILED');
 const length=envelope.readUInt32BE(MAGIC.length),start=MAGIC.length+4,end=start+length;
 if(length>MAX_HEADER_BYTES||length<2||end+TAG_BYTES>=envelope.length)fail('ENVELOPE_VERIFY_FAILED');
 const raw=envelope.subarray(start,end),header=JSON.parse(raw.toString('utf8'));
 return {header,raw,encrypted:envelope.subarray(end,-TAG_BYTES),tag:envelope.subarray(-TAG_BYTES)};
}
function authenticateEnvelope(envelope,privateKey){
 let key,archive,partial,authenticated=false;
 try{
  rsaKey(privateKey);const {header,raw,encrypted,tag}=splitEnvelope(envelope);
  const expected=['version','cipher','key_wrap','source_stamp','created_at','manifest_sha256','archive_sha256','archive_bytes','recipient_sha256','wrapped_key','iv'];
  if(Object.keys(header).length!==expected.length||!expected.every(name=>Object.hasOwn(header,name))||header.version!==1||header.cipher!=='AES-256-GCM'||header.key_wrap!=='RSA-OAEP-SHA256'||!STAMP.test(header.source_stamp)||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(header.created_at)||!Number.isFinite(Date.parse(header.created_at))||
    !['manifest_sha256','archive_sha256','recipient_sha256'].every(name=>typeof header[name]==='string'&&/^[a-f0-9]{64}$/.test(header[name]))||
    !Number.isSafeInteger(header.archive_bytes)||header.archive_bytes!==encrypted.length||header.archive_bytes>MAX_ARCHIVE_BYTES||header.recipient_sha256!==fingerprint(privateKey))fail('ENVELOPE_VERIFY_FAILED');
  if(typeof header.wrapped_key!=='string'||typeof header.iv!=='string')fail('ENVELOPE_VERIFY_FAILED');
  const wrapped=Buffer.from(header.wrapped_key,'base64'),iv=Buffer.from(header.iv,'base64');
  if(wrapped.toString('base64')!==header.wrapped_key||iv.toString('base64')!==header.iv||iv.length!==12||wrapped.length!==privateKey.asymmetricKeyDetails.modulusLength/8)fail('ENVELOPE_VERIFY_FAILED');
  key=privateDecrypt({key:privateKey,padding:CRYPTO.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped);if(key.length!==32)fail('ENVELOPE_VERIFY_FAILED');
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(raw);decipher.setAuthTag(tag);partial=decipher.update(encrypted);archive=Buffer.concat([partial,decipher.final()]);partial.fill(0);partial=null;
  if(sha(archive)!==header.archive_sha256)fail('ENVELOPE_VERIFY_FAILED');
  const inspected=archiveContents(archive);if(inspected.manifestSha256!==header.manifest_sha256)fail('ENVELOPE_VERIFY_FAILED');
  authenticated=true;return {archive,entries:inspected.entries,report:{...summary(header,envelope),verified_files:inspected.fileCount}};
 }catch{fail('ENVELOPE_VERIFY_FAILED');}finally{key?.fill(0);if(!authenticated)archive?.fill(0);partial?.fill(0);}
}
export function verifyEnvelope(envelope,privateKey){
 const authenticated=authenticateEnvelope(envelope,privateKey);
 try{return authenticated.report;}finally{authenticated.archive.fill(0);}
}

export async function writeExclusive(output,envelope){
 validateAbsolute(output);if(!/^oasis-backup-\d{8}T\d{6}Z\.oasis-backup$/.test(path.basename(output)))fail('UNSAFE_OUTPUT_PATH');
 const directory=path.dirname(output);await mkdir(directory,{recursive:true,mode:0o700});
 if(await realpath(directory)!==directory)fail('UNSAFE_OUTPUT_PATH');
 const info=await lstat(directory);if(!info.isDirectory()||(info.mode&0o022))fail('UNSAFE_OUTPUT_PATH');
 const temporary=output+'.'+randomBytes(8).toString('hex')+'.tmp';let handle;
 try{
  handle=await open(temporary,'wx',0o600);await handle.chmod(0o600);await handle.writeFile(envelope);await handle.sync();await handle.close();handle=null;
  try{await link(temporary,output);}catch(error){if(error.code==='EEXIST')fail('OUTPUT_EXISTS');throw error;}
  const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
 }finally{if(handle)await handle.close();await unlink(temporary).catch(()=>{});}
}
export async function exportBackup({backup,publicKeyFile,output}){
 validateExportPaths(backup,output);
 const publicPem=await readBounded(publicKeyFile,65536);
 if(!/^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(publicPem.toString('ascii')))fail('PUBLIC_PEM_REQUIRED');
 const key=rsaKey(createPublicKey(publicPem)),entries=await readBackup(backup);let archive;
 try{
  archive=buildArchive(entries);const envelope=encryptArchive(archive,key,{sourceStamp:path.basename(backup)});
  await writeExclusive(output,envelope);return {...summary(splitEnvelope(envelope).header,envelope),verified_files:FILES.length};
 }finally{archive?.fill(0);for(const bytes of Object.values(entries))bytes.fill(0);}
}
export async function verifyBackup({input,privateKeyFile}){
 const envelope=await readBounded(input,MAX_ARCHIVE_BYTES+MAX_HEADER_BYTES+MAGIC.length+4+TAG_BYTES),privatePem=await readBounded(privateKeyFile,65536);
 try{return verifyEnvelope(envelope,rsaKey(createPrivateKey(privatePem)));}finally{privatePem.fill(0);}
}

async function writeRestoredFile(filename,bytes){
 const handle=await open(filename,'wx',0o600);
 try{await handle.chmod(0o600);await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
export async function restoreBackup({input,privateKeyFile,destination},{writeFile=writeRestoredFile}={}){
 validateAbsolute(destination);
 if(destination==='/'||destination==='/opt/oasis/current'||destination.startsWith('/opt/oasis/current/')||destination==='/opt/oasis/releases'||destination.startsWith('/opt/oasis/releases/'))fail('UNSAFE_RESTORE_PATH');
 const parent=path.dirname(destination);
 if(await realpath(parent)!==parent||!(await lstat(parent)).isDirectory())fail('UNSAFE_RESTORE_PATH');
 try{await lstat(destination);fail('RESTORE_DESTINATION_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
 const envelope=await readBounded(input,MAX_ARCHIVE_BYTES+MAX_HEADER_BYTES+MAGIC.length+4+TAG_BYTES),privatePem=await readBounded(privateKeyFile,65536);
 let authenticated,created=false,identity,complete=false;
 try{
  // No directory or plaintext file is created before GCM, tar and every checksum pass.
  authenticated=authenticateEnvelope(envelope,rsaKey(createPrivateKey(privatePem)));
  try{await mkdir(destination,{mode:0o700});created=true;}catch(error){if(error.code==='EEXIST')fail('RESTORE_DESTINATION_EXISTS');throw error;}
  identity=await lstat(destination);await chmod(destination,0o700);
  for(const name of FILES)await writeFile(path.join(destination,name),authenticated.entries[name]);
  const directory=await open(destination,'r');try{await directory.sync();}finally{await directory.close();}
  complete=true;return {...authenticated.report,restored_files:FILES.length,output_directory:destination};
 }finally{
  privatePem.fill(0);authenticated?.archive.fill(0);
  if(created&&!complete){
   // Never recursively remove a directory substituted by another process.
   const current=await lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(current){if(!identity||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino)fail('RESTORE_CLEANUP_UNCONFIRMED');await rm(destination,{recursive:true,force:true});}
  }
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  process.umask(0o077);const [mode,...args]=process.argv.slice(2);let report;
  if(mode==='export'&&args.length===3)report=await exportBackup({backup:args[0],publicKeyFile:args[1],output:args[2]});
  else if(mode==='verify'&&args.length===2)report=await verifyBackup({input:args[0],privateKeyFile:args[1]});
  else if(mode==='restore'&&args.length===3)report=await restoreBackup({input:args[0],privateKeyFile:args[1],destination:args[2]});
  else fail('USAGE: export BACKUP PUBLIC_PEM OUTPUT | verify ENCRYPTED_FILE PRIVATE_PEM | restore ENCRYPTED_FILE PRIVATE_PEM NEW_PRIVATE_DIRECTORY');
  process.stdout.write(JSON.stringify(report)+'\n');
 }catch{process.stderr.write(JSON.stringify({status:'failed',code:'OFFSITE_BACKUP_FAILED'})+'\n');process.exitCode=1;}
}
