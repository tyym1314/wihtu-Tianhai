import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCcw, Search } from 'lucide-react';
import { useApi, formatMinor } from '../api.js';
import ApiState from './ApiState.jsx';

const day=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const csvCell=value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
const KIND={cycle:'整轮旋转',bet:'回合下注',spin:'即时旋转',arcade:'街机开局'};
const STATUS={SETTLED:'已结算',COMPLETED:'已完成',REJECTED:'已拒绝',VOIDED:'已作废',ACCEPTED:'已下注',PENDING:'处理中',AUTHORIZING:'扣款中',OPEN:'进行中',CLOSING:'结算中',SETTLING:'结算中',RESULT_FIXED:'待结算',CHOOSING:'选择中',VOIDING:'作废中'};
const PAGE=100;

/** Admin reconciliation: every paid play by App / game / day range / user, with totals and wallet legs. */
export default function Reconciliation({apps=[],appScope='all',notify}){
 const today=new Date();
 const [app,setApp]=useState(appScope==='all'?'':appScope),[game,setGame]=useState(''),[from,setFrom]=useState(day(new Date(today.getTime()-6*86400000))),[to,setTo]=useState(day(today)),[user,setUser]=useState(''),[offset,setOffset]=useState(0);
 const [names,setNames]=useState({});
 useEffect(()=>{fetch('/launch/meta.json',{cache:'no-store'}).then(r=>r.json()).then(m=>setNames(Object.fromEntries(Object.entries(m).map(([id,v])=>[id,v.name?.zh||id])))).catch(()=>{});},[]);
 useEffect(()=>{setApp(appScope==='all'?'':appScope);},[appScope]);
 useEffect(()=>{setOffset(0);},[app,game,from,to,user]);
 const end=useMemo(()=>{const d=new Date(to+'T00:00:00');d.setDate(d.getDate()+1);return d;},[to]);
 const params=new URLSearchParams({from:new Date(from+'T00:00:00').toISOString(),to:end.toISOString(),limit:String(PAGE),offset:String(offset)});
 if(app)params.set('app_id',app);if(game)params.set('game_id',game);if(user.trim())params.set('user',user.trim());
 const data=useApi('/api/admin/reconciliation?'+params.toString());
 const d=data.data,scale=(apps.find(a=>a.id===app)?.currency_scale)??0,money=v=>formatMinor(v,scale);
 const rtp=(stake,payout)=>BigInt(stake||0)>0n?(Number(BigInt(payout)*10000n/BigInt(stake))/100).toFixed(2)+'%':'—';
 const name=id=>names[id]||id;
 async function exportAll(){
  const all=[];for(let off=0;;off+=500){const p=new URLSearchParams(params);p.set('limit','500');p.set('offset',String(off));const r=await fetch('/api/admin/reconciliation?'+p,{credentials:'same-origin'}).then(x=>x.json());all.push(...(r.rows||[]));if(!r.rows||all.length>=r.total||r.rows.length<500)break;}
  const fields=['created_at','app_id','game_id','external_user_id','kind','id','status','stake_minor','payout_minor'];
  const csv='\uFEFF'+[fields,...all.map(r=>fields.map(k=>r[k]))].map(row=>row.map(csvCell).join(',')).join('\n');
  const u=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=u;a.download=`reconciliation-${from}-${to}.csv`;a.click();URL.revokeObjectURL(u);
  notify?.(`已导出 ${all.length} 条明细，金额为整数币。`);
 }
 return <section className="panel">
  <div className="panel-head"><h3>对账</h3><div className="table-filters">
   <select aria-label="应用" value={app} onChange={e=>setApp(e.target.value)}><option value="">全部应用</option>{apps.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>
   <select aria-label="游戏" value={game} onChange={e=>setGame(e.target.value)}><option value="">全部游戏</option>{Object.entries(names).map(([id,n])=><option key={id} value={id}>{n}</option>)}</select>
   <input type="date" aria-label="开始日期" value={from} max={to} onChange={e=>setFrom(e.target.value)}/>
   <input type="date" aria-label="结束日期" value={to} min={from} onChange={e=>setTo(e.target.value)}/>
   <label className="input-search"><Search size={15}/><input placeholder="用户 ID" aria-label="用户 ID" value={user} onChange={e=>setUser(e.target.value)}/></label>
   <button className="button" onClick={data.refresh}><RefreshCcw size={15}/>刷新</button>
   <button className="button" onClick={exportAll} disabled={!d?.total}><Download size={15}/>导出明细</button>
  </div></div>
  <ApiState loading={data.loading} error={data.error} refresh={data.refresh} empty={!d} message="暂无数据">{d&&<>
   <div className="stats-grid ledger-stats">
    <Card label="投注次数" value={d.summary.plays.toLocaleString()}/><Card label="玩家数" value={d.summary.players.toLocaleString()}/>
    <Card label="总投注" value={money(d.summary.stake_minor)}/><Card label="总派奖" value={money(d.summary.payout_minor)}/>
    <Card label="平台盈亏（投注−派奖）" value={money(d.summary.net_minor)}/><Card label="返还率" value={rtp(d.summary.stake_minor,d.summary.payout_minor)}/>
    <Card label="钱包扣款 / 加款" value={`${money(d.wallet.debited_minor)} / ${money(d.wallet.credited_minor)}`}/><Card label="未完成（局 / 钱包请求）" value={`${d.summary.open} / ${d.wallet.pending}`}/>
   </div>
   <h4 className="section-gap">按游戏汇总</h4>
   <div className="table-wrap"><table className="data-table"><thead><tr><th>游戏</th><th>投注次数</th><th>玩家</th><th>总投注</th><th>总派奖</th><th>盈亏</th><th>返还率</th><th>未完成</th><th>已作废</th></tr></thead>
    <tbody>{d.games.map(g=><tr key={g.game_id} onClick={()=>setGame(g.game_id)} style={{cursor:'pointer'}}><td>{name(g.game_id)}</td><td>{g.plays.toLocaleString()}</td><td>{g.players}</td><td>{money(g.stake_minor)}</td><td>{money(g.payout_minor)}</td><td>{money(g.net_minor)}</td><td>{rtp(g.stake_minor,g.payout_minor)}</td><td>{g.open}</td><td>{g.voided}</td></tr>)}
     {!d.games.length&&<tr><td colSpan={9} className="empty-state">该范围内没有投注</td></tr>}</tbody></table></div>
   <h4 className="section-gap">明细（共 {d.total.toLocaleString()} 条）</h4>
   <div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>应用</th><th>游戏</th><th>用户</th><th>类型</th><th>状态</th><th>投注</th><th>派奖</th><th>单号</th></tr></thead>
    <tbody>{d.rows.map(r=><tr key={r.kind+r.id}><td>{new Date(r.created_at).toLocaleString()}</td><td>{apps.find(a=>a.id===r.app_id)?.name||r.app_id}</td><td>{name(r.game_id)}</td><td><button className="text-button" onClick={()=>setUser(r.external_user_id)}>{r.external_user_id}</button></td><td>{KIND[r.kind]}</td><td>{STATUS[r.status]||r.status}</td><td>{money(r.stake_minor)}</td><td>{r.payout_minor==null?'—':money(r.payout_minor)}</td><td><code>{r.id}</code></td></tr>)}</tbody></table></div>
   <div className="heading-actions section-gap"><button className="button" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-PAGE))}>上一页</button><span>{d.total?`${offset+1}–${Math.min(offset+PAGE,d.total)}`:'0'} / {d.total}</span><button className="button" disabled={offset+PAGE>=d.total} onClick={()=>setOffset(offset+PAGE)}>下一页</button></div>
  </>}</ApiState>
 </section>;
}
function Card({label,value}){return <div className="stat-card"><div className="stat-top"><span>{label}</span></div><div className="stat-number" style={{fontSize:22}}>{value}</div></div>;}
