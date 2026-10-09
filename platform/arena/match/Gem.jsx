import React from 'react';
const COLORS=['#ff477b','#45efba','#55b8ff','#d581ff','#ffce64'];
/** Alpha sprite from the approved art direction; special glyphs reflect engine state. */
const Gem=React.memo(function Gem({color=3,special=null,className=''}) {
 const index=special==='rainbow'?5:Math.max(0,Math.min(4,color??3));
 return <span className={`match-gem match-gem-raster ${className} ${special?'match-gem-special':''}`} style={{'--gem-x':`${index%3*50}%`,'--gem-y':index<3?'0%':'100%','--gem-color':COLORS[index]||COLORS[3]}} aria-hidden="true">
  <i className="match-gem-surface"/>
  {(special==='row'||special==='column')&&<i className={`match-gem-ribbon ribbon-${special}`}/>}
  {special==='bomb'&&<i className="match-gem-sigil">✦</i>}
  {special==='rainbow'&&<i className="match-gem-orbit"/>}
 </span>;
});
export default Gem;
