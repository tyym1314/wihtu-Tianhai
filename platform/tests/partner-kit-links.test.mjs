import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,posix} from 'node:path';
import {buildPartnerKit,rewriteKitLinks} from '../scripts/build-partner-kit.mjs';

const root=resolve(import.meta.dirname,'..');
const apk='/downloads/oasis-android-smoke-1.2.0-debug.apk';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const markdownLinks=text=>[...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(match=>({label:match[1],target:match[2]}));

test('a real public APK outside the ZIP keeps an explicit external HTTPS download',()=>{
 const result=rewriteKitLinks('specs/android.md',`[历史 APK](${apk})`,new Map(),new Set([apk]));
 assert.equal(result,`[历史 APK](https://game.tianyahuyu.com${apk})（外部下载，不随包提供）`);
 assert.ok(!result.includes('已在下载包内'));
});

test('only an actual packaged download becomes a relative member link',()=>{
 const path='/downloads/guide.pdf',files=new Map([['public'+path,Buffer.from('guide')]]);
 assert.equal(rewriteKitLinks('specs/nested/guide.md',`[指南](${path}#example)`,files,new Set()),
  '[指南](../../public/downloads/guide.pdf#example)');
});

test('the kit download itself points to the unpacked README without claiming a nested ZIP',()=>{
 assert.equal(rewriteKitLinks('specs/phase-f.md','[接入包](/downloads/oasis-partner-sandbox-kit.zip)',
  new Map([['README.md',Buffer.from('read me')]]),new Set()),'[接入包](../README.md)（本接入包）');
 assert.equal(markdownLinks(rewriteKitLinks('specs/phase-f.md','[接入包](/downloads/oasis-partner-sandbox-kit.zip)',
  new Map(),new Set())).length,0,'missing README cannot become a fabricated member link');
});

test('unknown or aliased downloads never become invented public or in-package links',()=>{
 for(const path of ['/downloads/missing.apk','/downloads/../private.env','/downloads/%2e%2e/secret','/downloads//hidden.apk']){
  const result=rewriteKitLinks('specs/guide.md',`[下载](${path})`,new Map(),new Set());
  assert.equal(result,'下载（未随包提供；请向平台部署方确认下载地址）');
  assert.equal(markdownLinks(result).length,0);
 }
});

test('existing external and section links remain intact',()=>{
 const text='[官方](https://example.invalid/guide) [目标](#显式选择验收目标)';
 assert.equal(rewriteKitLinks('specs/android.md',text,new Map(),new Set()),text);
});

test('the Android document describes verification only and links to the actual source module',async()=>{
 const text=await readFile(join(root,'specs/android-webview-integration.md'),'utf8');
 assert.match(text,/仅用于验证游戏是否可上线/);
 assert.doesNotMatch(text,/\/downloads\//);
 for(const {target}of markdownLinks(text)){
  if(target.startsWith('#'))continue;
  const path=resolve(root,'specs',target),info=await lstat(path);
  assert.ok(info.isFile()&&!info.isSymbolicLink());
 }
});

// Read the actual central directory rather than importing the writer's entry map.
function zipEntries(bytes){
 const end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);
 const count=bytes.readUInt16LE(end+10),entries=new Map();
 let offset=bytes.readUInt32LE(end+16);
 assert.equal(offset+bytes.readUInt32LE(end+12),end);
 for(let i=0;i<count;i++){
  assert.equal(bytes.readUInt32LE(offset),0x02014b50);
  assert.equal(bytes.readUInt16LE(offset+10),0,'fixture ZIP uses stored members');
  const length=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28);
  const name=bytes.subarray(offset+46,offset+46+nameLength).toString();
  assert.match(name,/^oasis-partner-sandbox-kit\//);
  assert.ok(!name.split('/').some(part=>part==='..'));
  const local=bytes.readUInt32LE(offset+42);assert.equal(bytes.readUInt32LE(local),0x04034b50);
  const body=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
  assert.equal(bytes.readUInt32LE(local+22),length);
  assert.equal(bytes.subarray(local+30,local+30+bytes.readUInt16LE(local+26)).toString(),name);
  const key=name.slice('oasis-partner-sandbox-kit/'.length);assert.ok(!entries.has(key));
  entries.set(key,bytes.subarray(body,body+length));
  offset+=46+nameLength+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
 }
 assert.equal(offset,end);return entries;
}

test('the built ZIP has valid hashes and working local links without inventing APK membership',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'oasis-kit-links-'));
 try{
  const output=join(temporary,'kit.zip'),built=await buildPartnerKit({output}),raw=await readFile(output);
  assert.equal(sha(raw),built.sha256);
  const files=zipEntries(raw),manifest=JSON.parse(files.get('MANIFEST.json'));
  assert.equal(files.size,built.files);assert.equal(manifest.files.length+1,files.size);
  for(const entry of manifest.files){assert.equal(files.get(entry.path).length,entry.bytes,entry.path);assert.equal(sha(files.get(entry.path)),entry.sha256,entry.path);}
  assert.equal([...files.keys()].filter(name=>name.endsWith('.apk')).length,0);
  let externalApkLinks=0,localLinks=0;
  for(const [name,body]of files){
   if(!name.endsWith('.md'))continue;
   const text=body.toString();assert.ok(!text.includes('当前文件已在下载包内'),name);
   for(const {target}of markdownLinks(text)){
    if(target===`https://game.tianyahuyu.com${apk}`)externalApkLinks++;
    if(/^(https?:|#)/.test(target))continue;
    assert.ok(!target.startsWith('/'),`${name}: unresolved server-relative link ${target}`);
    const member=posix.normalize(posix.join(posix.dirname(name),target.split('#')[0]));
    assert.ok(files.has(member),`${name}: missing ${member}`);localLinks++;
   }
  }
  assert.equal(externalApkLinks,0);assert.ok(localLinks>5);
  const android=files.get('specs/android-webview-integration.md').toString();
  assert.match(android,/仅用于验证游戏是否可上线/);
  assert.doesNotMatch(android,/\/downloads\//);
  const phaseF=files.get('specs/phase-f-self-integration.md').toString();
  assert.doesNotMatch(phaseF,/\/downloads\/oasis-partner-sandbox-kit\.zip/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
