/** Presentation updates pause in hidden pages; authority clocks keep advancing. */
export function startVisibleInterval(callback,ms,{target=globalThis.document,setTimer=setInterval,clearTimer=clearInterval}={}){
 let timer=null,stopped=false;
 const update=()=>{if(timer!==null){clearTimer(timer);timer=null;}if(!stopped&&!target?.hidden){callback();timer=setTimer(callback,ms);}};
 target?.addEventListener('visibilitychange',update);update();
 return()=>{stopped=true;if(timer!==null)clearTimer(timer);timer=null;target?.removeEventListener('visibilitychange',update);};
}
