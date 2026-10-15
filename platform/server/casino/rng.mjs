/** Deterministic, domain-separated RNG from a 256-bit seed (HMAC-SHA256 counter mode). */
import {createHmac} from 'node:crypto';

export function createRng(seedHex,domain){
 const key=Buffer.from(seedHex,'hex');if(key.length!==32)throw new Error('seed must be 32 bytes');
 let counter=0,buffer=Buffer.alloc(0),offset=0;
 function refill(){buffer=createHmac('sha256',key).update(`${domain}:${counter++}`).digest();offset=0;}
 function uint32(){if(offset+4>buffer.length)refill();const v=buffer.readUInt32BE(offset);offset+=4;return v;}
 /** Uniform integer in [0, n), rejection sampled. */
 function int(n){if(!Number.isSafeInteger(n)||n<=0||n>2**32)throw new Error('range');const limit=2**32-(2**32%n);let v;do v=uint32();while(v>=limit);return v%n;}
 /** Index drawn from integer weights. */
 function weighted(weights){const total=weights.reduce((a,b)=>a+b,0);let r=int(total);for(let i=0;i<weights.length;i++){if(r<weights[i])return i;r-=weights[i];}throw new Error('weights');}
 return {uint32,int,weighted};
}
