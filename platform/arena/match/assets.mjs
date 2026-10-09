import {preloadImages} from '../shared/image-preloader.mjs';
// Keep same-origin CSS/Image cache mode; shared deadline covers download and decode.
export const matchCriticalAssetUrls=['/arena/assets/match-palace-mobile-09ad602636.webp','/arena/assets/restoration/gems-v2.webp','/arena/assets/restoration/fox-idle-v3.webp','/arena/assets/restoration/player-portraits-v2-mobile-e193e8ea76.webp'];
export const matchCheerAssetUrl='/arena/assets/restoration/fox-cheer-v3.webp';
export const preloadMatchAssets=()=>preloadImages(matchCriticalAssetUrls);
// MatchGame starts this after its first painted board. A failed preparation is
// evicted by the shared loader and can retry without delaying any game input.
export const preloadMatchCheer=()=>preloadImages([matchCheerAssetUrl],{fetchPriority:'low'});

/** An owned, disposable preparation job. Two frames let the board paint first. */
export function createMatchCheerPreparation({load=preloadMatchCheer,requestFrame=requestAnimationFrame,cancelFrame=cancelAnimationFrame,onReady=()=>{}}={}){
 let ready=false,disposed=false,pending=null;const frames=new Map();
 const nextFrame=()=>new Promise(resolve=>{if(disposed){resolve(false);return;}const id=requestFrame(()=>{frames.delete(id);resolve(true);});frames.set(id,resolve);});
 function prepare(){
  if(disposed)return Promise.resolve(false);
  if(ready)return Promise.resolve(true);
  if(pending)return pending;
  pending=(async()=>{if(!await nextFrame()||!await nextFrame()||disposed)return false;await load();if(disposed)return false;ready=true;onReady();return true;})().catch(()=>false).finally(()=>{pending=null;});
  return pending;
 }
 function dispose(){disposed=true;for(const [id,resolve]of frames){cancelFrame(id);resolve(false);}frames.clear();}
 return{prepare,dispose,get ready(){return ready;}};
}
