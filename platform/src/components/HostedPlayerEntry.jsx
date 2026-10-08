import {useEffect,useState} from 'react';
import {ArrowRight,Copy,Globe2} from 'lucide-react';
export default function HostedPlayerEntry({app,walletMode,notify}){
 const [error,setError]=useState('');
 useEffect(()=>setError(''),[app.id]);
 if(app.environment!=='production'||walletMode!=='platform')return null;
 const url=new URL('/player',location.origin);url.searchParams.set('app_id',app.id);
 return <section className="panel portal-panel hosted-player-entry" data-testid="hosted-player-entry"><div className="portal-kicker"><Globe2 size={15}/>PLAYER ACCESS</div><h2>平台玩家入口</h2><p>玩家使用自己的账号注册或登录。新账号余额为零，免费练习不会发放测试币。</p><label className="field">玩家登录地址<input readOnly value={url.href}/></label><button className="button" onClick={async()=>{try{await navigator.clipboard.writeText(url.href);setError('');notify('玩家登录地址已复制。');}catch{setError('剪贴板不可用，请手动复制地址。');}}}><Copy size={15}/>复制玩家地址</button>{app.status==='active'?<a className="button button-primary" href={url.href} target="_blank" rel="noreferrer">打开玩家入口<ArrowRight size={15}/></a>:<p>应用已暂停；启用后玩家才能进入游戏。</p>}{error&&<p role="alert">{error}</p>}</section>;
}
