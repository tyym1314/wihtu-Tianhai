import {useEffect,useRef,useState} from 'react';

const END_STATES=new Set(['settling','settled','voided','cancelled']);

/** Retain the mounted game briefly for its final action; never delay financial state. */
export default function useResultPresentation(room) {
 const lastActive=useRef(null),[revealed,setRevealed]=useState(null);
 if(room?.status==='active')lastActive.current=room;
 const presenting=Boolean(room&&END_STATES.has(room.status)&&lastActive.current?.id===room.id&&revealed!==room.id);
 useEffect(()=>{
  if(!presenting)return;
  const snapshot=lastActive.current,remaining=Math.max(0,Number(snapshot.game?.busyUntil||0)-Number(room.server_now||Date.now()));
  const tail={golf:2800,bowling:3400,run:2200}[room.game_id]||1200;
  const delay=room.status==='cancelled'||room.status==='voided'?0:Math.min(12000,remaining+tail);
  const timer=setTimeout(()=>setRevealed(room.id),delay);
  return()=>clearTimeout(timer);
 },[presenting,room?.id]);
 // Pass the latest result and non-active status to lock controls, while preserving
 // the mounted game and its in-progress local animation state.
 return {presenting,presentationRoom:presenting?{...lastActive.current,...room,game:{...lastActive.current.game,...room.game}}:room,reveal:()=>setRevealed(room?.id)};
}
