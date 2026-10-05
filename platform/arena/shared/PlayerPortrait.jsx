import React from 'react';
import './portraits.css';

/** Fictional default avatars, replaced by a partner portrait when one is supplied. */
export default function PlayerPortrait({player,index=0,className=''}) {
 const source=player?.avatar_url||player?.avatarUrl;
 return <span className={`oasis-portrait ${className}`} style={{'--portrait-x':Number(index)%2?'100%':'0%','--portrait-y':Math.floor(Number(index)%4/2)?'100%':'0%'}} aria-hidden="true">
  {source&&/^https?:\/\//i.test(source)&&<img src={source} alt="" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}}/>}
 </span>;
}
