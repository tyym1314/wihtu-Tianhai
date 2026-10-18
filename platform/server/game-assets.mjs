import {open} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {ALL_GAME_IDS,ARENA_IDS,CASINO_IDS} from '../shared/games.mjs';

const defaultLegacyRoot=fileURLToPath(new URL('../legacy/dist/',import.meta.url));
const defaultArenaRoot=fileURLToPath(new URL('../arena/dist/',import.meta.url));
const defaultCasinoRoot=fileURLToPath(new URL('../casino/dist/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.wasm':'application/wasm','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.mp3':'audio/mpeg','.ogg':'audio/ogg','.woff2':'font/woff2'};
function fail(status,code,message=code){throw Object.assign(new Error(message),{status,code});}
function fresh(headers,etag,mtimeMs){
  // If-None-Match takes precedence even when its value does not match.
  if(headers['if-none-match']!==undefined)return headers['if-none-match'].split(',').some(tag=>tag.trim()==='*'||tag.trim().replace(/^W\//,'')===etag.replace(/^W\//,''));
  const since=Date.parse(headers['if-modified-since']);
  return Number.isFinite(since)&&Math.floor(mtimeMs/1000)*1000<=since;
}

// Written by the casino build (casino/vite.config.mjs); re-read when the release directory changes.
const versionCache=new Map();
function casinoAssetVersion(casinoRoot){
 const hit=versionCache.get(casinoRoot);if(hit&&Date.now()-hit.at<10000)return hit.value;
 let value=null;try{value=readFileSync(resolve(casinoRoot,'asset-version.txt'),'utf8').trim();if(!/^[a-f0-9]{16}$/.test(value))value=null;}catch{}
 versionCache.set(casinoRoot,{at:Date.now(),value});return value;
}
export async function serveGameAsset(req,res,path,{legacyRoot=defaultLegacyRoot,arenaRoot=defaultArenaRoot,casinoRoot=defaultCasinoRoot}={}){
  // Callers pass req.url; the query (e.g. the ?v= content version) is not part of the file path.
  path=path.split('?')[0];
  const candidate=path.match(/^\/play\/([a-z0-9]+)$/)?.[1],game=ALL_GAME_IDS.includes(candidate)?candidate:null;
  const casino=path.startsWith('/casino/')||CASINO_IDS.includes(game),arena=casino||path.startsWith('/arena/')||ARENA_IDS.includes(game);
  const base=casino?casinoRoot:arena?arenaRoot:legacyRoot,prefix=casino?'/casino':'/arena';
  if(req.method!=='GET'&&req.method!=='HEAD')fail(405,'METHOD_NOT_ALLOWED');
  const target=game?resolve(base,arena?'index.html':game+'.html'):resolve(base,'.'+path.slice(arena?prefix.length:'/legacy'.length));
  if(!target.startsWith(resolve(base)+sep))fail(404,'NOT_FOUND');
  if(path.includes('..')||path.includes('%')||path.includes('\\'))fail(400,'INVALID_PATH');
  // An open descriptor pins the same file for its validators and streamed body,
  // including while an atomic release changes the current-directory symlink.
  let file,info;
  try{file=await open(target,'r');info=await file.stat({bigint:true});if(!info.isFile())throw new Error('NOT_FILE');}
  catch{await file?.close();fail(404,'GAME_BUILD_REQUIRED','先运行 npm run build:legacy 和 npm run build:arena');}
  try{
    const extension=extname(target),html=extension==='.html';
    // Vite uses eight-character hashes. The verified mobile asset manifest
    // uses an explicit -mobile-<10 hex SHA256> suffix, including subdirectories.
    // Other copied images still revalidate; a version-looking name is not a hash.
    const hashed=!html&&(/\/(?:assets|bundles)\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(path)||/\/(?:arena|legacy|casino)\/assets\/(?:[^/]+\/)*[^/]+-mobile-[a-f0-9]{10}\.webp$/.test(path));
    // Casino art/audio requested with the current build's content version (?v=) is immutable.
    const version=casino&&!html?casinoAssetVersion(casinoRoot):null,versioned=version!==null&&new URL(req.url,'http://x').searchParams.get('v')===version;
    const headers={'content-type':types[extension]||'application/octet-stream','cache-control':html?'no-store':hashed||versioned?'public,max-age=31536000,immutable':'public,max-age=0,must-revalidate','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
    if(!html){
      // Weak metadata validators avoid hashing/reading a model for every poll.
      // ctime also invalidates a same-size rewrite with a restored mtime.
      headers.etag=`W/"${info.size.toString(16)}-${info.mtimeNs.toString(16)}-${info.ctimeNs.toString(16)}"`;
      headers['last-modified']=new Date(Number(info.mtimeMs)).toUTCString();
      if(fresh(req.headers,headers.etag,Number(info.mtimeMs))){res.writeHead(304,headers);res.end();return;}
    }
    headers['content-length']=info.size.toString();res.writeHead(200,headers);
    if(req.method==='HEAD'){res.end();return;}
    await pipeline(file.createReadStream({autoClose:false}),res);
  }finally{await file.close();}
}
