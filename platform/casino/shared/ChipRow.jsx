import React from 'react';
import ROWS from './chip-rows.json';
import {short} from './useRound.js';

/** Painted chip rows re-laid for the current bet levels (.local/chips/build.py): positions in design px. */
export const chipRow=id=>ROWS[id]||null;
/** Centre of chip i (for the flying-chip animation). */
export const chipAt=(id,i)=>{const r=ROWS[id];return r?[r.xs[i],r.y]:null;};

/** One button per bet level: the chip art, its amount and a selection ring on the chip face. */
export function ChipRow({id,chips,isOn,onPick,disabled}){
 const r=ROWS[id];if(!r)return null;const w=2*(r.rx+r.pad),h=2*(r.ry+r.pad);
 return chips.map((c,i)=><button key={c} className={`cs-chip ${r.shape==='rect'?'rect':''} ${isOn(c)?'on':''}`} disabled={disabled}
  style={{left:r.xs[i]-w/2,top:r.y-h/2,width:w,height:h,'--pad':`${r.pad}px`,fontSize:Math.round(r.rx*(short(c).length>3?0.5:0.62)),
   backgroundImage:`url(/casino/${id}/chip-${i}.webp?v=${__ASSET_VERSION__})`}} onClick={()=>onPick(c)} aria-label={short(c)}><span>{short(c)}</span></button>);
}
