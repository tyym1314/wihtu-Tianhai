import React from 'react';
import './portraits.css';

/** Fictional default avatars, replaced by a partner portrait when one is supplied. */
export default function PlayerPortrait({player,index=0,className='',fallback}) {
 const source=player?.avatar_url||player?.avatarUrl;
 return <span className={`oasis-portrait ${className}`} style={{'--portrait-x':Number(index)%2?'100%':'0%','--portrait-y':Math.floor(Number(index)%4/2)?'100%':'0%',backgroundImage:fallback?'none':undefined}} aria-hidden="true">
  {fallback}
  {source&&/^https?:\/\//i.test(source)&&<img key={source} src={source} alt="" referrerPolicy="no-referrer" style={fallback?{position:'relative',zIndex:1}:undefined} onError={event=>{event.currentTarget.hidden=true;}}/>}
 </span>;
}
