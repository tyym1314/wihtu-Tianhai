/** Explicit allowlist, fixed ZIP metadata, no credentials or runtime data. */
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve,relative,dirname,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const kitDownload='/downloads/oasis-partner-sandbox-kit.zip';
const publicOrigin='https://game.tianyahuyu.com';

export function rewriteKitLinks(name,text,files,downloads){
 return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(match,label,target)=>{
  if(/^(https?:|#)/.test(target))return match;
  const clean=target.split('#')[0],fragment=target.slice(clean.length);
  if(clean==='/sdk/oasis-h5.mjs'&&files.has('public/sdk/oasis-h5.mjs'))return '['+label+']('+posix.relative(posix.dirname(name),'public/sdk/oasis-h5.mjs')+fragment+')';
  if(clean.startsWith('/downloads/')){
   if(clean===kitDownload&&files.has('README.md'))return '['+label+']('+posix.relative(posix.dirname(name),'README.md')+fragment+')（本接入包）';
   const member='public'+clean;
   if(files.has(member))return '['+label+']('+posix.relative(posix.dirname(name),member)+fragment+')';
   if(/^\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clean)&&downloads.has(clean))return '['+label+']('+publicOrigin+clean+fragment+')（外部下载，不随包提供）';
   return label+'（未随包提供；请向平台部署方确认下载地址）';
  }
  const path=posix.normalize(posix.join(posix.dirname(name),clean));
  return files.has(path)?match:label+'（平台在线历史文档，不随包提供）';
 });
}

