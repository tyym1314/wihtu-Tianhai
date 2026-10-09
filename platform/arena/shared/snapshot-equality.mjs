/** JSON snapshots only: retain references without ignoring a changed field. */
export function sameSnapshot(a,b){
 if(a===b)return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 if(Array.isArray(a)){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(!sameSnapshot(a[i],b[i]))return false;return true;}
 const keys=Object.keys(a);
 if(keys.length!==Object.keys(b).length)return false;
 return keys.every(key=>Object.hasOwn(b,key)&&sameSnapshot(a[key],b[key]));
}
export function retainSnapshot(previous,next){return sameSnapshot(previous,next)?previous:next;}
