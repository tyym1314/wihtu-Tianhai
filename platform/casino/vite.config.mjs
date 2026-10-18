import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';

// One content hash over casino/public: images and audio are requested as ?v=<hash> and cached
// immutably; any changed asset changes the hash, so a release never serves stale art.
const root=fileURLToPath(new URL('.',import.meta.url)),publicDir=join(root,'public');
function assetVersion(){
 const files=[];const walk=d=>{for(const e of readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(d,e.name);e.isDirectory()?walk(p):files.push(p);}};walk(publicDir);
 const h=createHash('sha256');for(const f of files){h.update(relative(publicDir,f));h.update(readFileSync(f));}return h.digest('hex').slice(0,16);
}
const version=assetVersion();
const writeVersion={name:'asset-version',closeBundle(){writeFileSync(join(root,'dist','asset-version.txt'),version);}};
export default defineConfig({root,base:'/casino/',cacheDir:'../node_modules/.vite-casino',plugins:[react(),writeVersion],define:{__ASSET_VERSION__:JSON.stringify(version)},build:{outDir:'dist',emptyOutDir:true,chunkSizeWarningLimit:600}});
