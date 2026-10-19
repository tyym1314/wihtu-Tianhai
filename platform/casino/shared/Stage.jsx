import React,{useEffect,useState} from 'react';

// Extended plates (plate-ext.webp) continue the art above and below the 1672-px design area.
export const EXT_HEIGHT=2100;
const insets=()=>{const css=getComputedStyle(document.documentElement);const px=k=>Math.max(0,parseFloat(css.getPropertyValue('--oasis-host-inset-'+k))||0);return{top:px('top'),bottom:px('bottom')};};

/**
 * Renders the concept plate at its design size (default 941x1672), scaled to fit between the host's
 * top and bottom insets (status bar, navigation bar). Children are positioned in design pixels.
 * The extended plate fills the rest of the screen; a blurred copy covers anything beyond it.
 */
export function Stage({plate,width=941,height=1672,className='',dir,children}){
 const [fit,setFit]=useState({scale:1,cy:0});
 useEffect(()=>{
  const update=()=>{const {top,bottom}=insets(),w=window.innerWidth,h=window.innerHeight,avail=Math.max(1,h-top-bottom);
   setFit({scale:Math.min(w/width,avail/height),cy:top+avail/2});};
  update();window.addEventListener('resize',update);window.addEventListener('oasis:host-state',update);
  return()=>{window.removeEventListener('resize',update);window.removeEventListener('oasis:host-state',update);};
 },[width,height]);
 const ext=typeof plate==='string'?plate.replace('/plate.webp','/plate-ext.webp'):null,{scale,cy}=fit;
 const at=`translate(-50%,-50%) scale(${scale})`;
 return <div className="cs-stage-root" dir={dir}>
  <div className="cs-stage-fill" style={{backgroundImage:`url(${plate})`}}/>
  {ext&&<div className="cs-stage-ext" style={{width,height:EXT_HEIGHT,top:cy,transform:at,backgroundImage:`url(${ext})`}}/>}
  <div className={`cs-stage ${className}`} style={{width,height,top:cy,transform:at,backgroundImage:`url(${plate})`}}>{children}</div>
 </div>;
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
