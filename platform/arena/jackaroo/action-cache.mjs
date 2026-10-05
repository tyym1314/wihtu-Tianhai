// Cache only a pure legal-action enumeration, never a room view or its clock.
// Budget counts serialized bytes; it is not an estimate of JS heap bytes.
export function createActionCache({maxEntries=64,maxBytes=4*1024*1024,ttlMs=60000,clock=()=>performance.now()}={}){
 const entries=new Map();let bytes=0,hits=0,misses=0;
 const remove=key=>{const value=entries.get(key);if(value){bytes-=value.bytes;entries.delete(key);}};
 return{
  get(key,fingerprint,compute){
   const now=clock();for(const[k,value]of entries)if(now-value.at>=ttlMs)remove(k);
   const found=entries.get(key);
   if(found?.fingerprint===fingerprint){hits++;entries.delete(key);entries.set(key,found);return structuredClone(found.actions);}
   misses++;remove(key);const actions=compute();
   const size=new TextEncoder().encode(key+fingerprint+JSON.stringify(actions)).byteLength;
   if(size<=maxBytes&&maxEntries>0){
    while(entries.size>=maxEntries||bytes+size>maxBytes)remove(entries.keys().next().value);
    // Keep an independent copy, so neither a caller nor compute's owner can
    // change what another request receives from this cache.
    entries.set(key,{fingerprint,actions:structuredClone(actions),bytes:size,at:now});bytes+=size;
   }
   return actions;
  },
  clear(){entries.clear();bytes=0;hits=0;misses=0;},
  stats(){return{hits,misses,entries:entries.size,bytes};}
 };
}
