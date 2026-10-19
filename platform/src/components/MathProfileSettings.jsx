import { useEffect, useState } from 'react';
import { ShieldCheck, Save, LoaderCircle } from 'lucide-react';
import { api, useApi } from '../api.js';
import ApiState from './ApiState.jsx';

const TIERS=['99','98','97','96'];
const FAMILY={legacy:'老虎机',slot:'老虎机',wheel:'转盘 / 牌桌',crash:'爆点',arcade:'街机',cards3:'比牌'};

/** App-level return-rate tier (96–99 %) for every probability game of the App. */
export default function MathProfileSettings({apps=[],refreshApps,notify}){
 const [selected,setSelected]=useState(''),[profile,setProfile]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const app=apps.find(a=>a.id===selected)||apps[0],tiers=useApi('/api/admin/rtp-tiers');
 useEffect(()=>{setProfile(app?.math_profile==null?'':String(app.math_profile));setError('');},[app?.id,app?.math_profile]);
 async function save(){
  if(!app||!TIERS.includes(profile)||busy)return;setBusy(true);setError('');
  try{await api(`/api/admin/apps/${encodeURIComponent(app.id)}`,{method:'PATCH',body:{math_profile:profile}});refreshApps?.();notify(`已保存：${app.name} 的概率游戏返还率设为 ${profile}%。新开始的局生效，进行中的局按原版本结算。`);}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 const games=tiers.data?.games||[],current=app?.math_profile==null?null:String(app.math_profile);
 const rate=g=>profile?g.tiers[profile]:g.default;
 return <div className="config-grid"><section className="panel config-form">
  <div className="panel-head"><div><h3>概率游戏返还率</h3><p>按应用设置，对该应用的全部概率游戏生效。</p></div></div>
  {!apps.length?<div className="empty-state">先创建应用，再设置返还率。</div>:<>
   <label className="field">应用<select aria-label="应用" value={app.id} disabled={busy} onChange={e=>setSelected(e.target.value)}>{apps.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
   <div className="rtp-options">{TIERS.map(value=><button className={`rtp-option ${profile===value?'chosen':''}`} key={value} disabled={busy} onClick={()=>setProfile(value)}>
    <div><span className="radio-circle">{profile===value&&<span/>}</span><strong>{value}<small>%</small></strong><span>目标返还率</span></div>
    <p>{value==='99'?'玩家回报最高':value==='96'?'平台收益最高':'—'}</p>{current===value&&<span className="badge">当前</span>}</button>)}</div>
   <div className="math-table"><div><span>当前设置</span><strong>{current?`${current}%`:'默认（各游戏原设计值）'}</strong></div><div><span>当前选择</span><strong>{profile?`${profile}%`:'请选择'}</strong></div><div><span>生效范围</span><strong>保存后新开始的局</strong></div></div>
   {error&&<div className="portal-form-error" role="alert">{error}</div>}
   <button className="button button-primary" onClick={save} disabled={busy||!profile||profile===current}>{busy?<LoaderCircle className="portal-spin" size={16}/>:<Save size={16}/>}保存</button>
  </>}
 </section>
 <section className="panel config-explainer"><span className="eyebrow">EFFECTIVE RETURN BY GAME</span><h3>各游戏实际返还率{profile?`（${profile}% 档）`:'（默认）'}</h3>
  <div className="inline-note"><ShieldCheck size={17}/>转盘 / 牌桌类的倍数印在界面上、每局必有选项中奖，返还率由倍数决定：Greedy 系列最低 97.19%，可上调到 98%、99%；标“固定”的游戏不随档位变化。</div>
  <ApiState loading={tiers.loading} error={tiers.error} refresh={tiers.refresh} empty={!games.length} message="暂无数据">
   <div className="table-wrap"><table className="data-table"><thead><tr><th>游戏</th><th>类型</th><th>返还率</th><th></th></tr></thead>
    <tbody>{games.map(g=><tr key={g.game_id}><td>{g.name||g.game_id}</td><td>{FAMILY[g.family]||g.family}</td><td>{rate(g).toFixed(2)}%</td><td>{g.adjustable?(profile&&rate(g)!==Number(profile)?<span className="badge badge-amber">最接近档位</span>:''):<span className="badge">固定</span>}</td></tr>)}</tbody></table></div>
  </ApiState>
 </section></div>;
}
