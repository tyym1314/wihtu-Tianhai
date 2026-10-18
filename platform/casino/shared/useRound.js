import {useCallback,useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from './client.mjs';

const ERRORS={INSUFFICIENT_FUNDS:'insufficient',BETTING_CLOSED:'closed',ROUND_STAKE_LIMIT:'limit',TOO_MANY_OPTIONS:'tooMany'};
const live=b=>!['REJECTED','VOIDED','VOIDING'].includes(b.status);

/** Shared state for timed round games: server clock, polling, bets, balance and toasts. */
export function useRound(initial,game){
 const [state,setState]=useState(initial),[balance,setBalance]=useState(initial.balance?.available_minor??null);
 const [now,setNow]=useState(Date.now()),[toast,setToast]=useState(null),[offline,setOffline]=useState(false),[pending,setPending]=useState({});
 const offset=useRef(initial.server_now-Date.now()),ref=useRef(initial),lastBets=useRef([]),balanceRound=useRef(null);
 const serverNow=useCallback(()=>Date.now()+offset.current,[]);
 const say=useCallback(key=>setToast({key,id:Math.random()}),[]);
 const phaseAt=(r,n)=>n<r.bet_until?'betting':n<r.reveal_at?'drawing':'result';

 const refresh=useCallback(async withBalance=>{
  try{
   const s=await api(`/api/casino/state${withBalance?'?balance=1':''}`);offset.current=s.server_now-Date.now();setOffline(false);
   if(s.round.id!==ref.current.round.id){lastBets.current=ref.current.my_bets.filter(b=>live(b)).map(b=>({option_id:b.option_id,stake_minor:b.stake_minor}));setPending({});}
   ref.current=s;setState(s);if(s.balance)setBalance(s.balance.available_minor);
  }catch{setOffline(true);}
 },[]);
 useEffect(()=>{let stop=false,timer;
  const loop=async()=>{const r=ref.current.round,n=serverNow(),reveal=n>=r.reveal_at&&balanceRound.current!==r.id;if(reveal)balanceRound.current=r.id;
   await refresh(reveal);if(stop)return;const s=ref.current.round,next=[s.bet_until,s.reveal_at,s.ends_at].map(x=>x-serverNow()).filter(x=>x>0);
   timer=setTimeout(loop,Math.max(250,Math.min(1000,...next.map(x=>x+60))));};
  timer=setTimeout(loop,700);return()=>{stop=true;clearTimeout(timer);};
 },[refresh,serverNow]);
 useEffect(()=>{let raf;const tick=()=>{setNow(serverNow());raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[serverNow]);
 useEffect(()=>registerHostControls({onBack:()=>requestExit()}),[]);

 const round=state.round,phase=phaseAt(round,now);
 const mine={};for(const b of state.my_bets)if(live(b))mine[b.option_id]=(mine[b.option_id]||0n)+BigInt(b.stake_minor);
 for(const [o,v] of Object.entries(pending))mine[o]=(mine[o]||0n)+v;

 async function bet(option,stake){
  const r=ref.current.round;
  if(phaseAt(r,serverNow())!=='betting'){say('closed');return;}
  if(!mine[option]&&Object.keys(mine).length>=game.maxOptionsPerRound){say('tooMany');return;}
  if(balance!==null&&BigInt(balance)<BigInt(stake)){say('insufficient');return;}
  setPending(p=>({...p,[option]:(p[option]||0n)+BigInt(stake)}));if(balance!==null)setBalance(b=>String(BigInt(b)-BigInt(stake)));
  try{const placed=await api('/api/casino/bets',{request_id:requestId(),round_id:r.id,option_id:option,stake_minor:stake});
   setState(s=>{if(s.round.id!==r.id)return s;const n={...s,my_bets:[...s.my_bets,placed]};ref.current=n;return n;});}
  catch(e){if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(stake)));say(ERRORS[e.code]||'failed');}
  finally{setPending(p=>{const v=(p[option]||0n)-BigInt(stake),n={...p};if(v>0n)n[option]=v;else delete n[option];return n;});}
 }
 async function repeat(){for(const b of lastBets.current)await bet(b.option_id,b.stake_minor);}
 const myStake=state.my_bets.filter(live).reduce((a,b)=>a+BigInt(b.stake_minor),0n);
 const myWin=phase==='result'?state.my_bets.reduce((a,b)=>a+BigInt(b.payout_minor||0),0n):0n;
 return {state,round,phase,now,balance,mine,myStake,myWin,toast,offline,bet,repeat,canRepeat:lastBets.current.length>0,exit:()=>requestExit()};
}
export const full=minor=>new Intl.NumberFormat('en-US').format(Math.floor(Number(minor||0)));
export const short=minor=>{const v=Number(minor||0);const f=(n,s)=>`${Number.isInteger(n)?n:n.toFixed(1)}${s}`;return v>=1e6?f(v/1e6,'M'):v>=1e3?f(v/1e3,'K'):String(Math.floor(v));};
