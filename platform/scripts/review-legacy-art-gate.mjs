import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';

// Controlled clock proof against the generated production boot, not a browser
// latency measurement. Run build-legacy before this script.
const checks=[];
for(const game of['tiger','thunder'])for(const scenario of['decoded','decode-stalled']){
 const source=await readFile(`.local/legacy-src/boot-${game}.ts`,'utf8');
 const gate=source.slice(source.indexOf('const artReady='),source.indexOf('void artReady.catch'));
 const {code}=await transform(gate+'\nglobalThis.artReady=artReady;',{loader:'ts',target:'es2022'});
 const images=[],timers=new Map(),decoders=[];let next=0;
 class Image{constructor(){images.push(this);}decode(){return new Promise(resolve=>decoders.push(resolve));}}
 const context={Image,Promise,setTimeout(fn,ms){assert.equal(ms,20000);timers.set(++next,fn);return next;},clearTimeout(id){timers.delete(id);}};
 runInNewContext(code,context);assert.equal(images.length,5);
 for(const image of images)image.onload();assert.equal(timers.size,5,'image onload must not cancel the decode deadline');
 if(scenario==='decoded'){for(const resolve of decoders)resolve();await context.artReady;assert.equal(timers.size,0);}
 else{const rejected=assert.rejects(context.artReady,/游戏画面加载超时/);timers.values().next().value();await rejected;}
 checks.push(`${game}: ${scenario}`);
}
const report={scope:'Generated boot gate with controlled Image.decode and clock; no browser or network timing claim.',checks,passed:true};
await mkdir('review/deep-mobile-20260928/legacy-art-gate',{recursive:true});await writeFile('review/deep-mobile-20260928/legacy-art-gate/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
