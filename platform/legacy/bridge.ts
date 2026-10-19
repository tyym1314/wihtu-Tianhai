/** Authenticated presentation bridge; copied into an isolated build, never loaded by the old demos. */
import {createGameHostBridge} from './host-bridge.mjs';
export let platformConfig: Record<string, any> = {};
let token = '';
const nativeFetch=window.fetch.bind(window);
let gameBridge:any=null,hostState:any={muted:false,voiceActive:false,visible:true,safeArea:{top:0,right:0,bottom:0,left:0}};
const stateListeners=new Set<(state:any)=>void>();
let prepareBack:(()=>{pending?:boolean})|null=null;
export function subscribeHostState(listener:(state:any)=>void){stateListeners.add(listener);listener(hostState);return()=>stateListeners.delete(listener);}
const balanceListeners=new Set<()=>void>();
/** Ask the host App to open its top-up page (balance tapped or not enough coins). */
export function requestHostRecharge(reason:'user'|'insufficient'='user'){gameBridge?.requestRecharge?.(reason);}
/** The host App reports a balance change (e.g. after its top-up page closes). */
export function onHostBalanceRefresh(listener:()=>void){balanceListeners.add(listener);return()=>balanceListeners.delete(listener);}
export function registerPresentationHost(adapter:{prepareBack?:()=>{pending?:boolean}}){prepareBack=adapter.prepareBack||null;}
function hostBack(){
 if(document.querySelector('.oasis-return-dialog'))return;
 const detail=prepareBack?.()||{};
 // Nothing in flight: return immediately instead of asking the player to confirm.
 if(prepareBack&&!detail.pending){gameBridge?.completeReturn({reason:'user',status:'idle'});return;}
 const dialog=document.createElement('dialog');dialog.className='oasis-return-dialog';
 dialog.innerHTML='<h2>返回应用？</h2><p>已提交的游戏结果会保留。返回不会撤销投入或表示已退款；重新进入可继续查询与恢复。</p><div><button data-return="cancel">继续游戏</button><button data-return="confirm">返回应用</button></div>';
 dialog.querySelector('[data-return="cancel"]')!.addEventListener('click',()=>dialog.remove());dialog.querySelector('[data-return="confirm"]')!.addEventListener('click',()=>{gameBridge?.completeReturn({reason:'user',status:detail.pending?'pending':'idle'});dialog.remove();});document.body.append(dialog);dialog.showModal();
}
// Session language (from the App's launch request) seeds each game's own language preference.
function applyLocale(game:string,sessionLocale:unknown){
 const pick=(v:unknown)=>{const l=String(v||'').toLowerCase();return l.startsWith('zh')?'zh':l.startsWith('ar')?'ar':l.startsWith('en')?'en':null;};
 let locale=pick(sessionLocale);
 try{locale??=pick(localStorage.getItem('oasis-locale'));}catch{}
 locale??=pick(navigator.language);if(!locale)return;
 try{localStorage.setItem(game==='thunder'?'tt-language':'golden-tiger:locale',locale);}catch{}
}
async function refreshProfile(game:string){
  const response=await nativeFetch(`/api/play/${game}/config`,{headers:{Authorization:`Bearer ${token}`},credentials:'same-origin'});
  if(!response.ok)throw new Error('无法读取平台游戏配置');
  const supplied=await response.json();platformConfig={...(supplied.config??{}),...supplied};
}
function screen(title:string,message:string,error=false){
  const app=document.querySelector<HTMLDivElement>('#app');if(!app)return;
  app.innerHTML=`<main class="oasis-launch-screen"><div class="oasis-launch-symbol">✦</div><small>OASIS GAME PLATFORM</small><h1>${title}</h1><p></p><span>${error?'请返回合作方平台重新打开游戏。':'正在等待合作方的安全启动授权。'}</span></main>`;
  app.querySelector('p')!.textContent=message;
}
export async function boot(game:'thunder'|'tiger',load:()=>Promise<unknown>){
  const style=document.createElement('style');style.textContent=`html,body{margin:0;background:#081321;color:#f0e2bf;font-family:system-ui,sans-serif}.oasis-launch-screen{min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;box-sizing:border-box;text-align:center;background:radial-gradient(ellipse at top,#184650,#081321 65%)}.oasis-launch-symbol{font-size:64px;color:#e1bc74}.oasis-launch-screen small{letter-spacing:3px;color:#bca977}.oasis-launch-screen h1{font-size:24px}.oasis-launch-screen p{max-width:420px;line-height:1.7;color:#a9c0ce}.oasis-launch-screen span{font-size:12px;color:#698797}[data-action="reset"],[data-action="reset-confirm"],[data-setting="reset"]{display:none!important}`;document.head.append(style);
  screen('正在连接游戏','保留完整人物、画面、音效与演出；余额由接入应用的钱包提供。');
  if(!window.opener&&window.parent===window){screen('请从合作方平台启动','此页面需要合作方完成登录后发送一次性启动码；直接打开链接不会生成试玩账户或金币。',true);return;}
  let loaded=false;
  window.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const original=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
    let route:string|undefined;
    if(original.origin===location.origin){
      if(game==='thunder'&&original.pathname.startsWith('/api/')&&!original.pathname.startsWith('/api/play/'))route=original.pathname.slice('/api/'.length);
      if(game==='tiger'&&original.pathname.startsWith('/api/tiger/'))route=original.pathname.slice('/api/tiger/'.length);
    }
    if(route!==undefined){
      if(route==='reset')return new Response(JSON.stringify({error:{code:'RESET_DISABLED',message:'Platform balances cannot be reset from a game.'}}),{status:403,headers:{'Content-Type':'application/json'}});
      if(route==='round/ack')route='ack';
      const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
      if(!token)throw new Error('Game session is not authorized');
      headers.set('Authorization',`Bearer ${token}`);
      const response=await nativeFetch(`/api/play/${game}/${route}`,{...init,headers,credentials:'same-origin'});
      if(response.status===401)gameBridge?.requestReauth();
      if(response.ok&&['session','spin','ack'].includes(route)){
        const data=await response.clone().json(),state=data.session??data;
        if(state.mathVersion&&state.mathVersion!==(platformConfig.version??platformConfig.mathVersion))await refreshProfile(game);
      }
      return response;
    }
    return nativeFetch(input,init);
  }) as typeof fetch;
  const returnStyle=document.createElement('style');returnStyle.textContent='.oasis-return-dialog{width:min(340px,85vw);box-sizing:border-box;border:1px solid #cead70;border-radius:22px;background:#123839;color:#f7e7c8;padding:26px;font:14px/1.75 system-ui}.oasis-return-dialog::backdrop{background:#041717a8}.oasis-return-dialog h2{margin-top:0}.oasis-return-dialog div{display:flex;gap:10px}.oasis-return-dialog button{flex:1;min-height:44px;border:1px solid #d3b775;background:#e5c17a;color:#173f3d;border-radius:10px}';document.head.append(returnStyle);
  gameBridge=createGameHostBridge({game,onLaunch:async(body:any)=>{
    const response=await nativeFetch('/v1/launch/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});
    const result=await response.json();if(!response.ok||typeof result.access_token!=='string')throw Object.assign(new Error(result.error?.message||result.message||'启动授权未成功'),{code:result.error?.code||result.code});
    if(result.host_origin&&result.host_origin!==body.host_origin||result.game_id&&result.game_id!==game)throw new Error('启动授权与宿主或游戏不匹配');
    token=result.access_token;applyLocale(game,result.locale);await refreshProfile(game);
    if(!loaded){await load();loaded=true;for(const item of document.querySelectorAll('.demo-badge,.desktop-demo'))if(item.textContent?.includes('DEMO'))item.textContent='PLATFORM · APP WALLET';}
    return{host_origin:result.host_origin||body.host_origin,game_id:game,session_id:result.session_id};
  },onState:(state:any)=>{hostState=state;stateListeners.forEach(listener=>listener(state));},onBack:hostBack,onBalanceRefresh:()=>balanceListeners.forEach(listener=>listener()),onError:(error:Error)=>{if(!loaded)screen('暂时无法启动',error.message||'请重新获取启动授权',true);}});
  window.addEventListener('pagehide',()=>{token='';gameBridge?.dispose();stateListeners.clear();},{once:true});
}
