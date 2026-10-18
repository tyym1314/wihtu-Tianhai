/** Casino audio: looping background music + low-latency sound effects, unlocked by the first touch. */
import {useEffect,useRef,useState} from 'react';
import {registerHostControls} from './client.mjs';

const KEY='oasis-casino-muted';
const url=n=>`/casino/audio/${n}.mp3?v=${__ASSET_VERSION__}`;
class CasinoAudio{
 constructor(game){this.game=game;this.muted=localStorage.getItem(KEY)==='1';this.host={muted:false,visible:true,voiceActive:false};this.buffers=new Map();this.ctx=null;this.music=null;}
 unlock(){
  if(!this.ctx){try{const C=window.AudioContext||window.webkitAudioContext;this.ctx=new C();this.gain=this.ctx.createGain();this.gain.connect(this.ctx.destination);}catch{return;}}
  if(this.ctx.state==='suspended')this.ctx.resume().catch(()=>{});
  if(!this.music){this.music=new Audio(url(`music-${this.game}`));this.music.loop=true;this.music.preload='auto';window.__casinoMusic=this.music;}
  this.apply();
 }
 level(){return this.muted||this.host.muted||!this.host.visible?0:this.host.voiceActive?0.25:1;}
 apply(){
  const l=this.level();if(this.gain)this.gain.gain.value=l;
  if(this.music){this.music.volume=0.32*l;if(l>0&&this.music.paused)this.music.play().catch(()=>{});else if(l===0&&!this.music.paused)this.music.pause();}
 }
 async buffer(name){
  if(this.buffers.has(name))return this.buffers.get(name);
  const p=fetch(url(`sfx-${name}`)).then(r=>r.arrayBuffer()).then(b=>this.ctx.decodeAudioData(b)).catch(()=>null);this.buffers.set(name,p);return p;
 }
 preload(names){if(this.ctx)names.forEach(n=>this.buffer(n));}
 async play(name,{volume=1,rate=1}={}){
  if(!this.ctx||this.level()===0)return;const b=await this.buffer(name);if(!b)return;
  const s=this.ctx.createBufferSource(),g=this.ctx.createGain();s.buffer=b;s.playbackRate.value=rate;g.gain.value=volume;s.connect(g).connect(this.gain);s.start();
 }
 setMuted(m){this.muted=m;localStorage.setItem(KEY,m?'1':'0');this.apply();}
 setHost(s){this.host={...this.host,...s};this.apply();}
 dispose(){this.music?.pause();this.ctx?.close().catch(()=>{});}
}

/** React hook: one audio engine per game; unlocks on the first pointer event. */
export function useAudio(game,preload=[]){
 const ref=useRef(null);if(!ref.current)ref.current=new CasinoAudio(game);
 const [muted,setMuted]=useState(ref.current.muted);
 useEffect(()=>{const a=ref.current;
  const unlock=()=>{a.unlock();a.preload(preload);};
  window.addEventListener('pointerdown',unlock,{passive:true});
  const vis=()=>a.setHost({visible:document.visibilityState==='visible'});document.addEventListener('visibilitychange',vis);
  const off=registerHostControls({onState:s=>a.setHost({muted:!!s.muted,visible:s.visible!==false,voiceActive:!!s.voiceActive})});
  return()=>{window.removeEventListener('pointerdown',unlock);document.removeEventListener('visibilitychange',vis);off();a.dispose();};
 },[]);
 return {play:(n,o)=>ref.current.play(n,o),muted,toggle:()=>{const m=!ref.current.muted;ref.current.setMuted(m);setMuted(m);}};
}
