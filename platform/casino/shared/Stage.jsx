import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {DECORATIVE,HALF_MIN_ASPECT,HALF_WIDE,WIDE_WIDTH,halfLayout,setActiveHalf} from './half.mjs';

// Extended plates (plate-ext.webp) continue the art above and below the 1672-px design area.
export const EXT_HEIGHT=2100;
// Landscape games (design wider than tall) extend left and right instead: plate-ext.webp is EXT_WIDTH x height.
export const EXT_WIDTH=2400;
const insets=()=>{const css=getComputedStyle(document.documentElement);const px=k=>Math.max(0,parseFloat(css.getPropertyValue('--oasis-host-inset-'+k))||0);return{top:px('top'),bottom:px('bottom'),left:px('left'),right:px('right')};};

/**
 * Renders the concept plate at its design size (default 941x1672), scaled to fit between the host's
 * top and bottom insets (status bar, navigation bar). Children are positioned in design pixels.
 * The extended plate fills the rest of the screen; a blurred copy covers anything beyond it.
 */
export function Stage({plate,width=941,height:fullHeight=1672,className='',dir,children}){
 const id=typeof plate==='string'?(plate.match(/\/casino\/([^/]+)\/plate\.webp/)||[])[1]:null;
 const [aspect,setAspect]=useState(()=>window.innerWidth/window.innerHeight);
 // Landscape games have no voice-room panel layout (the operator decision 2026-10-24: FishStar is full screen only).
 const panel=aspect>HALF_MIN_ASPECT&&width<fullHeight,half=panel?halfLayout(id,fullHeight):null,height=half?half.height:fullHeight,wide=panel&&!half&&HALF_WIDE.has(id);
 const stage=useRef(null);
 const [fit,setFit]=useState({scale:1,cy:0});
 useEffect(()=>{
  // Centre on the screen so the extended plate covers it top to bottom; only move the design area when it
  // would otherwise reach under the status bar or the navigation bar.
  const update=()=>{const {top,bottom}=insets(),w=window.innerWidth,h=window.innerHeight,avail=Math.max(1,h-top-bottom);
   // Voice-room panel: fill it edge to edge (full width, full height; the plate is squeezed vertically if needed).
   if(width<fullHeight&&window.innerWidth/window.innerHeight>HALF_MIN_ASPECT){setFit(wide?{scale:h/height,cy:h/2}:{scale:w/width,scaleY:h/height,cy:h/2});return;}
   // Landscape games also keep clear of a side notch / navigation bar and centre between them.
   const {left,right}=insets(),availW=width>height?Math.max(1,w-left-right):w;
   const scale=Math.min(availW/width,avail/height),half=height*scale/2;
   setFit({scale,cy:Math.min(Math.max(h/2,top+half),h-bottom-half),cx:width>height?left+availW/2:undefined});};
  update();setAspect(window.innerWidth/window.innerHeight);
  const resize=()=>{setAspect(window.innerWidth/window.innerHeight);update();};window.addEventListener('resize',resize);window.addEventListener('oasis:host-state',update);
  return()=>{window.removeEventListener('resize',resize);window.removeEventListener('oasis:host-state',update);};
 },[width,height,wide]);
 // Half-screen: move every overlay up by the plate height removed above it (CSS `translate`, so the
 // elements' own transforms and animations are untouched); full-stage wrappers pass this on to their children.
 useLayoutEffect(()=>{
  const root=stage.current;if(!root)return;setActiveHalf(half);
  const place=parent=>{for(const el of parent.children){if(el.dataset.halfBands!==undefined)continue;
   const top=el.offsetTop,h=el.offsetHeight;
   if(!half){el.style.translate='';el.style.visibility='';continue;}
   if(top<=1&&h>=height*0.9){el.style.translate='';place(el);continue;}
   // Anchored near the element's top, so a control that grows (an opened menu) keeps its place.
   const c=top+Math.min(h,80)/2,cut=half.cutAt(c),decor=DECORATIVE.test(el.className?.toString?.()||'');
   // Inside a removed band: decoration hides, controls / live data sit at the seam.
   el.style.translate=`0 ${cut&&!decor?half.map(cut[0])-top:half.map(c)-c}px`;
   // Flying coins: the start moved with its band; the flight (--dy, full-plate px) is re-aimed at the mapped target.
   const dy=el.dataset.dy0??el.style.getPropertyValue('--dy');
   if(dy){el.dataset.dy0=dy;const y0=top+h/2,d=parseFloat(dy);el.style.setProperty('--dy',`${half.map(y0+d)-half.map(y0)}px`);}
   el.style.visibility=cut&&decor?'hidden':'';}};
  place(root);
  const mo=new MutationObserver(()=>place(root));mo.observe(root,{childList:true,subtree:true});
  return()=>mo.disconnect();
 });
 const {scale,cy}=fit,scaleY=fit.scaleY??scale,left=fit.cx===undefined?undefined:fit.cx;
 const at=`translate(-50%,-50%) scale(${scale},${scaleY})`;
 // One complete picture per mode, nothing stacked: plate-full (full screen, art beyond the design area included),
 // plate-half (voice-room panel). The scene is shown only once it has loaded (main.jsx preloads the same file).
 const one=typeof plate==='string'?plate.replace('/plate.webp',panel?'/plate-half.webp':'/plate-full.webp'):null,ready=useImageReady(one);
 const box=panel?(wide?{width:WIDE_WIDTH,height}:{width,height}):(width>fullHeight?{width:EXT_WIDTH,height}:{width,height:EXT_HEIGHT});
 return <div className="cs-stage-root" dir={dir}>
  {ready?<div className="cs-stage-ext" style={{...box,top:cy,left,transform:at,backgroundImage:`url(${one})`}}/>
   :<div className="cs-stage-ext" style={{width,height,top:cy,left,transform:at,backgroundImage:half?'none':`url(${plate})`}}>{half&&<HalfPlate plate={plate} layout={half} width={width} height={fullHeight}/>}</div>}
  <div ref={stage} className={`cs-stage ${className}`} style={{width,height,top:cy,left,transform:at}}>{children}</div>
 </div>;
}

