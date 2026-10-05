import './style.css';
import { TigerCharacter } from './character';
import { TigerEffects, TigerReels, symbolMarkup, wait } from './effects';
import { GameAudio } from './audio';
import { AutoPlay, AUTO_PLAY_COUNTS } from './autoplay';
import { copies, symbolNames, type Locale, type CopyKey } from './copy';
import { TIGER_CONFIG } from './math';
import type { TigerSession, TigerDemoRound, TigerSymbol, TigerStep } from './types';

const pref=(key:string,fallback:string)=>{try{return localStorage.getItem('golden-tiger:'+key)??fallback;}catch{return fallback;}};
const save=(key:string,value:string)=>{try{localStorage.setItem('golden-tiger:'+key,value);}catch{}};
let locale:Locale=['zh','en','ar'].includes(pref('locale','zh'))?pref('locale','zh') as Locale:'zh';
const t=(key:CopyKey)=>copies[locale][key];
const num=(v:number)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v);
const id=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
const icon=(name:string)=>{const p:Record<string,string>={
  spin:'<path d="M19 8a8 8 0 1 0 1 7M20 3v6h-6"/>',auto:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/><path d="m10 8 6 4-6 4z"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',bolt:'<path d="m13 2-8 12h7l-1 8 8-13h-7z"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',sound:'<path d="m10 5-5 4H2v6h3l5 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',mute:'<path d="m10 5-5 4H2v6h3l5 4zM16 9l6 6m0-6-6 6"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',history:'<path d="M3 10a9 9 0 1 1 2 8M3 3v7h7M12 7v5l3 2"/>',book:'<path d="M12 5c-3-2-7-2-10 0v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Zm0 0v15"/>',settings:'<path d="M5 4v16m7-16v16m7-16v16M2 8h6m1 8h6m1-9h6"/>',plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',chevron:'<path d="m8 5 7 7-7 7"/>',diamond:'<path d="m3 8 4-5h10l4 5-9 13zM3 8h18M7 3l5 18 5-18"/>'};return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p[name]||p.spin}</svg>`;};
document.querySelector('#app')!.innerHTML=`
  <div class="lounge" aria-hidden="true"><i></i><i></i></div>
  <main class="tiger-experience">
    <aside class="editorial"><span class="edition-label"><i></i> THE FORTUNE COLLECTION</span><span class="edition-number">02 / GOLDEN TIGER</span><h1>GOOD<br>FORTUNE.<br><em>GREAT<br>FEELING.</em></h1><div class="editorial-rule"></div><p>一触好运 · 满屏生财</p><span class="edition-detail">3 × 3 REELS &nbsp; / &nbsp; FORTUNE RESPINS</span><div class="edition-stamp">福<span>A LITTLE LUCK.<br>A LOT OF CHARACTER.</span></div><span class="editorial-foot">INDEPENDENT DEMO EXPERIENCE</span></aside>
    <section class="tiger-game" aria-label="Golden Tiger">
      <div class="scene-light" aria-hidden="true"></div>
      <header class="tiger-hero">
        <nav class="topbar"><span class="demo-pill" data-copy="demo"></span><div><button class="language-button" data-action="language" aria-label="语言"></button><button class="icon-button sound-button" data-action="sound" aria-label="声音">${icon('sound')}</button></div></nav>
        <div class="hero-sun" aria-hidden="true"></div><div class="hero-particles" aria-hidden="true"><i>✧</i><i>✦</i><i>✧</i><i>✦</i></div>
        <div class="tiger-logo"><span class="logo-small">GOLDEN</span><strong data-copy="title">虎虎生财</strong><span class="logo-english">T I G E R</span><span class="logo-flourish">◆ ━━━ ◆</span></div>
        <div class="tiger-stage" aria-hidden="true"></div>
        <button class="music-status" data-action="music-start"><span class="equalizer"><i></i><i></i><i></i></span><span id="music-state"></span></button>
      </header>
      <section class="reel-stage" aria-label="3×3 game board">
        <div class="roof-ornament" aria-hidden="true"><span>✦</span><i></i><b>福</b><i></i><span>✦</span></div>
        <div class="reel-frame"><div class="frame-corner tl"></div><div class="frame-corner tr"></div><div class="frame-corner bl"></div><div class="frame-corner br"></div>
          <div id="tiger-reels" dir="ltr"></div>
          <svg class="paylines" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden="true"><defs><filter id="line-glow"><feGaussianBlur stdDeviation="2"/></filter><linearGradient id="win-line"><stop stop-color="#fff9b0"/><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#fff9b0"/></linearGradient></defs><g id="line-paths"></g></svg>
          <div class="board-shine" aria-hidden="true"></div><div class="respin-ribbon" hidden><span></span><b></b></div>
        </div>
        <div class="frame-plinth" aria-hidden="true"><span>◆</span><i></i><span>◆</span></div>
      </section>
      <div class="message-bar" role="status" aria-live="polite"><i>✦</i><span id="game-message"></span><i>✦</i></div>
      <section class="control-panel">
        <div class="wallet-row"><div class="wallet-cell"><span data-copy="balance"></span><strong id="balance" dir="ltr">—</strong></div><div class="wallet-cell bet-cell"><span data-copy="bet"></span><button id="bet-value" data-action="bet" dir="ltr">100</button></div><div class="wallet-cell win-cell"><span data-copy="win"></span><strong id="win-value" dir="ltr">0</strong></div></div>
        <div class="spin-row"><button class="side-control turbo-button" data-action="turbo">${icon('bolt')}<span data-copy="turbo"></span></button><button class="bet-step" data-action="minus" aria-label="减少投入">${icon('minus')}</button><button class="tiger-spin" id="spin" aria-label="旋转" disabled><span class="spin-orbit"></span><span class="spin-groove"></span><span class="spin-disc">${icon('spin')}</span><span class="spin-word" data-copy="spin"></span></button><button class="bet-step" data-action="plus" aria-label="增加投入">${icon('plus')}</button><button class="side-control auto-button" data-action="auto"><span class="auto-icon">${icon('auto')}</span><span class="auto-label" data-copy="auto"></span></button></div>
        <div class="auto-progress" hidden><span></span><button data-action="auto-stop">${icon('stop')}</button></div>
        <nav class="utility-row"><button data-action="rules">${icon('book')}<span data-copy="rules"></span></button><button data-action="history">${icon('history')}<span data-copy="history"></span></button><button data-action="settings">${icon('settings')}<span data-copy="settings"></span></button></nav>
        <footer><span id="connection-dot"></span><span data-copy="demoNote"></span></footer>
      </section>
      <canvas id="tiger-fx" aria-hidden="true"></canvas>
      <div class="full-board-burst" aria-hidden="true"><div class="burst-rays"></div><strong>×10</strong><span data-copy="full"></span></div>
      <section class="celebration" hidden aria-label="中奖演出"><div class="celebration-rays"></div><div class="celebration-inner"><span class="celebration-note"></span><div class="celebration-crown">${symbolMarkup('ingot')}</div><h2 class="celebration-title"></h2><div class="celebration-divider">✦ ━━━━━ ✦</div><strong class="celebration-amount" dir="ltr"></strong><span class="celebration-multiple"></span><button class="gold-button" id="continue" data-copy="continue"></button><button class="celebration-stop" data-action="auto-stop" hidden></button></div></section>
      <div class="toast" role="status"></div>
    </section>
    <aside class="side-caption"><span>FORTUNE FAVOURS THE PLAYFUL</span><i>✦</i></aside>
  </main>
  <dialog id="tiger-panel"><header><div><span class="panel-eyebrow">GOLDEN TIGER</span><h2 id="panel-title"></h2></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></header><div id="panel-body"></div></dialog>
`;
const $=<T extends HTMLElement=HTMLElement>(s:string)=>document.querySelector<T>(s)!;
const game=$('.tiger-game');const dialog=$<HTMLDialogElement>('#tiger-panel');const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const audio=new GameAudio(pref('sound','true')==='true');audio.setMusicEnabled(pref('music','true')==='true');audio.setSfxEnabled(pref('sfx','true')==='true');audio.setMusicVolume(Number(pref('music-volume','.65')));audio.setSfxVolume(Number(pref('sfx-volume','.9')));
const character=new TigerCharacter($('.tiger-stage'));
const reels=new TigerReels($('#tiger-reels'),s=>symbolNames[locale][s]);const fx=new TigerEffects($<HTMLCanvasElement>('#tiger-fx'),game);
let session:TigerSession|null=null;let bet=100;let displayBalance=0;let lastWin=0;let busy=false;let previewing=false;let turbo=pref('turbo','false')==='true';let connected=false;let retryId:string|null=null;let retryBet=100;let toastTimer:ReturnType<typeof setTimeout>;
let currentWinClose:(()=>void)|null=null;let countGeneration=0;
const autoplay=new AutoPlay({getState:()=>({freeSpins:0,canPlay:!!session&&connected&&!previewing&&!retryId&&!session.pendingRound&&session.balance>=bet&&!document.hidden}),play:()=>spin(true),onChange:()=>updateUI(),betweenRounds:()=>wait(turbo?280:650)});
function message(text:string){$('#game-message').textContent=text;}
function toast(text:string){$('.toast').textContent=text;$('.toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('.toast').classList.remove('visible'),2800);}
function audioUI(){const state=audio.getStatus();const playing=state.music.playing;$('#music-state').textContent=!audio.enabled?t('musicOff'):state.state==='unavailable'?t('unavailable'):playing?t('musicOn'):t('musicTap');$('.music-status').classList.toggle('playing',playing);$('.sound-button').innerHTML=icon(audio.enabled?'sound':'mute');$('.sound-button').setAttribute('aria-pressed',String(audio.enabled));}
async function unlock(){await audio.unlock();audioUI();}
function updateUI(){
  document.documentElement.lang=locale==='zh'?'zh-CN':locale;game.setAttribute('data-locale',locale);dialog.dir=locale==='ar'?'rtl':'ltr';
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(el=>el.textContent=t(el.dataset.copy as CopyKey));
  $('.language-button').textContent=locale==='zh'?'中':locale==='en'?'EN':'ع';
  $('#balance').textContent=session?num(displayBalance):'—';$('#bet-value').textContent=num(bet);$('#win-value').textContent=num(lastWin);
  const spin=$<HTMLButtonElement>('#spin');spin.disabled=busy||previewing||autoplay.active||!session||!connected;
  spin.setAttribute('aria-label',busy?t('spinning'):session?.pendingRound?t('restored'):t('spin'));$('.spin-word').textContent=busy?t('spinning'):t('spin');
  game.classList.toggle('is-spinning',busy);game.classList.toggle('auto-active',autoplay.active);$('.turbo-button').classList.toggle('active',turbo);$('.turbo-button').setAttribute('aria-pressed',String(turbo));
  $('.auto-button').setAttribute('aria-pressed',String(autoplay.active));$('.auto-icon').innerHTML=icon(autoplay.active?'stop':'auto');$('.auto-label').textContent=autoplay.active?t('stop'):t('auto');
  $<HTMLButtonElement>('.auto-button').disabled=(busy&&!autoplay.active&&!autoplay.inFlight)||previewing||!session||!connected;
  const locked=busy||previewing||autoplay.active||autoplay.inFlight||!!session?.pendingRound||!!retryId||!session;
  ['minus','plus','bet'].forEach(action=>$<HTMLButtonElement>(`[data-action="${action}"]`).disabled=locked);
  if(session){$<HTMLButtonElement>('[data-action="minus"]').disabled ||= bet===session.betChoices[0];$<HTMLButtonElement>('[data-action="plus"]').disabled ||= bet===session.betChoices.at(-1);}
  $('.language-button').setAttribute('aria-label',t('language'));$('.sound-button').setAttribute('aria-label',t('sound'));$('.auto-progress button').setAttribute('aria-label',t('stop'));
  $('[data-action="minus"]').setAttribute('aria-label',t('less'));$('[data-action="plus"]').setAttribute('aria-label',t('more'));$('[data-action="close"]').setAttribute('aria-label',t('close'));
  $('.auto-progress').hidden=!(autoplay.active||autoplay.inFlight);$('.auto-progress span').textContent=autoplay.active?`${t('auto')} · ${t('remaining')} ${autoplay.remaining}`:t('finishRound');
  $('.celebration-stop').hidden=!autoplay.active;$('.celebration-stop').textContent=t('finishRound');$('#connection-dot').classList.toggle('online',connected);audioUI();
}
class ApiError extends Error{constructor(public code:string,message:string){super(message);}}
async function api<T>(path:string,body?:unknown):Promise<T>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
  try{const res=await fetch(`/api/tiger/${path}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});const result=await res.json();if(!res.ok)throw new ApiError(result.error?.code||'HTTP_ERROR',result.error?.message||'Request failed');return result as T;}finally{clearTimeout(timer);}
}
async function connect(){
  message(t('loading'));try{session=await api<TigerSession>('session');displayBalance=session.balance;connected=true;if(!session.betChoices.includes(bet))bet=session.betChoices[0];if(session.pendingRound){bet=session.pendingRound.bet;retryId=null;}message(session.pendingRound?t('restored'):t('ready'));updateUI();}catch{connected=false;message(t('offline'));$('#game-message').insertAdjacentHTML('beforeend',` <button data-action="retry">${t('retry')}</button>`);updateUI();}
}
async function spin(fromAuto=false):Promise<{isFreeSpin:boolean}|null>{
  if(busy||previewing||!session||!connected||(!fromAuto&&autoplay.active))return null;
  if(!session.pendingRound&&session.balance<bet){toast(t('noFunds'));autoplay.stop();return null;}
  busy=true;lastWin=0;reels.clearWin();$('#line-paths').innerHTML='';message(t('spinning'));updateUI();
  try{
    await unlock();if(fromAuto&&(!autoplay.active||document.hidden))return null;
    character.react('spin');audio.spin();
    let round:TigerDemoRound,finalSession:TigerSession;
    if(session.pendingRound){round=session.pendingRound;finalSession=session;}
    else{const requestId=retryId??id();const requestBet=retryId?retryBet:bet;retryId=requestId;retryBet=requestBet;const result=await api<{session:TigerSession;round:TigerDemoRound}>('spin',{requestId,bet:requestBet,expectedVersion:session.stateVersion});round=result.round;finalSession=result.session;retryId=null;}
    if(round.epoch!==finalSession.epoch){session=finalSession;displayBalance=session.balance;autoplay.stop();message(t('recovered'));return null;}
    displayBalance=round.balanceBefore-round.bet;updateUI();
    await playRound(round,fromAuto);
    session=finalSession;displayBalance=session.balance;lastWin=round.win;
    try{session=(await api<{session:TigerSession}>('ack',{roundId:round.id})).session;}catch{autoplay.stop();toast(t('restored'));}
    displayBalance=session.balance;
    if(session.epoch!==finalSession.epoch||session.stateVersion!==finalSession.stateVersion){autoplay.stop();lastWin=0;message(t('recovered'));return null;}
    if(session.pendingRound){autoplay.stop();message(t('restored'));return null;}
    return {isFreeSpin:false};
  }catch(error){
    autoplay.stop();if(error instanceof ApiError&&!['INTERNAL_ERROR','HTTP_ERROR'].includes(error.code))retryId=null;
    try{session=await api<TigerSession>('session');displayBalance=session.balance;connected=true;if(session.pendingRound){retryId=null;bet=session.pendingRound.bet;message(t('restored'));}else message(error instanceof ApiError&&/INSUFFICIENT/.test(error.code)?t('noFunds'):t('recovered'));}catch{connected=false;message(t('offline'));$('#game-message').insertAdjacentHTML('beforeend',` <button data-action="retry">${t('retry')}</button>`);}
    return null;
  }finally{busy=false;game.classList.remove('feature-mode');$('.respin-ribbon').hidden=true;updateUI();}
}
function drawLines(step:TigerStep){
  $('#line-paths').innerHTML=step.lineWins.map((line,i)=>{const d=line.indices.map((idx,j)=>`${j?'L':'M'}${(idx%3)*100+50},${Math.floor(idx/3)*100+50}`).join(' ');return `<path d="${d}" class="payline-glow"/><path d="${d}" class="payline" style="animation-delay:${i*80}ms"/>`;}).join('');
}
async function playRound(round:TigerDemoRound,fromAuto:boolean){
  let previousLocked:number[]=[];
  for(const [i,step] of round.engine.steps.entries()){
    if(i>0){game.classList.add('feature-mode');$('.respin-ribbon').hidden=false;$('.respin-ribbon span').textContent=t('respin');$('.respin-ribbon b').textContent=String(i);message(t('lockTip'));character.react('respin');audio.scatter();fx.flash(.5);await wait(turbo?200:500);audio.spin();}
    $('#line-paths').innerHTML='';
    await reels.spin(step.board,previousLocked,turbo,col=>{audio.land();if(col===1&&previousLocked.length>=5)character.react('anticipation');});
    reels.highlight(step.winningIndices,step.lockedIndices,step.addedIndices);drawLines(step);
    if(step.winningIndices.length){audio.win('small');fx.burstCells(step.addedIndices.length?step.addedIndices:step.winningIndices);character.react('win');}
    previousLocked=step.lockedIndices;
    if(i<round.engine.steps.length-1)await wait(turbo?420:900);
  }
  $('.respin-ribbon').hidden=true;game.classList.remove('feature-mode');
  if(round.engine.fullBoard){character.react('big');await fullBoardEffect();}
  if(round.win>0){character.react(round.win>=round.bet*10?'big':'win');fx.burstCells(round.engine.steps.at(-1)!.winningIndices);if(round.win>=round.bet*10||round.engine.fullBoard)await celebrate(round.win,round.bet,false,fromAuto);else{audio.win('small');await animateNumber($('#win-value'),0,round.win,turbo?400:800);}}
  lastWin=round.win;displayBalance=round.balanceAfter;updateUI();
  message(round.win>0?`${t('return')} ${num(round.win)} · ${t('net')} ${round.win>=round.bet?'+':''}${num(round.win-round.bet)}`:t('welcome'));
}
async function animateNumber(el:HTMLElement,from:number,to:number,duration:number){const generation=++countGeneration;if(reduced.matches){el.textContent=num(to);return;}const start=performance.now();await new Promise<void>(resolve=>{const frame=(now:number)=>{if(generation!==countGeneration){resolve();return;}const p=Math.min(1,(now-start)/duration);el.textContent=num(from+(to-from)*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(frame);else resolve();};requestAnimationFrame(frame);});}
async function fullBoardEffect(){game.classList.add('full-board-active');audio.scatter();fx.flash(1.3);fx.rain(2500);await wait(reduced.matches?250:1550);game.classList.remove('full-board-active');}
async function celebrate(amount:number,stake:number,isPreview:boolean,fromAuto=false){
  const panel=$('.celebration');panel.hidden=false;panel.classList.add('enter');$('.celebration-note').textContent=isPreview?t('previewNote'):t('total');$('.celebration-title').textContent=amount/stake>=50?t('huge'):amount/stake>=20?t('mega'):t('big');$('.celebration-multiple').textContent=`${num(amount/stake)}× ${t('bet')}`;
  $('.celebration-stop').hidden=!autoplay.active;$('.celebration-stop').textContent=t('finishRound');
  character.react('big');audio.win('big');fx.rain(6000);fx.flash(.8);
  const dismissed=new Promise<void>(resolve=>{currentWinClose=resolve;});
  const counting=animateNumber($('.celebration-amount'),0,amount,reduced.matches?0:fromAuto?1700:2400);
  await Promise.race([fromAuto?counting.then(()=>wait(1100)):counting.then(()=>dismissed),dismissed]);
  countGeneration++;$('.celebration-amount').textContent=num(amount);currentWinClose=null;panel.hidden=true;panel.classList.remove('enter');fx.stopRain();
}
function openPanel(title:string,html:string){$('#panel-title').textContent=title;$('#panel-body').innerHTML=html;dialog.dir=locale==='ar'?'rtl':'ltr';if(!dialog.open)dialog.showModal();$('#panel-body').scrollTop=0;}
function showBet(){if(busy||autoplay.active||retryId||session?.pendingRound||!session)return;openPanel(t('chooseBet'),`<p class="panel-subtitle">${t('bet')}</p><div class="bet-options">${session.betChoices.map(v=>`<button data-bet="${v}" class="${bet===v?'selected':''}">${num(v)}</button>`).join('')}</div>`);}
function showAuto(){if(autoplay.active||autoplay.inFlight){autoplay.stop();toast(t('autoStop'));return;}if(busy||previewing||!session)return;openPanel(t('chooseAuto'),`<p class="panel-subtitle">${t('autoNote')}</p><div class="auto-options">${AUTO_PLAY_COUNTS.map((n,i)=>`<button data-count="${n}" class="${i===0?'selected':''}" aria-pressed="${i===0}">${n}</button>`).join('')}</div><div class="auto-summary"><span>${t('bet')}</span><strong>${num(bet)}</strong></div><button class="gold-button full-width" data-action="auto-start">${t('startAuto')}</button>`);}
function showRules(){const config=TIGER_CONFIG;openPanel(t('rules'),`<div class="rule-hero"><div>${symbolMarkup('tiger')}</div><h3>GOLDEN TIGER</h3><p>${t('ruleText')}</p></div><div class="payline-diagram" aria-label="5 paylines">${config.paylines.map((line:readonly number[],i:number)=>`<div><span>${i+1}</span><svg viewBox="0 0 90 90">${Array.from({length:9},(_,j)=>`<rect x="${j%3*30+2}" y="${Math.floor(j/3)*30+2}" width="26" height="26" rx="5" fill="${line.includes(j)?'#e0ae4b':'#eee3d0'}"/>`).join('')}<path d="${line.map((j:number,k:number)=>`${k?'L':'M'}${j%3*30+15} ${Math.floor(j/3)*30+15}`).join(' ')}" stroke="#b73024" stroke-width="4" fill="none"/></svg></div>`).join('')}</div><h3>${t('paytable')}</h3><div class="paytable">${config.symbols.map(s=>`<div><span class="pay-symbol">${symbolMarkup(s.id)}</span><span>${symbolNames[locale][s.id]}</span><b>${String(s.payoutBps/10000)}×</b></div>`).join('')}</div><h3>${t('respin')}</h3><p>${t('featureText')}</p><h3>${t('full')} ×10</h3><p>${t('fullText')}</p><p class="muted-note">${t('mathText')}</p>`);}
async function showHistory(){try{const {rounds}=await api<{rounds:TigerDemoRound[]}>('history');openPanel(t('history'),rounds.length?`<div class="history-list">${rounds.map(r=>`<article><div><b>${new Date(r.createdAt).toLocaleTimeString('en-GB')}</b><span>${t('bet')} ${num(r.bet)}${r.engine.respinCount?` · ${t('respin')} ${r.engine.respinCount}`:''}</span></div><div class="${r.win>r.bet?'positive':''}"><strong>${num(r.win)}</strong><small>${t('net')} ${r.win>=r.bet?'+':''}${num(r.win-r.bet)}</small></div></article>`).join('')}</div>`:`<p class="empty">${t('empty')}</p>`);}catch{toast(t('offline'));}}
const soundSwitch=(key:string,label:string,on:boolean)=>`<div class="settings-row"><label>${label}</label><button data-toggle="${key}" class="toggle ${on?'on':''}" role="switch" aria-label="${label}" aria-checked="${on}"><i></i></button></div>`;
function showSettings(){openPanel(t('settings'),`${soundSwitch('sound',t('muted'),audio.enabled)}${soundSwitch('music',t('music'),audio.musicEnabled)}<label class="range-row" for="music-volume">${t('volume')}<output>${Math.round(audio.musicVolume*100)}%</output><input id="music-volume" data-volume="music" type="range" min="0" max="100" step="5" value="${audio.musicVolume*100}" aria-label="${t('music')} ${t('volume')}"></label>${soundSwitch('sfx',t('sfx'),audio.sfxEnabled)}<label class="range-row" for="sfx-volume">${t('volume')}<output>${Math.round(audio.sfxVolume*100)}%</output><input id="sfx-volume" data-volume="sfx" type="range" min="0" max="100" step="5" value="${audio.sfxVolume*100}" aria-label="${t('sfx')} ${t('volume')}"></label><button class="outline-button" data-action="sound-test">${icon('sound')}${t('soundTest')}</button>${soundSwitch('turbo',t('turbo'),turbo)}<div class="settings-row"><label for="locale-choice">${t('language')}</label><select id="locale-choice"><option value="zh" ${locale==='zh'?'selected':''}>中文</option><option value="en" ${locale==='en'?'selected':''}>English</option><option value="ar" ${locale==='ar'?'selected':''}>العربية</option></select></div><h3>${t('preview')}</h3><div class="preview-buttons"><button data-preview="big" ${busy||autoplay.active?'disabled':''}>${t('winPreview')}</button><button data-preview="full" ${busy||autoplay.active?'disabled':''}>${t('fullPreview')}</button></div><p class="muted-note">${t('previewNote')}</p><button class="outline-button" data-action="reset" ${busy||autoplay.active||session?.pendingRound?'disabled':''}>${t('reset')}</button><p class="muted-note">${t('mathText')}</p>`);}
async function preview(kind:string){if(busy||previewing||autoplay.active)return;previewing=true;dialog.close();updateUI();const old=[...reels.board];try{await unlock();if(kind==='full'){const board:TigerSymbol[]=Array(9).fill('ingot');character.react('anticipation');audio.spin();await reels.spin(board,[],false,()=>audio.land());reels.highlight([0,1,2,3,4,5,6,7,8]);await fullBoardEffect();}await celebrate(kind==='full'?10000:2500,100,true);}finally{reels.render(old);previewing=false;updateUI();}}
function changeBet(delta:number){if(!session||busy||autoplay.active||retryId||session.pendingRound)return;const next=session.betChoices[Math.max(0,Math.min(session.betChoices.length-1,session.betChoices.indexOf(bet)+delta))];bet=next;updateUI();}
document.addEventListener('click',async event=>{
  if(!(event.target instanceof Element))return;const el=event.target.closest<HTMLButtonElement>('button');if(!el||el.disabled)return;
  if(el.id==='spin'){void spin();return;}if(el.id==='continue'){currentWinClose?.();return;}
  if(el.dataset.bet){bet=Number(el.dataset.bet);dialog.close();updateUI();return;}
  if(el.dataset.count){dialog.querySelectorAll('[data-count]').forEach(b=>{b.classList.toggle('selected',b===el);b.setAttribute('aria-pressed',String(b===el));});return;}
  if(el.dataset.preview){void preview(el.dataset.preview);return;}
  if(el.dataset.toggle){const key=el.dataset.toggle;if(key==='sound'){audio.setEnabled(!audio.enabled);save('sound',String(audio.enabled));}if(key==='music'){audio.setMusicEnabled(!audio.musicEnabled);save('music',String(audio.musicEnabled));}if(key==='sfx'){audio.setSfxEnabled(!audio.sfxEnabled);save('sfx',String(audio.sfxEnabled));}if(key==='turbo'){turbo=!turbo;save('turbo',String(turbo));}await unlock();updateUI();showSettings();return;}
  const action=el.dataset.action;if(action!=='sound')audio.click();
  if(action==='close')dialog.close();if(action==='rules')showRules();if(action==='bet')showBet();if(action==='history')void showHistory();if(action==='settings')showSettings();if(action==='minus')changeBet(-1);if(action==='plus')changeBet(1);if(action==='auto')showAuto();if(action==='retry')void connect();
  if(action==='auto-start'){const count=Number(dialog.querySelector<HTMLButtonElement>('[data-count].selected')?.dataset.count||10);dialog.close();await unlock();void autoplay.start(count).catch(()=>toast(t('offline')));}
  if(action==='auto-stop'){autoplay.stop();toast(t('autoStop'));}
  if(action==='turbo'){turbo=!turbo;save('turbo',String(turbo));updateUI();}
  if(action==='sound'){audio.setEnabled(!audio.enabled);save('sound',String(audio.enabled));await unlock();updateUI();}
  if(action==='music-start'){audio.setEnabled(true);audio.setMusicEnabled(true);if(!audio.musicVolume)audio.setMusicVolume(.65);save('sound','true');save('music','true');save('music-volume',String(audio.musicVolume));await unlock();updateUI();}
  if(action==='language'){locale=locale==='zh'?'en':locale==='en'?'ar':'zh';save('locale',locale);updateUI();if(!busy&&!previewing){reels.render(reels.board);message(t('ready'));}}
  if(action==='sound-test'){audio.setEnabled(true);audio.setSfxEnabled(true);if(!audio.sfxVolume)audio.setSfxVolume(.9);save('sound','true');save('sfx','true');save('sfx-volume',String(audio.sfxVolume));await unlock();audio.win('big');showSettings();updateUI();}
  if(action==='reset'&&!busy&&!autoplay.active&&!session?.pendingRound)openPanel(t('reset'),`<p class="panel-subtitle">${t('resetConfirm')}</p><button class="gold-button full-width" data-action="reset-confirm">${t('reset')}</button>`);
  if(action==='reset-confirm'&&!busy&&!autoplay.active&&!session?.pendingRound){el.disabled=true;try{session=(await api<{session:TigerSession}>('reset',{requestId:id()})).session;displayBalance=session.balance;lastWin=0;retryId=null;connected=true;dialog.close();toast(t('success'));message(t('ready'));updateUI();}catch{toast(t('offline'));el.disabled=false;}}
});
dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
document.addEventListener('input',event=>{const el=event.target;if(!(el instanceof HTMLInputElement)||!el.dataset.volume)return;const key=el.dataset.volume;const value=Number(el.value)/100;if(key==='music')audio.setMusicVolume(value);else audio.setSfxVolume(value);save(`${key}-volume`,String(value));el.parentElement!.querySelector('output')!.textContent=`${Math.round(value*100)}%`;audioUI();});
document.addEventListener('change',event=>{const el=event.target;if(el instanceof HTMLSelectElement&&el.id==='locale-choice'){locale=el.value as Locale;save('locale',locale);updateUI();if(!busy&&!previewing){reels.render(reels.board);message(t('ready'));}showSettings();}});
document.addEventListener('pointerdown',event=>{if(event.target instanceof Element&&event.target.closest('[data-action="sound"],[data-toggle="sound"],[data-toggle="music"],[data-toggle="sfx"]'))return;void unlock();},{capture:true,passive:true});
document.addEventListener('keydown',event=>{if(event.code==='Space'&&!dialog.open&&!(event.target instanceof HTMLInputElement)&&!(event.target instanceof HTMLButtonElement)){event.preventDefault();void spin();}});
document.addEventListener('visibilitychange',()=>{game.classList.toggle('paused',document.hidden);if(document.hidden)autoplay.stop();setTimeout(audioUI,150);});
window.addEventListener('pagehide',()=>{autoplay.stop();character.dispose();reels.dispose();fx.dispose();audio.dispose();});
updateUI();void connect();
