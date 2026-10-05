import {build} from '../../../node_modules/esbuild/lib/main.js';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'oasis-carrom-money-')),out=join(dir,'render.cjs');
try{
 await build({stdin:{contents:`
  import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
  import CarromGame from './arena/carrom/CarromGame.jsx';import {createState,view} from './arena/carrom/engine.mjs';
  const now=Date.now(),players=Array.from({length:4},(_,i)=>({key:'p'+i,seatIndex:i,teamId:i%2?'team_b':'team_a',name:'PLAYER '+i}));
  const s=createState('12'.repeat(32),now,{players}),room={status:'active',practice:false,entry_minor:'10000',prize_minor:'38000',server_now:now,game:view(s,'p0')};
  const before=JSON.stringify(room);export const html=renderToStaticMarkup(<CarromGame room={room} me="p0" locale="zh"/>);export const unchanged=JSON.stringify(room)===before;
 `,resolveDir:resolve(import.meta.dirname,'../../..'),loader:'jsx'},outfile:out,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},plugins:[{name:'ssr-local-asset-urls',setup(b){b.onLoad({filter:/\.(mjs|jsx)$/},async({path})=>{const contents=(await readFile(path,'utf8')).replace(/new URL\('([^']+)',import\.meta\.url\)\.href/g,(_,asset)=>JSON.stringify(new URL(asset,pathToFileURL(path)).href));return{contents,loader:path.endsWith('.jsx')?'jsx':'js'};});}}],logLevel:'silent'});
 const r=createRequire(import.meta.url)(out);assert.match(r.html,/<b>380<\/b>/);assert.match(r.html,/ENTRY <b>100<\/b>/);assert.doesNotMatch(r.html,/38,000|10,000/);assert(r.unchanged);console.log('PASS Carrom UI 38000→380 / 10000→100; room unchanged');
}finally{await rm(dir,{recursive:true,force:true});}
