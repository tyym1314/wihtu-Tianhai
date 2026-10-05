import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import {rewriteLegacyMobileAssets} from '../scripts/legacy-mobile-assets.mjs';
const assets=JSON.parse(await readFile(new URL('../mobile-assets.json',import.meta.url),'utf8')).filter(a=>a.source.startsWith('public/'));
test('isolated mobile art maps all Tiger runtime poses and retains literal URL rewriting',async()=>{
 const original=await readFile(new URL('../../src/tiger/character.ts',import.meta.url),'utf8');
 const transformed=rewriteLegacyMobileAssets(original.replaceAll('/assets/','/legacy/assets/'),assets);
 assert.ok(!transformed.includes('character-${pose}.png'));
 for(const pose of ['idle','win','blink']){
  const asset=assets.find(a=>a.original_url===`/assets/tiger/character-${pose}.png`);
  assert.ok(transformed.includes('/legacy'+asset.optimized_url));
 }
 await transform(transformed,{loader:'ts'});
 assert.equal(rewriteLegacyMobileAssets("url('/legacy/assets/tiger/scene.png')",assets),"url('/legacy"+assets.find(a=>a.original_url==='/assets/tiger/scene.png').optimized_url+"')");
 assert.equal(await readFile(new URL('../../src/tiger/character.ts',import.meta.url),'utf8'),original);
});
test('mobile art build fails for incomplete pose manifests or new unmapped dynamic URLs',()=>{
 const source='image.src = `/legacy/assets/tiger/character-${pose}.png`;';
 assert.throws(()=>rewriteLegacyMobileAssets(source,assets.filter(a=>!a.original_url.endsWith('/character-blink.png'))),/Missing mobile Tiger pose: blink/);
 assert.throws(()=>rewriteLegacyMobileAssets('image.src = `/legacy/assets/new-${pose}.png`;',assets),/Unmapped dynamic legacy asset URL/);
});
test('Thunder bonus-mode CSS uses the same verified mobile manifest as its image gate',async()=>{
 const source=await readFile(new URL('../../src/style.css',import.meta.url),'utf8');
 const transformed=rewriteLegacyMobileAssets(source.replaceAll('/assets/','/legacy/assets/'),assets);
 const free=assets.find(a=>a.original_url==='/assets/thunder-free.png');
 assert(free);assert(free.target_bytes<=768*1024);assert.match(transformed,/\.bonus-mode \.hero-art/);
 assert(!transformed.includes('/legacy/assets/thunder-free.png'));assert(transformed.includes('/legacy'+free.optimized_url));
});
