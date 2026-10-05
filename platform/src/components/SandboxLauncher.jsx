import {ARENA_GAMES,RELEASED_IDS} from '../../shared/games.mjs';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Play, LoaderCircle } from 'lucide-react';
import { api } from '../api.js';
export default function SandboxLauncher({ apps=[], environment='sandbox', notify=()=>{} }) {
  const [selected,setSelected]=useState(''),[game,setGame]=useState('match'),[player,setPlayer]=useState('demo_player'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const cleanup=useRef(()=>{}),alive=useRef(true); const app=apps.find(item=>item.id===selected)||apps[0]; const allowed=RELEASED_IDS.filter(id=>app?.game_ids?.includes(id));
  useEffect(()=>{if(!apps.some(item=>item.id===selected))setSelected(apps[0]?.id||'');},[apps,selected]);
  useEffect(()=>{if(!allowed.includes(game))setGame(allowed[0]||'tiger');},[app?.id,app?.game_ids?.join(',')]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;cleanup.current();};},[]);
  async function launch(){
    if(busy||environment==='live'||!app||app.status!=='active'||!allowed.includes(game))return;setError('');setMessage('');
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(player.trim())){setError('测试用户 ID 请使用 1–64 位字母、数字、下划线或短横线。');return;}
    const popup=window.open('about:blank',`oasis-play-${Date.now()}`,'popup,width=460,height=880');
    if(!popup){setError('浏览器拦截了游戏窗口。请允许本站弹窗后，再点击启动。');return;}
    cleanup.current();setBusy(true);try{
      const result=await api(`/api/admin/apps/${encodeURIComponent(app.id)}/launch`,{method:'POST',body:{game_id:game,external_user_id:player.trim()}});
      if(!alive.current){popup.close();return;}
      const url=new URL(result.entry_url,location.origin);
      if(url.origin!==location.origin||!RELEASED_IDS.some(id=>url.pathname==='/play/'+id)||url.search||url.hash||typeof result.launch_code!=='string')throw new Error('后台启动响应不符合受限游戏入口约定。');
      let sent=false;let timeout;let closedCheck;
      const dispose=()=>{window.removeEventListener('message',ready);clearTimeout(timeout);clearInterval(closedCheck);};
      const ready=event=>{if(event.source!==popup||event.origin!==location.origin)return;if(event.data?.type==='oasis.ready'&&!sent){sent=true;popup.postMessage({type:'oasis.launch',launch_code:result.launch_code},location.origin);if(alive.current)setMessage('启动码已交给游戏窗口，正在等待会话兑换与资源载入。');}else if(event.data?.type==='oasis.loaded'&&event.data.game_id===game&&sent){dispose();if(alive.current){setBusy(false);setMessage('游戏已完成会话兑换并载入。实际扣款与结算请在游戏及局单中确认。');notify('沙箱游戏已载入，使用真实应用钱包。');}}else if(event.data?.type==='oasis.error'&&event.data.game_id===game&&sent){dispose();if(alive.current){setBusy(false);setError(typeof event.data.message==='string'?event.data.message:'游戏窗口报告启动失败，请检查服务后重试。');}}};
      window.addEventListener('message',ready);cleanup.current=dispose;
      timeout=setTimeout(()=>{dispose();if(alive.current){setBusy(false);setError('游戏窗口未在时限内完成握手，尚未确认启动。检查窗口或服务后重新发起。');}},25000);
      closedCheck=setInterval(()=>{if(popup.closed){dispose();if(alive.current){setBusy(false);setError('游戏窗口已关闭，启动尚未确认。');}}},500);
      popup.location.replace(url.href);setMessage('已申请一次性启动码，正在等待游戏窗口准备。');
    }catch(e){popup.close();if(alive.current){setBusy(false);setError(e.message);}}
  }
  return <section className="panel portal-panel sandbox-launcher"><div className="portal-kicker"><Play size={15}/>SANDBOX LAUNCH</div><h2>启动沙箱第一局</h2><p>使用真实沙箱主钱包。启动码经受限消息通道传递，不放入 URL。</p>{apps.length>1&&<label className="field">测试应用<select value={app?.id||''} disabled={busy} onChange={e=>{setSelected(e.target.value);setMessage('');setError('');}}>{apps.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<label className="field">选择游戏<select value={game} disabled={busy||!allowed.length} onChange={e=>{setGame(e.target.value);setMessage('');}}>{!allowed.length?<option value="tiger">请先授权已开放游戏</option>:allowed.map(id=><option value={id} key={id}>{ARENA_GAMES[id]?.name||{tiger:'虎虎生财',thunder:'雷霆王座'}[id]}</option>)}</select></label><label className="field">测试用户 ID<input list="sandbox-players" value={player} disabled={busy} onChange={e=>setPlayer(e.target.value)} maxLength={64}/><datalist id="sandbox-players">{['demo_player','demo_player_2','demo_player_3','demo_player_4'].map(id=><option key={id} value={id}/>)}</datalist></label><p className="launch-feedback">多人联调：用同一应用依次打开不同测试用户，在游戏内用房间码加入。免费练习可直接体验 BOT 对手。</p><button className="button button-primary button-full" disabled={busy||environment==='live'||app?.status!=='active'||!allowed.length} onClick={launch}>{busy?<LoaderCircle size={15} className="portal-spin"/>:<ExternalLink size={15}/>} {busy?'等待游戏窗口…':'打开沙箱游戏'}</button>{error&&<div className="portal-form-error" role="alert">{error}</div>}{message&&<p className="launch-feedback" role="status">{message}</p>}<small>{app?.status==='paused'?'应用已暂停，请先恢复接入。':'真实沙箱运行，不代表生产发布或 RTP 认证。'}</small></section>;
}
