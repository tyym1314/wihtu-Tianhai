import React,{useEffect,useRef} from 'react';
import {dartFlightPose} from './flight.mjs';
const DART_IMAGE=new URL('./assets/v3/metal-dart.webp',import.meta.url).href;

// All coordinates are visual only. The tip (0, 0) is pinned to the authoritative hit.
export function DartMaterialDefs({simple=false}){return <defs>
 <linearGradient id="da-steel"><stop stopColor="#273342"/><stop offset=".19" stopColor="#c0cad1"/><stop offset=".38" stopColor="#fff5d2"/><stop offset=".57" stopColor="#aa8e55"/><stop offset=".76" stopColor="#e9d29d"/><stop offset="1" stopColor="#39404a"/></linearGradient>
 <linearGradient id="da-fin"><stop stopColor="#040e20"/><stop offset=".38" stopColor="#133d5d"/><stop offset=".5" stopColor="#63b8d9"/><stop offset=".56" stopColor="#163b57"/><stop offset="1" stopColor="#020b18"/></linearGradient>
 <linearGradient id="da-fin-gold"><stop stopColor="#593513"/><stop offset=".35" stopColor="#f9dda0"/><stop offset=".55" stopColor="#c4964b"/><stop offset="1" stopColor="#5d431e"/></linearGradient>
 {!simple&&<filter id="da-surface"><feTurbulence type="fractalNoise" baseFrequency="140" numOctaves="2" seed="17"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".15"/></feComponentTransfer><feBlend in="SourceGraphic" mode="soft-light"/><feComposite in2="SourceAlpha" operator="in"/></filter>}
 </defs>;}
export function MetalDart({scale=1}){return <g transform={`scale(${scale})`} className="da-metal-dart"><image href={DART_IMAGE} x="-.23" y="-.06193362236" width=".46" height=".92" pointerEvents="none"/></g>;}
export function FlyingDart({event,now,getNow}){
 const root=useRef(null),trail=useRef(null),body=useRef(null),size=useRef(null),read=useRef(null);read.current=getNow||(()=>now);
 const {t,x,y,scale,rotation}=dartFlightPose(event,getNow?getNow():now);
 useEffect(()=>{
  let frame=null,stopped=false;
  const draw=()=>{frame=null;if(stopped||document.hidden)return;const p=dartFlightPose(event,read.current());
   root.current?.setAttribute('data-tip-x',p.x);root.current?.setAttribute('data-tip-y',p.y);
   trail.current?.setAttribute('d',`M.38 1.85Q${(p.x+.38)/2-.12} ${(p.y+1.85)/2} ${p.x} ${p.y}`);trail.current?.setAttribute('stroke-width',.035*(1-p.t));trail.current?.setAttribute('opacity',.7*(1-p.t));
   body.current?.setAttribute('transform',`translate(${p.x} ${p.y}) rotate(${p.rotation})`);size.current?.setAttribute('transform',`scale(${p.scale})`);
   if(p.t<1)frame=requestAnimationFrame(draw);
  };
  const visibility=()=>{if(frame!==null)cancelAnimationFrame(frame);frame=null;if(!document.hidden)draw();};
  document.addEventListener('visibilitychange',visibility);draw();
  return()=>{stopped=true;if(frame!==null)cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visibility);};
 },[event.id,event.at,event.busyUntil]);
 return <g ref={root} className="da-flight-object" data-testid="darts-flight" data-hit-x={event.hit.x} data-hit-y={event.hit.y} data-tip-x={x} data-tip-y={y} pointerEvents="none">
  <path ref={trail} d={`M.38 1.85Q${(x+.38)/2-.12} ${(y+1.85)/2} ${x} ${y}`} stroke="#abf4ff" strokeWidth={.035*(1-t)} opacity={.7*(1-t)} fill="none"/>
  <g ref={body} transform={`translate(${x} ${y}) rotate(${rotation})`}><g ref={size} transform={`scale(${scale})`}><MetalDart/></g></g>
 </g>;
}
export function DartImpact({event}){
 const{x,y}=event.hit;
 return <g key={event.id} transform={`translate(${x} ${y})`} pointerEvents="none"><g className="da-impact-burst">
 {Array.from({length:16},(_,i)=>{const a=i*Math.PI/8;return <path key={i} d={`M${Math.cos(a)*.04} ${Math.sin(a)*.04}L${Math.cos(a)*(.15+i%3*.045)} ${Math.sin(a)*(.15+i%3*.045)}`} stroke={i%3?'#79edff':'#fff1bc'} strokeWidth=".008"/>;})}
 <circle r=".043" fill="#eaffff"/>
 </g></g>;
}