export async function buildPartnerKit({output=resolve(root,'.local/partner-kit/oasis-partner-sandbox-kit.zip')}={}){
const files=new Map();
const put=(name,value)=>files.set(name,Buffer.from(value));
const json=value=>JSON.stringify(value,null,2)+'\n';
const allowed=[
 'server/wallet/index.mjs','server/wallet/security.mjs','server/wallet/schema.sql',
 'examples/partner-wallet/server.mjs','examples/partner-wallet/config.example.json','examples/partner-wallet/README.md',
 'specs/examples/sdk-node.mjs','specs/examples/signature-vector.json',
 'specs/examples/partner-host/server.mjs','specs/examples/partner-host/README.md',
 'specs/examples/partner-host/public/index.html','specs/examples/partner-host/public/host.mjs','specs/examples/partner-host/public/host.css',
 'public/sdk/oasis-h5.mjs','specs/openapi.json','specs/wallet-protocol.md','specs/integration-guide.md','specs/phase-f-self-integration.md','specs/production-handoff.md','specs/rate-limits.md','specs/android-webview-integration.md','specs/towerlink-v2-integration.md',
];
for(const name of allowed)put(name,await readFile(resolve(root,name)));
const profiles=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {getProfile} from './server/math/index.ts';console.log(JSON.stringify(['thunder','tiger'].flatMap(game_id=>['98','99'].map(profile=>{const p=getProfile(game_id,profile);return {game_id,profile,math_version:p.version,math_config_hash:p.hash,max_payout_multiplier:String(p.maxMultiplier)};}))))"],{cwd:root,encoding:'utf8'}));
put('specs/math-profiles.json',json({status:'PUBLIC_SANDBOX_METADATA_NOT_PRODUCTION_CERTIFICATION',profiles}));
const lock=JSON.parse(await readFile(resolve(root,'package-lock.json'),'utf8'));
const dependencies=Object.fromEntries(['ajv','ajv-formats','jsonc-parser','pg'].map(name=>[name,lock.packages['node_modules/'+name].version]));
const pkg={name:'oasis-partner-sandbox-kit',version:'0.6.0',private:true,type:'module',engines:{node:'>=22'},scripts:{verify:'node verify-kit.mjs',host:'node specs/examples/partner-host/server.mjs',wallet:'node examples/partner-wallet/server.mjs'},dependencies};
put('package.json',json(pkg));
const packages={'':{name:pkg.name,version:pkg.version,dependencies,engines:pkg.engines}};
function include(name,from=''){
 let parent=from,candidate;
 while(true){const key=(parent?parent+'/':'')+'node_modules/'+name;if(lock.packages[key]){candidate=key;break;}if(!parent)throw Error('Unresolved locked package: '+name);const at=parent.lastIndexOf('/node_modules/');parent=at<0?'':parent.slice(0,at);}
 if(packages[candidate])return;const entry=structuredClone(lock.packages[candidate]);delete entry.dev;delete entry.devOptional;packages[candidate]=entry;
 for(const dep of Object.keys(entry.dependencies||{}))include(dep,candidate);
 for(const dep of Object.keys(entry.optionalDependencies||{})){try{include(dep,candidate);}catch{/* Platform-specific optional package absent from the source lock. */}}
 for(const dep of Object.keys(entry.peerDependencies||{})){try{include(dep,candidate);}catch(e){if(!entry.peerDependenciesMeta?.[dep]?.optional)throw e;}}
}
for(const name of Object.keys(dependencies))include(name);
put('package-lock.json',json({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:Object.fromEntries(Object.entries(packages).sort(([a],[b])=>a<b?-1:a>b?1:0))}));
put('config/partner-host.example.json',json({platform_base_url:'http://127.0.0.1:8795',host_origin:'http://127.0.0.1:8800',key_id:'REPLACE_PARTNER_TO_PLATFORM_KEY_ID',secret_base64:'REPLACE_PRIVATE_PLATFORM_SECRET',scope:{partner_id:'REPLACE_PARTNER_ID',app_id:'REPLACE_APP_ID',environment:'sandbox',wallet_scope_id:'REPLACE_WALLET_SCOPE_ID',currency_id:'COIN'},external_user_id:'demo_player'}));
put('.gitignore','.local/\nnode_modules/\n*.log\n');
put('README.md',`# OASIS 合作方沙箱接入包 · v0.6

这是可独立解压、安装和运行的合作方示例；不需要平台源代码。包括独立 PostgreSQL 参考钱包、Node BFF、移动 H5 宿主、Node/H5 SDK、公开协议和数学版本元数据。平台 API 与十三款游戏仍由平台部署方提供，本包不包含游戏源码或素材，也不包含平台账号、可用密钥、token 或任何运行账务。

## 1. 安装与离线结构验证

要求 Node.js 22+、npm，以及你单独准备的 PostgreSQL 数据库。在**本文件所在包根目录**执行：

\`\`\`sh
npm ci
npm run verify
\`\`\`

verify 校验文件摘要、模块导入、相对路径、OpenAPI、占位配置和公开 HMAC 测试向量。它不监听端口、不访问平台或数据库、不创建资金操作。package-lock 从平台依赖锁的四个必要依赖闭包生成；不附带 node_modules。构建清单见 MANIFEST.json。

## 2. 取得专用沙箱 App

先向平台部署方取得平台公共 URL 和独立合作方账号。在平台教程中创建专用 App、保存一次性显示的 partner-to-platform key/secret，**立即暂停新 App**，随后配置独立钱包；不要提前试玩或运行检查。完整顺序见 [Phase F 接入教程](specs/phase-f-self-integration.md)。平台服务启动、钱包出站 origin 允许列表属于部署方职责，不在这个示例包中启动平台。

## 3. 独立参考钱包

由你的数据库管理员创建专用沙箱库，名字与平台当前数据库不同。不要删除、覆盖或复用任何现有平台库。把连接参数替换为自己的本机 PostgreSQL；以下命令不会自动建库：

\`\`\`sh
mkdir -p .local/partner-wallet
chmod 700 .local .local/partner-wallet
cp examples/partner-wallet/config.example.json .local/partner-wallet/config.json
chmod 600 .local/partner-wallet/config.json
\`\`\`

在私有 config.json 填平台接入台复制的完整 scope、**独立的 platform-to-wallet** key/secret、测试用户。两个方向密钥不能复用。所有 REPLACE 值必须替换；数学版本只复制 [math-profiles.json](specs/math-profiles.json) 内每项的 game_id、math_version、math_config_hash、max_payout_multiplier，先请平台确认当前启用版本。四条对应 Thunder/Tiger 的 98/99 沙箱目标档位，不是生产认证。本包没有派彩计算源码。

\`\`\`sh
OASIS_PARTNER_WALLET_DATABASE_URL='postgres://REPLACE_DB_USER:REPLACE_DB_PASSWORD@127.0.0.1:5432/REPLACE_PARTNER_SANDBOX_DB' \\
OASIS_PARTNER_WALLET_CONFIG="$PWD/.local/partner-wallet/config.json" \\
npm run wallet
\`\`\`

钱包仅监听 127.0.0.1:8801。首次启动会在专用库建表并创建配置中的测试余额，重启不重置账务。请平台部署方将这个精确钱包 origin 加入允许列表，然后在暂停的新 App 里绑定钱包方向密钥并查询余额，确认后启用 App。查询会登记 nonce，钱包也可能释放已到期冻结；它不是发币接口。钱包配置、数据库和密钥自行私有保存，不放入 public/specs。

## 4. 独立 BFF 与 H5

把宿主 http://127.0.0.1:8800 登记到这个 App 的 allowed_origins。配置使用创建 App 时保存的 **partner-to-platform** 凭证：

\`\`\`sh
cp config/partner-host.example.json .local/partner-host.json
chmod 600 .local/partner-host.json
# 私下编辑配置，替换平台地址、scope、key_id、secret_base64。
npm run host -- --config "$PWD/.local/partner-host.json"
\`\`\`

访问 http://127.0.0.1:8800；菜单来自平台签名 API，游戏 iframe 由平台提供。不要用文件双击方式打开 index.html。配置必须是非符号链接的 0600 普通文件，固定用户 demo_player 必须已在当前 App 钱包开户。见 [BFF/H5 说明](specs/examples/partner-host/README.md)。这个单用户本机示例不是生产登录服务，不能原样公开；真实 App 必须用自己的后端登录身份映射用户。

## 5. 后续验收与边界

按平台教程运行八项真实检查，会使用两个专用测试用户各 100 测试币完成三消结算。不要在有正常用户资产或未决局的 App 运行。消息握手只传展示状态，余额与派彩以服务端原操作及钱包凭据为准。HMAC 向量的固定 test_secret 是公开测试值，绝不能用作运行凭证。

本包验证不等于真实合作方接入完成；原生 WebView、公网 TLS、实际送礼币账、生产身份与密钥托管、并发容量、容灾及发布仍需分别验收。OpenAPI 保留历史设计候选说明和 .invalid 占位 server；实际本地接口与限制以 Phase F 教程为准。
`);
put('verify-kit.mjs',`import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {migrateWallet,provisionWallet,createWalletServer} from './server/wallet/index.mjs';
import {startPartnerWallet} from './examples/partner-wallet/server.mjs';
import {createPartnerHost,loadConfig} from './specs/examples/partner-host/server.mjs';
import {signedHeaders,OasisClient} from './specs/examples/sdk-node.mjs';
import {OasisHost} from './public/sdk/oasis-h5.mjs';
const read=name=>readFile(new URL(name,import.meta.url),'utf8');
const manifest=JSON.parse(await read('MANIFEST.json'));
for(const entry of manifest.files){const content=await readFile(new URL(entry.path,import.meta.url));assert.equal(content.length,entry.bytes,entry.path);assert.equal(createHash('sha256').update(content).digest('hex'),entry.sha256,entry.path);}
for(const fn of [migrateWallet,provisionWallet,createWalletServer,startPartnerWallet,createPartnerHost,loadConfig,signedHeaders,OasisClient,OasisHost])assert.equal(typeof fn,'function');
const spec=JSON.parse(await read('specs/openapi.json'));assert.equal(spec.openapi,'3.1.0');
const vector=JSON.parse(await read('specs/examples/signature-vector.json'));
const signed=signedHeaders({keyId:vector.key_id,secretBase64:vector.test_secret_base64,direction:vector.direction,method:vector.method,path:vector.canonical_target,rawBody:vector.raw_body_utf8,requestId:vector.request_id,timestamp:vector.timestamp,nonce:vector.nonce});
assert.equal(signed['X-GP-Signature'],vector.signature_header);
const ajv=new Ajv({strict:false});addFormats(ajv);const schema=spec.paths[vector.canonical_target].post.requestBody.content['application/json'].schema;const validate=ajv.compile({...schema,components:spec.components});assert.ok(validate(JSON.parse(vector.raw_body_utf8)),ajv.errorsText(validate.errors));
for(const path of ['config/partner-host.example.json','examples/partner-wallet/config.example.json']){const c=JSON.parse(await read(path));assert.ok(c.secret_base64.startsWith('REPLACE'));assert.ok(c.key_id.startsWith('REPLACE'));assert.ok(c.scope.app_id.startsWith('REPLACE'));}
const profiles=JSON.parse(await read('specs/math-profiles.json'));assert.equal(profiles.profiles.length,4);for(const p of profiles.profiles)assert.match(p.math_config_hash,/^[a-f0-9]{64}$/);
console.log(JSON.stringify({verified_files:manifest.files.length,module_imports:9,public_hmac_vector:true,openapi_reservation_validation:true,placeholder_configs:true,math_profiles:4,network_requests:0,listening_ports:0,database_changes:0}));
`);
// The package's copied docs must not require unpublished repository paths or reports.
let walletReadme=files.get('examples/partner-wallet/README.md').toString().replace('在 `platform/` 下执行 `npm ci` 安装根依赖。','在解压包根目录执行 `npm ci` 安装依赖。').replaceAll('platform/.local/','.local/');
put('examples/partner-wallet/README.md',walletReadme);
let hostReadme=files.get('specs/examples/partner-host/README.md').toString().split('## 已执行的隔离验收')[0].replace('cd /Users/tyym/Documents/codes/game/platform','# 在解压包根目录执行');
hostReadme+='## 本包验证\n\n在解压包根目录运行 `npm run verify`，不监听端口或访问数据库。平台与实际浏览器的验收记录由平台提供，本包不包含运行报告或游戏素材。\n';
put('specs/examples/partner-host/README.md',hostReadme);
let phaseF=files.get('specs/phase-f-self-integration.md').toString();
phaseF=phaseF.replace(/```sh\nnpx tsx -e [\s\S]*?\n```/,'公开沙箱数学元数据已随包提供：[math-profiles.json](math-profiles.json)。使用前请平台部署方确认其与当前启用版本一致；本包不含平台数学计算源码。');
phaseF='> 离线示例包：命令路径从包根开始。平台 API/游戏由部署方提供；第 1 节平台开服命令只供部署方参考，本包只能启动钱包与 BFF。见 [包 README](../README.md)。\n\n'+phaseF;
put('specs/phase-f-self-integration.md',phaseF);
const downloads=new Set();
for(const entry of await readdir(resolve(root,'public/downloads'),{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
 if(entry.isFile()&&!(await lstat(resolve(root,'public/downloads',entry.name))).isSymbolicLink())downloads.add('/downloads/'+entry.name);
}
for(const [name,bytes]of files)if(name.endsWith('.md')){
 let text=bytes.toString().replaceAll('platform/specs/examples/signature-vector.json','specs/examples/signature-vector.json');
 put(name,rewriteKitLinks(name,text,files,downloads));
}
for(const name of ['specs/phase-f-self-integration.md','specs/production-handoff.md']){const content=files.get(name)?.toString()||'';if(content.length<1000||!/^# /m.test(content))throw Error('Integration tutorial missing: '+name);}
// No runtime paths are discovered recursively: only the explicit source allowlist above.
for(const [name,bytes]of files){if(/(^|\/)(\.local|review|node_modules|assets|previews)(\/|$)/.test(name)||/\.(png|jpe?g|webp|mp[34]|webm|mov)$/.test(name))throw Error('Forbidden archive path: '+name);if(bytes.toString().includes('/Users/tyym/'))throw Error('Local absolute path in archive: '+name);}
const entries=[...files].sort(([a],[b])=>a<b?-1:a>b?1:0);
put('MANIFEST.json',json({format:'oasis-partner-sandbox-kit-v1',scope:'Public source and placeholder configuration only; no services started during verification.',files:entries.map(([path,b])=>({path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}))}));
const table=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
const locals=[],central=[];let offset=0;
for(const [path,body]of [...files].sort(([a],[b])=>a<b?-1:a>b?1:0)){
 const name=Buffer.from('oasis-partner-sandbox-kit/'+path),crc=crc32(body),header=Buffer.alloc(30);
 header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(name.length,26);
 locals.push(header,name,body);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(33,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(body.length,20);c.writeUInt32LE(body.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE((0o100644<<16)>>>0,38);c.writeUInt32LE(offset,42);central.push(c,name);offset+=header.length+name.length+body.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...locals,directory,end]);await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,zip);
return {output:relative(root,resolve(output)),files:files.size,bytes:zip.length,sha256:createHash('sha256').update(zip).digest('hex'),fixed_zip_date:'1980-01-01',dependencies:Object.keys(dependencies),package_lock_entries:Object.keys(packages).length-1};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildPartnerKit()));