/** True once the image has loaded (main.jsx preloads plate-ext, so this is normally true on the first frame). */
function useImageReady(src){
 // main.jsx preloads the same URL before the scene mounts: an image already in the memory cache is ready on the
 // first render, so the fallback plate is never painted in between.
 const [ready,setReady]=useState(()=>{if(!src)return false;if(loaded.has(src))return true;const i=new Image();i.src=src;
  if(i.complete&&i.naturalWidth){loaded.add(src);return true;}return false;});
 useEffect(()=>{if(!src){setReady(false);return;}if(loaded.has(src)){setReady(true);return;}
  let live=true;const i=new Image();i.onload=()=>{loaded.add(src);if(live)setReady(true);};i.onerror=()=>{if(live)setReady(false);};i.src=src;
  return()=>{live=false;};},[src]);
 return ready;
}
const loaded=new Set();

const SEAM=24;
/** The kept / squeezed segments of the plate stacked top to bottom; a segment after a cut fades in over the one above. */
export function HalfPlate({plate,layout,width,height,style}){
 return <div data-half-bands="" style={{position:'absolute',inset:0,pointerEvents:'none',...style}}>{layout.segments.map((g,i)=>{
  if(!g.s)return null;
  const afterCut=i>0&&layout.segments[i-1].s===0,from=afterCut?Math.max(0,g.a-SEAM):g.a,lead=(g.a-from)*g.s,top=layout.map(g.a)-lead;
  const mask=afterCut?`linear-gradient(to bottom,transparent 0,#000 ${lead}px)`:undefined;
  return <div key={g.a} style={{position:'absolute',left:0,top,width,height:(g.b-from)*g.s,backgroundImage:`url(${plate})`,
   backgroundSize:`${width}px ${height*g.s}px`,backgroundPosition:`0 ${-from*g.s}px`,WebkitMaskImage:mask,maskImage:mask}}/>;})}</div>;
}

/** Absolutely positioned box in design pixels. */
export const Box=({x,y,w,h,className='',style,children,...rest})=><div className={className} style={{position:'absolute',left:x,top:y,width:w,height:h,...style}} {...rest}>{children}</div>;

/** Animated number that counts toward its value. */
export function CountUp({value,format=v=>v,ms=900}){
 const [shown,setShown]=useState(value);
 useEffect(()=>{const from=Number(shown),to=Number(value);if(from===to)return;const t0=performance.now();let raf;
  const step=t=>{const p=Math.min(1,(t-t0)/ms),v=from+(to-from)*(1-(1-p)**3);setShown(p<1?v:to);if(p<1)raf=requestAnimationFrame(step);};raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf);},[value]);
 return <>{format(shown)}</>;
}

/** Short banner when betting opens or closes (keyed by round + phase). */
export function PhaseBanner({round,phase,text,onShow}){
 const [shown,setShown]=useState(null);
 useEffect(()=>{if(phase!=='betting'&&phase!=='drawing'&&phase!=='flying')return;const k=round.id+phase;setShown({k,text:text[phase]});onShow?.(phase);const id=setTimeout(()=>setShown(s=>s?.k===k?null:s),1300);return()=>clearTimeout(id);},[round.id,phase]);
 return shown?<div key={shown.k} className={`cs-phase ${phase}`}><span>{shown.text}</span></div>:null;
}
