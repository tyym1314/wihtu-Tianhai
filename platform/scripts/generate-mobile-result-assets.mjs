import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Keep the original 5 × 2 sprite geometry and lossless alpha. Reducing this
// sheet's resolution would reduce the roughly 397px source for 334px trophies.
const platform=fileURLToPath(new URL('../',import.meta.url));
const repo=resolve(platform,'..');
const source='platform/arena/public/assets/restoration/trophies-v2.png';
const previous='platform/arena/public/assets/restoration/trophies-v2.webp';
const sourceHash='4e9b7a269fbb85907b990ee2c7ad577567eb7127ae2a60e7fcda126021474cd7';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceBytes=await readFile(resolve(repo,source));
assert.equal(sha(sourceBytes),sourceHash,'Review changed source art before generating a delivery variant');
assert.equal(sourceBytes.readUInt32BE(16),1983);
assert.equal(sourceBytes.readUInt32BE(20),793);
const temporary=await mkdtemp(resolve(tmpdir(),'oasis-mobile-result-'));
try{
 const output=resolve(temporary,'trophies.webp');
 const encoder=process.env.OASIS_CWEBP||'cwebp';
 const args=['-q','82','-m','6','-alpha_q','100','-metadata','icc'];
 const result=spawnSync(encoder,[...args,resolve(repo,source),'-o',output],{encoding:'utf8'});
 if(result.status!==0)throw Error('Trophy encoding failed: '+(result.error?.message||result.stderr));
 const bytes=await readFile(output),hash=sha(bytes);
 assert.equal(hash,'f513af1cd00bd7261508d212dfc65c5a7c544aa3cf8617120d809abe0e68f144','Encoder output changed; review the bytes and CSS reference together before adopting a new variant');
 const target=`platform/arena/public/assets/restoration/trophies-v2-mobile-${hash.slice(0,10)}.webp`;
 const previousBytes=await readFile(resolve(repo,previous));
 assert(bytes.length<previousBytes.length,'Mobile delivery must be smaller than the original runtime asset');
 const psnr=Number(result.stderr.match(/PSNR\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+) dB/)?.[1]);
 assert(Number.isFinite(psnr),'Encoder must report the delivered image quality');
 await writeFile(resolve(repo,target),bytes);
 const asset={source,target,source_sha256:sourceHash,target_sha256:hash,source_bytes:sourceBytes.length,target_bytes:bytes.length,
  original_url:'/assets/restoration/trophies-v2.webp',optimized_url:`/assets/restoration/trophies-v2-mobile-${hash.slice(0,10)}.webp`,
  codec:'WebP quality82 m6 alpha100 from original PNG, original1983x793, ICC retained',
  dimensions:{width:1983,height:793},atlas:{columns:5,rows:2,order:['carrom','match','golf','darts','ludo','pool','bowling','jackaroo','domino','run']},
  previous_runtime_target:previous,previous_runtime_sha256:sha(previousBytes),previous_runtime_bytes:previousBytes.length,
  generator:'platform/scripts/generate-mobile-result-assets.mjs',encoder:spawnSync(encoder,['-version'],{encoding:'utf8'}).stdout.trim().split('\n')[0],encoder_arguments:args,encoder_yuv_psnr_db:psnr,
  alpha_note:'Lossless original alpha; no resizing, cropping, compositing or cell reordering. Original PNG and desktop WebP retained.'};
 const manifestFile=resolve(platform,'mobile-assets.json'),manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 const index=manifest.findIndex(row=>row.source===source);
 if(index<0)manifest.push(asset);else manifest[index]=asset;
 await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({asset,encoder_report:result.stderr}));
}finally{await rm(temporary,{recursive:true,force:true});}
