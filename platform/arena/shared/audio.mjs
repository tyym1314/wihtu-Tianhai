/** Gesture-unlocked, bounded WebAudio score and event sounds; no remote media. */
export class ArenaAudio {
  constructor(theme='match') {this.disposed=false;this.unlocked=false;this.pendingResume=null;this.theme=theme;this.hostMuted=false;this.hostVisible=true;this.hostVoiceActive=false;this.onHostState=e=>{const s=e.detail||{};this.hostMuted=s.muted===true;this.hostVisible=s.visible!==false;this.hostVoiceActive=s.voiceActive===true;this.applyHostGain();};window.addEventListener('oasis:host-state',this.onHostState);this.enabled=true;this.musicEnabled=true;this.sfxEnabled=true;this.voices=new Set();this.step=0;this.ducked=false;this.listeners=new Set();this.onVisibility=()=>{if(document.hidden)this.silence();else if(this.ctx?.state==='running')this.startMusic();};document.addEventListener('visibilitychange',this.onVisibility);this.prepareContext();}
  prepareContext(){
    if(this.disposed)return false;
    if(this.ctx)return this.ctx.state!=='closed';
    let ctx,master,music;
    try{
      const C=window.AudioContext||window.webkitAudioContext;if(!C)return false;
      ctx=new C();master=ctx.createGain();music=ctx.createGain();
      // No sources and zero output until a real unlock. Publish only a full graph.
      master.gain.value=0;music.gain.value=this.ducked?.035:.16;
      master.connect(ctx.destination);music.connect(master);
      this.ctx=ctx;this.master=master;this.music=music;return true;
    }catch{
      try{master?.disconnect();}catch{}
      try{music?.disconnect();}catch{}
      try{if(ctx&&ctx.state!=='closed')void Promise.resolve(ctx.close()).catch(()=>{});}catch{}
      return false; // A later gesture may retry construction.
    }
  }
  unlock(){
    if(this.disposed||!this.prepareContext())return Promise.resolve();
    const ctx=this.ctx;
    if(!this.unlocked){this.unlocked=true;this.master.gain.value=this.hostMuted||!this.hostVisible?0:this.hostVoiceActive?.095:.38;}
    if(ctx.state==='running'){try{this.applyHostGain();this.startMusic();}catch{}return Promise.resolve();}
    if(this.pendingResume)return this.pendingResume.promise;
    const pending={};let resolve;
    pending.promise=new Promise(done=>{resolve=done;});
    pending.finish=()=>{
      if(pending.done)return;pending.done=true;clearTimeout(pending.timer);
      if(this.pendingResume===pending)this.pendingResume=null;
      try{if(!this.disposed&&this.ctx===ctx&&ctx.state==='running')this.startMusic();}catch{}
      resolve();
    };
    this.pendingResume=pending;pending.timer=setTimeout(pending.finish,400);
    try{
      // Call native resume synchronously in this gesture, including iOS interrupted.
      const resumed=ctx.resume();
      Promise.resolve(resumed).then(pending.finish,pending.finish);this.applyHostGain();
    }catch{pending.finish();}
    return pending.promise;
  }
  applyHostGain(){if(!this.disposed&&this.master&&this.ctx)this.master.gain.setTargetAtTime(!this.unlocked||this.hostMuted||!this.hostVisible?0:this.hostVoiceActive?.095:.38,this.ctx.currentTime,.045);}
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  notify(){this.listeners.forEach(fn=>fn());}
  setEnabled(on){this.enabled=Boolean(on);if(!on)this.silence();else if(this.unlocked)void this.unlock();this.notify();}
  toggle(){this.setEnabled(!this.enabled);}
  setMusic(on){this.musicEnabled=Boolean(on);if(!on){clearInterval(this.timer);this.timer=null;}else this.startMusic();this.notify();}
  setSfx(on){this.sfxEnabled=Boolean(on);this.notify();}
  duck(on){this.ducked=Boolean(on);if(this.music)this.music.gain.setTargetAtTime(on ? .035 : .16,this.ctx.currentTime,.2);}
  tone(freq,duration=.15,volume=.12,type='sine',delay=0,music=false,endFreq){if(this.disposed||!this.unlocked||!this.ctx||this.ctx.state!=='running'||!this.enabled||document.hidden||this.voices.size>40)return;const start=this.ctx.currentTime+delay,o=this.ctx.createOscillator(),g=this.ctx.createGain();o.type=type;o.frequency.setValueAtTime(freq,start);if(endFreq)o.frequency.exponentialRampToValueAtTime(Math.max(20,endFreq),start+duration);g.gain.setValueAtTime(0,start);g.gain.linearRampToValueAtTime(volume,start+.008);g.gain.exponentialRampToValueAtTime(.0001,start+duration);o.connect(g);g.connect(music?this.music:this.master);o.start(start);o.stop(start+duration+.03);const voice={o,g};this.voices.add(voice);o.onended=()=>{o.disconnect();g.disconnect();this.voices.delete(voice);};}
  startMusic(){
    if(this.disposed||!this.unlocked||this.timer||!this.enabled||!this.musicEnabled||!this.ctx||this.ctx.state!=='running'||document.hidden)return;
    const scores={towerlink:{root:146.832,tempo:390,notes:[0,7,12,14,19,14,12,7,3,10,15,19,22,19,15,10]},match:{root:174.614,tempo:365,notes:[0,7,12,15,14,7,3,10,0,7,12,19,15,14,10,7]},golf:{root:196,tempo:440,notes:[0,7,12,16,14,7,4,9,0,7,12,19,16,14,9,7]},carrom:{root:164.814,tempo:450,notes:[0,3,7,10,7,3,0,-2,0,7,12,10,7,3,2,7]},darts:{root:110,tempo:260,notes:[0,0,12,7,0,3,10,7,0,0,12,15,10,7,3,7]},ludo:{root:220,tempo:360,notes:[0,4,7,12,9,7,4,7,2,5,9,14,12,9,7,4]},jackaroo:{root:146.832,tempo:480,notes:[0,2,3,7,10,7,3,2,0,7,12,14,15,10,7,3]},domino:{root:174.614,tempo:520,notes:[0,7,10,14,12,7,3,7,0,5,9,12,10,5,2,7]},pool:{root:130.813,tempo:490,notes:[0,3,7,10,14,10,7,3,0,5,9,12,14,12,9,5]},bowling:{root:123.471,tempo:240,notes:[0,7,12,15,0,7,10,14,0,3,7,15,12,10,7,3]},run:{root:196,tempo:250,notes:[0,7,12,14,12,7,4,9,0,7,16,14,12,9,7,4]}};
    const score=scores[this.theme]||scores.match;
    const tick=()=>{if(!this.musicEnabled||document.hidden)return;this.tone(score.root*2**(score.notes[this.step%16]/12),.8,.27,'sine',0,true);if(this.step%4===0){this.tone(score.root/2,1.5,.32,'sine',0,true);this.tone(score.root*1.5,.7,.09,'triangle',.04,true);}if(['darts','bowling','run'].includes(this.theme)&&this.step%2===0)this.tone(70,.12,.35,'sine',0,true,35);this.step++;};tick();this.timer=setInterval(tick,score.tempo);
  }
  play(kind,intensity=1){if(!this.enabled||!this.sfxEnabled)return;const i=Math.max(1,Math.min(5,Number(intensity)||1));
    if(['swap','click','select'].includes(kind)){this.tone(620,.09,.12,'sine',0,false,850);}
    else if(['invalid','error','water'].includes(kind)){this.tone(220,.24,.15,'triangle',0,false,90);this.tone(135,.26,.07,'sine',.04);}
    else if(['clear','match','combo','cascade','special'].includes(kind)){[0,4,7,12].slice(0,kind==='clear'?3:4).forEach((n,j)=>this.tone(440*2**((n+i*2)/12),.34,.13,'sine',j*.055));}
    else if(['shot','hit','bounce','throw','impact','rail'].includes(kind)){this.tone(kind==='shot'?130:260,.13,.17,'triangle',0,false,80);this.tone(720,.06,.08,'sine');}
    else if(['hole','win','victory','finish','home','bull','checkout','strike','spare'].includes(kind)){[0,4,7,12,16,19].forEach((n,j)=>this.tone(330*2**(n/12),.65,.15,'sine',j*.095));}
    else if(['ready','start','countdown'].includes(kind)){this.tone(880,.17,.13,'sine');}
    else if(['dice','roll'].includes(kind)){[0,.07,.14,.23,.34].forEach((d,j)=>this.tone(240+j*90,.06,.14,'triangle',d,false,110));}
    else if(['card','deal','tile','place','move','pass'].includes(kind)){this.tone(430,.055,.1,'triangle',0,false,170);this.tone(980,.08,.07,'sine',.04);}
    else if(['pocket','capture','queen'].includes(kind)){[0,7,12].forEach((n,j)=>this.tone(520*2**(n/12),.32,.15,'sine',j*.065));}
    else if(['jump','boost','pickup','shield'].includes(kind)){this.tone(kind==='jump'?260:420,.28,.12,'sine',0,false,kind==='jump'?750:1100);this.tone(660,.2,.06,'triangle',.06);}
    else if(['slide','lane','gutter','crash'].includes(kind)){this.tone(180,.2,.12,'triangle',0,false,45);}
    else if(['pin','pinfall','rolling'].includes(kind)){[0,.04,.09].forEach((d,j)=>this.tone(180+j*73,.11,.09,'triangle',d,false,65));}
    else if(['timeout','bust','foul','lose'].includes(kind)){[7,3,0].forEach((n,j)=>this.tone(330*2**(n/12),.38,.11,'triangle',j*.14));}
  }
  silence(){clearInterval(this.timer);this.timer=null;for(const v of this.voices){try{v.o.stop();}catch{}}}
  dispose(){
    if(this.disposed)return;this.disposed=true;this.pendingResume?.finish();this.silence();
    window.removeEventListener('oasis:host-state',this.onHostState);document.removeEventListener('visibilitychange',this.onVisibility);
    for(const voice of this.voices){voice.o.onended=null;try{voice.o.disconnect();}catch{}try{voice.g.disconnect();}catch{}}this.voices.clear();
    try{this.music?.disconnect();}catch{}try{this.master?.disconnect();}catch{}
    try{if(this.ctx&&this.ctx.state!=='closed')void Promise.resolve(this.ctx.close()).catch(()=>{});}catch{}
    this.listeners.clear();
  }
}
