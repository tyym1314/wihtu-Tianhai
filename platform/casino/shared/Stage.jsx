import React,{useEffect,useState} from 'react';

/**
 * Renders the concept plate at its design size (default 941x1672) scaled to fit the screen.
 * Children are positioned in design pixels. Extra screen height shows a blurred extension of the plate.
 */
export function Stage({plate,width=941,height=1672,className='',dir,children}){
 const [scale,setScale]=useState(1);
 useEffect(()=>{const fit=()=>setScale(Math.min(window.innerWidth/width,window.innerHeight/height));fit();window.addEventListener('resize',fit);return()=>window.removeEventListener('resize',fit);},[width,height]);
 return <div className="cs-stage-root" dir={dir}>
  <div className="cs-stage-fill" style={{backgroundImage:`url(${plate})`}}/>
  <div className={`cs-stage ${className}`} style={{width,height,transform:`translate(-50%,-50%) scale(${scale})`,backgroundImage:`url(${plate})`}}>{children}</div>
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
