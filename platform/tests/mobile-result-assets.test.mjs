import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const repo=new URL('../../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('../mobile-assets.json',import.meta.url),'utf8'));
const trophy=manifest.find(row=>row.source==='platform/arena/public/assets/restoration/trophies-v2.png');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function webpSize(bytes){
 assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
 assert.equal(bytes.toString('ascii',12,16),'VP8X','Extended WebP exposes the atlas dimensions and alpha flag');
 return{width:bytes.readUIntLE(24,3)+1,height:bytes.readUIntLE(27,3)+1,alpha:!!(bytes[20]&0x10)};
}
test('mobile trophy delivery preserves original dimensions, transparent sheet and immutable provenance',async()=>{
 assert(trophy,'all result themes need a recorded delivery variant');
 const [source,target,previous]=await Promise.all([trophy.source,trophy.target,trophy.previous_runtime_target].map(path=>readFile(new URL(path,repo))));
 assert.equal(sha(source),trophy.source_sha256);assert.equal(source.length,trophy.source_bytes);
 assert.equal(sha(target),trophy.target_sha256);assert.equal(target.length,trophy.target_bytes);
 assert(trophy.target.includes(trophy.target_sha256.slice(0,10)),'immutable name must match actual bytes');
 assert.equal(sha(previous),trophy.previous_runtime_sha256);assert.equal(previous.length,trophy.previous_runtime_bytes);
 assert.deepEqual({width:source.readUInt32BE(16),height:source.readUInt32BE(20)},trophy.dimensions);
 assert.equal(source[25],6,'source PNG uses RGBA, not an opaque composite');
 assert.deepEqual(webpSize(target),{...trophy.dimensions,alpha:true});
 assert.deepEqual(webpSize(previous),{...trophy.dimensions,alpha:true});
 assert(target.length<previous.length*.8,'the variant must reduce bytes without reducing resolution');
});
test('mobile sheet keeps all ten original 5 by 2 normalized trophy cells',()=>{
 assert.equal(trophy.atlas.columns,5);assert.equal(trophy.atlas.rows,2);
 assert.deepEqual(trophy.atlas.order,['carrom','match','golf','darts','ludo','pool','bowling','jackaroo','domino','run']);
 const positions=trophy.atlas.order.map((game,index)=>({game,column:index%5,row:Math.floor(index/5),x:index%5*25,y:index<5?0:100}));
 assert.equal(new Set(positions.map(cell=>`${cell.x},${cell.y}`)).size,10);
 assert(positions.every(cell=>(cell.column+1)*trophy.dimensions.width/5<=trophy.dimensions.width&&(cell.row+1)*trophy.dimensions.height/2<=trophy.dimensions.height));
 assert(trophy.dimensions.width/5>=334&&trophy.dimensions.height/2>=334,'largest existing 334px trophy retains its original source pixels');
});
test('result mobile backdrops are the manifest-pinned gameplay images from the same original scene',async()=>{
 const pairs=[['platform/arena/pool/assets/midnight-club.png','platform/arena/pool/assets/midnight-club-mobile-cb6f5ec471.webp'],['platform/arena/darts/assets/night-room.png','platform/arena/darts/assets/night-room-mobile-60782ace8b.webp'],['platform/arena/golf/assets/textures/oasis-distant-palace.webp','platform/arena/golf/assets/textures/oasis-distant-palace-mobile-e251f780d8.webp']];
 for(const [sourcePath,targetPath] of pairs){
  const asset=manifest.find(row=>row.source===sourcePath);assert.equal(asset?.target,targetPath);
  const [source,target]=await Promise.all([sourcePath,targetPath].map(path=>readFile(new URL(path,repo))));
  assert.equal(sha(source),asset.source_sha256);assert.equal(sha(target),asset.target_sha256);
  assert.equal(target.length,asset.target_bytes);assert(target.length<source.length);
 }
 const [run,golfBytes]=await Promise.all(['platform/arena/run/assets/atlases/oasis-environment.webp',pairs[2][0]].map(path=>readFile(new URL(path,repo))));
 assert.equal(sha(run),sha(golfBytes),'Run and Golf share the byte-identical original plate');
 const golf=manifest.find(row=>row.source===pairs[2][0]);assert.equal(golf.dimensions.width/golf.dimensions.height,2/3,'mobile scene keeps its portrait composition');
});
