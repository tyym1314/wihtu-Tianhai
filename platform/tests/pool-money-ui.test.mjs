import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';

let dir,render;
before(async()=>{
 dir=await mkdtemp(resolve(tmpdir(),'oasis-pool-money-ui-'));
 const outfile=resolve(dir,'render.cjs');
 await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import PoolGame from './arena/pool/PoolGame.jsx';
 import {createState,view} from './arena/pool/engine.mjs';
 function freeze(o){if(o&&typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o);}return o;}
 export function render(practice=false,entry='10000',prize='19000',locale='zh'){
  const now=Date.now(),players=[{key:'ui_a',seatIndex:0,name:'A'},{key:'ui_b',seatIndex:1,name:'B'}];
  const state=createState('12'.repeat(32),now,{players});
  const room=freeze({id:'money_display_fixture',status:'active',game_id:'pool',practice,capacity:2,entry_minor:entry,prize_minor:prize,fee_bps:500,result:{fee_minor:'1000'},server_now:now,players:players.map(p=>({external_user_id:p.key,name:p.name})),game:view(state,'ui_a')});
  const before=JSON.stringify(room);let commands=0;
  const html=renderToStaticMarkup(React.createElement(PoolGame,{room,me:'ui_a',locale,onAction:()=>{commands++;throw Error('Unexpected action');},audio:{enabled:false},onExit:()=>{}}));
  return {html,unchanged:JSON.stringify(room)===before,commands,entry_minor:room.entry_minor,prize_minor:room.prize_minor,fee_minor:room.result.fee_minor,fee_bps:room.fee_bps};
 }`,resolveDir:resolve(import.meta.dirname,'..'),loader:'jsx'},bundle:true,platform:'node',format:'cjs',outfile,loader:{'.css':'empty'},plugins:[{name:'ssr-local-asset-urls',setup(b){b.onLoad({filter:/\.(mjs|jsx)$/},async({path})=>{const contents=(await readFile(path,'utf8')).replace(/new URL\('([^']+)',import\.meta\.url\)\.href/g,(_,asset)=>JSON.stringify(new URL(asset,pathToFileURL(path)).href));return{contents,loader:path.endsWith('.jsx')?'jsx':'js'};});}}],logLevel:'silent'});
 render=createRequire(import.meta.url)(outfile).render;
});
after(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
for(const locale of ['zh','en'])test(`Pool ${locale} renders 10000 minor as 100 and 19000 as 190 without changing frozen server amounts`,()=>{
 const r=render(false,'10000','19000',locale);
 assert.match(r.html,/<div class="op-prize">[\s\S]*?<strong>190<\/strong>/);
 assert.match(r.html,new RegExp(`${locale==='zh'?'入场':'ENTRY'} <b>100<\\/b>`));
 assert.doesNotMatch(r.html,/19,000|10,000/);
 assert.deepEqual({...r,html:undefined},{html:undefined,unchanged:true,commands:0,entry_minor:'10000',prize_minor:'19000',fee_minor:'1000',fee_bps:500});
});
test('Pool retains fractional coins while free practice continues to display FREE',()=>{
 const paid=render(false,'10050','19095');assert.match(paid.html,/<strong>190\.95<\/strong>/);assert.match(paid.html,/入场 <b>100\.5<\/b>/);assert.ok(paid.unchanged);
 const free=render(true);assert.match(free.html,/<small>PRACTICE<\/small><strong>FREE<\/strong>/);assert.match(free.html,/入场 <b>FREE<\/b>/);assert.ok(free.unchanged);assert.equal(free.commands,0);
});
