import React,{useEffect} from 'react';
import {api,registerHostControls,requestRecharge} from './client.mjs';
import {Box} from './Stage.jsx';

/** Tap area over the balance pill and the "+" drawn right after it: asks the host App to open its top-up page. */
export function RechargeTap({x,y,w,h}){
 return <Box x={x-8} y={y-8} w={w+Math.round(h*1.5)+16} h={h+16} className="cs-recharge-tap" role="button" aria-label="top up" onClick={()=>requestRecharge('user')}/>;
}

/** Re-read the wallet balance when the host App reports a change (e.g. after its top-up page closes). */
export function useHostBalance(setBalance){
 useEffect(()=>registerHostControls({onBalanceRefresh:()=>{api('/api/casino/state?balance=1').then(s=>{if(s.balance)setBalance(s.balance.available_minor);}).catch(()=>{});}}),[setBalance]);
}
