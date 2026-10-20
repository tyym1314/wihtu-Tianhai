import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {DECORATIVE,HALF_MIN_ASPECT,HALF_WIDE,WIDE_WIDTH,halfLayout} from './half.mjs';

// Extended plates (plate-ext.webp) continue the art above and below the 1672-px design area.
export const EXT_HEIGHT=2100;
const insets=()=>{const css=getComputedStyle(document.documentElement);const px=k=>Math.max(0,parseFloat(css.getPropertyValue('--oasis-host-inset-'+k))||0);return{top:px('top'),bottom:px('bottom')};};

/**
 * Renders the concept plate at its design size (default 941x1672), scaled to fit between the host's
 * top and bottom insets (status bar, navigation bar). Children are positioned in design pixels.
 * The extended plate fills the rest of the screen; a blurred copy covers anything beyond it.
 */
export function Stage({plate,width=941,height:fullHeight=1672,className='',dir,children}){
 const id=typeof plate==='string'?(plate.match(/\/casino\/([^/]+)\/plate\.webp/)||[])[1]:null;
 const [aspect,setAspect]=useState(()=>window.innerWidth/window.innerHeight);
 const panel=aspect>HALF_MIN_ASPECT,half=panel?halfLayout(id,fullHeight):null,height=half?half.height:fullHeight,wide=panel&&!half&&HALF_WIDE.has(id);
 const stage=useRef(null);
 const [fit,setFit]=useState({scale:1,cy:0});
 useEffect(()=>{
  // Centre on the screen so the extended plate covers it top to bottom; only move the design area when it
  // would otherwise reach under the status bar or the navigation bar.
  const update=()=>{const {top,bottom}=insets(),w=window.innerWidth,h=window.innerHeight,avail=Math.max(1,h-top-bottom);
   // Voice-room panel: fill it edge to edge (full width, full height; the plate is squeezed vertically if needed).
   if(window.innerWidth/window.innerHeight>HALF_MIN_ASPECT){setFit(wide?{scale:h/height,cy:h/2}:{scale:w/width,scaleY:h/height,cy:h/2});return;}
   const scale=Math.min(w/width,avail/height),half=height*scale/2;
   setFit({scale,cy:Math.min(Math.max(h/2,top+half),h-bottom-half)});};
  update();setAspect(window.innerWidth/window.innerHeight);
  const resize=()=>{setAspect(window.innerWidth/window.innerHeight);update();};window.addEventListener('resize',resize);window.addEventListener('oasis:host-state',update);
  return()=>{window.removeEventListener('resize',resize);window.removeEventListener('oasis:host-state',update);};
 },[width,height,wide]);
 // Half-screen: move every overlay up by the plate height removed above it (CSS `translate`, so the
 // elements' own transforms and animations are untouched); full-stage wrappers pass this on to their children.
 useLayoutEffect(()=>{
  const root=stage.current;if(!root)return;
  const place=parent=>{for(const el of parent.children){if(el.dataset.halfBands!==undefined)continue;
   const top=el.offsetTop,h=el.offsetHeight;
   if(!half){el.style.translate='';el.style.visibility='';continue;}
   if(top<=1&&h>=height*0.9){el.style.translate='';place(el);continue;}
   // Anchored near the element's top, so a control that grows (an opened menu) keeps its place.
   const c=top+Math.min(h,80)/2,cut=half.cutAt(c),decor=DECORATIVE.test(el.className?.toString?.()||'');
   // Inside a removed band: decoration hides, controls / live data sit at the seam.
   el.style.translate=`0 ${cut&&!decor?half.map(cut[0])-top:half.map(c)-c}px`;
   el.style.visibility=cut&&decor?'hidden':'';}};
  place(root);
  const mo=new MutationObserver(()=>place(root));mo.observe(root,{childList:true,subtree:true});
  return()=>mo.disconnect();
 });
 const ext=typeof plate==='string'?plate.replace('/plate.webp','/plate-ext.webp'):null,{scale,cy}=fit,scaleY=fit.scaleY??scale;
 const at=`translate(-50%,-50%) scale(${scale},${scaleY})`;
 return <div className="cs-stage-root" dir={dir}>
  <div className="cs-stage-fill" style={{backgroundImage:`url(${plate})`}}/>
  {wide&&<div className="cs-stage-ext" style={{width:WIDE_WIDTH,height,top:cy,transform:at,backgroundImage:`url(${plate.replace('/plate.webp','/plate-wide.webp')})`}}/>}
  {ext&&!panel&&<div className="cs-stage-ext" style={{width,height:EXT_HEIGHT,top:cy,transform:at,backgroundImage:`url(${ext})`}}/>}
  <div ref={stage} className={`cs-stage ${className}`} style={{width,height,top:cy,transform:at,backgroundImage:half?'none':`url(${plate})`}}>
   {half&&<HalfPlate plate={plate} layout={half} width={width} height={fullHeight}/>}{children}</div>
 </div>;
}

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
