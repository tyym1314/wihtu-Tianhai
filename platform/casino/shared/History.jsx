import React,{useEffect,useState} from 'react';
import {api} from './client.mjs';
import {t} from './i18n.mjs';
import {full} from './useRound.js';

/** "My records" modal: recent rounds (bets per option) or spins, with stake and payout. */
export function HistoryModal({onClose,label=id=>id}){
 const [data,setData]=useState(null),[error,setError]=useState(false);
 useEffect(()=>{api('/api/casino/history?limit=30').then(setData).catch(()=>setError(true));},[]);
 const time=at=>new Date(at).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
 return <div className="cs-modal-back" onClick={onClose}><div className="cs-modal cs-history" onClick={e=>e.stopPropagation()}>
  <h2>{t('records')}</h2>
  {error?<p>{t('failed')}</p>:!data?<div className="cs-spinner" style={{margin:'20px auto'}}/>:!data.records.length?<p style={{textAlign:'center'}}>{t('noRecords')}</p>:
   <ul>{data.records.map(r=>{const net=BigInt(r.payout_minor)-BigInt(r.stake_minor);return <li key={r.round_id||r.id}>
    <div><small>{time(r.at)}{r.seq?` · #${r.seq}`:''}</small><b className={net>0n?'up':net<0n?'down':''}>{net>0n?'+':''}{full(net)}</b></div>
    <div><span>{r.bets?r.bets.map(b=>`${label(b.option_id)} ${full(b.stake_minor)}`).join(' · '):`${t('stake')} ${full(r.stake_minor)}${r.mode==='buy'?' · '+t('buyFree'):''}${r.free_spins?` · ${t('freeSpins')} ${r.free_spins}`:''}`}</span>
     <em>{r.bets?`${t('result')}: ${label(r.outcome)}`:r.outcome}</em></div></li>;})}</ul>}
  <button className="cs-gold-btn" onClick={onClose}>{t('close')}</button>
 </div></div>;
}
