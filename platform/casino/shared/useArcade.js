import {useCallback,useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit,requestRecharge} from './client.mjs';

const AMMO=50;
const ERR={INSUFFICIENT_FUNDS:'insufficient',OUT_OF_AMMO:'failed',ARCADE_CLOSED:'failed'};

/**
 * Arcade play session: the first shot buys AMMO shots at the current bet (one wallet authorization),
 * shots are sent strictly in order, and the session is settled when ammo runs out, the bet changes or
 * the player leaves. The displayed balance = wallet + unused ammo + wins not yet settled.
 */
export function useArcade(initial,game){
 const bets=game.arcade.bets;
 const [wallet,setWallet]=useState(initial.balance?.available_minor??null),[open,setOpen]=useState(initial.open),[bet,setBetState]=useState(initial.open?.bet_minor||bets[1]);
 const [toast,setToast]=useState(null),[sessionWin,setSessionWin]=useState(0n);
 const ref=useRef(initial.open),queue=useRef(Promise.resolve()),seq=useRef(0);
 const say=useCallback(key=>setToast({key,id:Math.random()}),[]);
 const sync=s=>{ref.current=s;setOpen(s);};
 const balanceNow=async()=>{try{const s=await api('/api/casino/state?balance=1');if(s.balance)setWallet(s.balance.available_minor);return s;}catch{return null;}};
 const close=useCallback(async()=>{const a=ref.current;if(!a)return;sync(null);try{await api('/api/casino/arcade/close',{arcade_id:a.id});}catch{}await balanceNow();},[]);
 // A session left open by a previous visit is settled first (its shot sequence lives on the server).
 useEffect(()=>{if(initial.open)queue.current=queue.current.then(close);},[]);
 useEffect(()=>{const hide=()=>{if(document.visibilityState==='hidden')close();};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);},[close]);
 useEffect(()=>registerHostControls({onBack:()=>{close().finally(()=>requestExit());},onBalanceRefresh:()=>{balanceNow();}}),[close]);

 async function ensureOpen(cost){
  let a=ref.current;
  if(a&&(a.bet_minor!==bet||a.used+cost>a.shots)){await close();a=null;}
  if(a)return a;
  if(wallet!==null&&BigInt(wallet)<BigInt(bet)*BigInt(AMMO)){
   // Not enough for a full magazine: buy what the wallet allows.
   const n=wallet===null?AMMO:Number(BigInt(wallet)/BigInt(bet));if(n<cost){requestRecharge('insufficient');throw Object.assign(new Error('funds'),{code:'INSUFFICIENT_FUNDS'});}
   a=await api('/api/casino/arcade/open',{request_id:requestId(),bet_minor:bet,shots:n});
  }else a=await api('/api/casino/arcade/open',{request_id:requestId(),bet_minor:bet,shots:AMMO});
  seq.current=0;a={...a,used:a.used||0,win_minor:a.win_minor||'0'};sync(a);await balanceNow();return a;
 }
 /** Fire a weapon at target types; resolves with the server result ({hits,win_minor_shot}) or null on failure. */
 function shoot(weapon,targets){
  const cost=game.arcade.weapons.find(w=>w.id===weapon).cost;
  const run=async()=>{
   try{const a=await ensureOpen(cost);const r=await api('/api/casino/arcade/shoot',{arcade_id:a.id,seq:++seq.current,weapon,targets});
    const next={...ref.current,used:r.used,win_minor:r.win_minor};sync(next);if(BigInt(r.win_minor_shot||0)>0n)setSessionWin(v=>v+BigInt(r.win_minor_shot));
    // Settle inside the queue: the next queued tap must not buy a new magazine while this one is still open.
    if(next.used>=next.shots)await close();return r;}
   catch(e){say(ERR[e.code]||'failed');if(e.code==='SHOT_OUT_OF_ORDER'||e.code==='ARCADE_CLOSED')await close();return null;}
  };
  const p=queue.current.then(run);queue.current=p.catch(()=>{});return p;
 }
 function setBet(v){setBetState(v);if(ref.current&&ref.current.bet_minor!==v)queue.current=queue.current.then(close);}
 const a=open,display=wallet===null?null:BigInt(wallet)+(a?BigInt(a.bet_minor)*BigInt(a.shots-a.used)+BigInt(a.win_minor||0):0n);
 return {bet,bets,setBet,shoot,balance:display,toast,sessionWin,open:a,exit:()=>close().finally(()=>requestExit())};
}
