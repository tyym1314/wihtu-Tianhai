/** Rewrite only the isolated platform presentation; prototype sources stay intact. */
export function rewriteLegacyMobileAssets(source,assets){
 const dynamicTiger='`/legacy/assets/tiger/character-${pose}.png`';
 if(source.includes(dynamicTiger)){
  const poses=Object.fromEntries(['idle','win','blink'].map(pose=>{
   const asset=assets.find(a=>a.original_url===`/assets/tiger/character-${pose}.png`);
   if(!asset?.optimized_url)throw new Error(`Missing mobile Tiger pose: ${pose}`);
   return[pose,'/legacy'+asset.optimized_url];
  }));
  source=source.replaceAll(dynamicTiger,`(${JSON.stringify(poses)} as Record<string,string>)[pose]`);
 }
 source=assets.reduce((value,a)=>value.replaceAll('/legacy'+a.original_url,'/legacy'+a.optimized_url),source);
 // A literal-only replacement silently missed Tiger's computed PNG URLs.
 // New computed legacy asset paths must get an explicit manifest mapping.
 if(/`\/legacy\/assets\/[^`]*\$\{[^`]*`/.test(source))throw new Error('Unmapped dynamic legacy asset URL');
 return source;
}
