import React, {useId} from 'react';
import './showcase.css';

function CrystalTower({x=0,y=0,scale=1,color='#80f8d4',core=false}) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} style={{color}}>
    <ellipse cy="32" rx="40" ry="13" fill="currentColor" opacity=".12"/>
    <path d="M-37 17 0-3 37 17 29 38 0 53-29 38Z" fill="#101f38" stroke="#4e7793" strokeWidth="1.5"/>
    <path d="M-37 17 0-3 37 17 0 37Z" fill="#244e60" stroke="currentColor"/>
    <path d="M-23-29 0-42 23-29 23 10 0 24-23 10Z" fill="#476c86" stroke="#aecadd"/>
    <path d="M0-17 23-29V10L0 24Z" fill="#193b54"/>
    <path d="M-23-29 0-42 23-29 0-16Z" fill="#a9d1de"/>
    <path d="M-34-47 0-65 34-47 29-30 0-13-29-30Z" fill="#294b67" stroke="currentColor"/>
    <path d="M-34-47 0-65 34-47 0-28Z" fill="#92bdc6"/>
    <path d="M-15-11-10-8V8L-15 5ZM10-8 15-11V5L10 8Z" fill="currentColor"/>
    <g className="tl-showcase-crystal"><path d={core?'M0-140 22-99 0-54-22-99Z':'M0-115 16-83 0-51-16-83Z'} fill="currentColor"/><path d={core?'M0-140V-54L-22-99Z':'M0-115V-51L-16-83Z'} fill="#fff" opacity=".48"/><path d={core?'M0-140 22-99 0-109-22-99Z':'M0-115 16-83 0-91-16-83Z'} fill="#fff" opacity=".42"/></g>
    {core&&<g fill="none" stroke="currentColor" opacity=".8"><ellipse cy="-98" rx="43" ry="11" transform="rotate(-18 0 -98)"/><ellipse cy="-96" rx="34" ry="10" transform="rotate(25 0 -96)"/></g>}
  </g>;
}
export function TowerLinkLobbyArt(){return <g data-testid="towerlink-lobby-art">
  <ellipse cx="210" cy="192" rx="159" ry="82" fill="#152d4b" stroke="#75e2cb" strokeWidth="1" opacity=".6"/>
  <ellipse cx="210" cy="190" rx="177" ry="98" fill="none" stroke="#95ccdd" strokeDasharray="4 9" opacity=".25"/>
  <path d="M66 176 156 113 292 117 354 188 263 255 123 252Z" fill="#0c1930" stroke="#7099ba"/>
  <path d="M66 160 156 97 292 101 354 172 263 239 123 236Z" fill="#204158" stroke="#7db8c6"/>
  <path className="tl-showcase-flow" d="M114 189 207 154 297 186M207 154 256 123M207 154 179 219" fill="none" stroke="#b5fff0" strokeWidth="3"/>
  <CrystalTower x={256} y={125} scale={.4} color="#b2a6ff"/>
  <CrystalTower x={115} y={194} scale={.55}/><CrystalTower x={299} y={192} scale={.55} color="#ffc981"/>
  <CrystalTower x={209} y={162} scale={.88} core/><CrystalTower x={180} y={235} scale={.45} color="#ff8bac"/>
</g>;}
export function TowerLinkTrophy(){const id=useId();return <div className="tl-result-trophy" data-testid="towerlink-result-art"><svg viewBox="0 0 300 245" aria-hidden="true"><defs><radialGradient id={id}><stop stopColor="#86ffdc" stopOpacity=".32"/><stop offset="1" stopColor="#86ffdc" stopOpacity="0"/></radialGradient></defs><ellipse cx="150" cy="134" rx="120" ry="107" fill={`url(#${id})`}/><g fill="none" stroke="#86f6d2"><ellipse cx="150" cy="163" rx="105" ry="49" opacity=".15"/><ellipse cx="150" cy="163" rx="91" ry="39" strokeDasharray="3 9" opacity=".5"/></g><CrystalTower x={150} y={182} scale={1.05} core/><g fill="#c9fff0" className="tl-showcase-stars"><path d="M68 65 70 71 76 73 70 75 68 81 66 75 60 73 66 71ZM231 95 233 101 239 103 233 105 231 111 229 105 223 103 229 101Z"/><circle cx="94" cy="41" r="2"/><circle cx="218" cy="57" r="1.6"/></g></svg></div>;}
