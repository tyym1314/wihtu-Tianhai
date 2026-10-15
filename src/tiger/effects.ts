import type { TigerSymbol } from './types';
import { TigerReelViewport } from './reel-viewport';

export const SYMBOLS: TigerSymbol[] = ['tiger','ingot','coin','jade','envelope','firecracker','orange'];
export const symbolMarkup=(symbol:TigerSymbol)=>`<span class="symbol-art symbol-${symbol}" aria-hidden="true">${symbol==='tiger'?'<b>WILD</b>':''}</span>`;
export const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export class TigerReels {
  board:TigerSymbol[]=['ingot','tiger','coin','jade','envelope','jade','orange','firecracker','ingot'];
  private windows:HTMLElement[]=[];
  private animations:Animation[]=[];
  private viewports=new Set<TigerReelViewport>();
  private disposed=false;
  private landingTimers=new Set<ReturnType<typeof setTimeout>>();
  private media=matchMedia('(prefers-reduced-motion: reduce)');
  constructor(private host:HTMLElement,private label:(symbol:TigerSymbol)=>string) {
    host.innerHTML=[0,1,2].map(col=>`<div class="reel-column" data-col="${col}"><div class="reel-window"></div><div class="reel-locks"></div><i class="reel-glint"></i></div>`).join('');
    this.windows=Array.from(host.querySelectorAll('.reel-window')); this.render(this.board);
  }
  render(board:TigerSymbol[]) {
    this.board=[...board];
    this.windows.forEach((window,col)=>{window.innerHTML=`<div class="reel-strip">${[0,1,2].map(row=>this.cell(board[row*3+col],row*3+col)).join('')}</div>`;});
  }
  private cell(symbol:TigerSymbol,index=-1) {return `<div class="reel-cell" ${index>=0?`data-cell="${index}" role="img" aria-label="${Math.floor(index/3)+1},${index%3+1}: ${this.label(symbol)}"`:'aria-hidden="true"'}>${symbolMarkup(symbol)}<i class="cell-spark"></i></div>`;}
  clearWin(){this.host.querySelectorAll('.winning,.locked,.new-lock').forEach(el=>el.classList.remove('winning','locked','new-lock'));}
  highlight(indices:number[],locked:number[]=[],added:number[]=[]) {
    this.clearWin(); indices.forEach(i=>this.host.querySelector(`[data-cell="${i}"]`)?.classList.add('winning'));
    locked.forEach(i=>this.host.querySelector(`[data-cell="${i}"]`)?.classList.add('locked'));
    added.forEach(i=>this.host.querySelector(`[data-cell="${i}"]`)?.classList.add('new-lock'));
  }
  async spin(target:TigerSymbol[],held:number[],turbo:boolean,onLand:(col:number)=>void) {
    if(this.disposed)return;
    this.clearWin(); const cellH=this.windows[0].clientHeight/3;
    const old=[...this.board];
    const jobs=this.windows.map(async(window,col)=>{
      const column=window.parentElement!;
      const lockLayer=column.querySelector<HTMLElement>('.reel-locks')!;
      lockLayer.innerHTML=held.filter(i=>i%3===col).map(i=>`<div class="held-cell" style="top:${Math.floor(i/3)*100/3}%;height:33.333%">${this.cell(old[i])}<i></i></div>`).join('');
      const count=turbo?12+col*3:24+col*6;
      const fillers=Array.from({length:count},()=>SYMBOLS[Math.floor(Math.random()*SYMBOLS.length)]);
      const sequence=[...[0,1,2].map(row=>old[row*3+col]),...fillers,...[0,1,2].map(row=>target[row*3+col])];
      const viewport=new TigerReelViewport(window,sequence,cellH,s=>this.cell(s as TigerSymbol));
      this.viewports.add(viewport);
      column.classList.add('rolling');
      const travel=(count+3)*cellH;
      const duration=this.media.matches?100:turbo?520+col*95:1100+col*200;
      const animation=viewport.clock.animate([
        {transform:'translate3d(0,0,0)',filter:'blur(0px)',offset:0},
        {transform:`translate3d(0,${-travel*.05}px,0)`,filter:'blur(2px)',offset:.08},
        {transform:`translate3d(0,${-travel*.79}px,0)`,filter:'blur(3px)',offset:.68},
        {transform:`translate3d(0,${-travel-9}px,0)`,filter:'blur(0px)',offset:.93},
        {transform:`translate3d(0,${-travel}px,0)`,filter:'blur(0px)',offset:1},
      ],{duration,fill:'forwards',easing:'cubic-bezier(.18,.45,.28,1)'});
      viewport.start(animation);
      this.animations.push(animation);
      try {await animation.finished;} catch{}
      viewport.dispose();this.viewports.delete(viewport);
      animation.cancel(); this.animations=this.animations.filter(a=>a!==animation);
      if(this.disposed)return;
      window.innerHTML=`<div class="reel-strip">${[0,1,2].map(row=>this.cell(target[row*3+col],row*3+col)).join('')}</div>`;
      column.classList.remove('rolling'); column.classList.add('landed'); lockLayer.innerHTML='';
      const timer=setTimeout(()=>{this.landingTimers.delete(timer);if(!this.disposed)column.classList.remove('landed');},300);
      this.landingTimers.add(timer);onLand(col);
    });
    await Promise.all(jobs);if(!this.disposed)this.board=[...target];
  }
  dispose(){this.disposed=true;this.landingTimers.forEach(clearTimeout);this.landingTimers.clear();this.viewports.forEach(v=>v.dispose());this.viewports.clear();this.animations.forEach(a=>a.cancel());this.animations=[];}
}

interface Particle{x:number;y:number;vx:number;vy:number;age:number;life:number;size:number;rotation:number;vr:number;type:'coin'|'spark'|'petal';color:string}
export const TIGER_PARTICLE_LIMIT=240;
export class TigerEffects {
  private ctx:CanvasRenderingContext2D;
  private particles:Particle[]=[];
  private raf=0;private last=0;private width=0;private height=0;private rainingUntil=0;private disposed=false;
  private resize:ResizeObserver;
  private media=matchMedia('(prefers-reduced-motion: reduce)');
  constructor(private canvas:HTMLCanvasElement,private game:HTMLElement){
    this.ctx=canvas.getContext('2d')!;
    this.resize=new ResizeObserver(()=>this.size());this.resize.observe(game);this.size();
    document.addEventListener('visibilitychange',this.visibility);
  }
  private size(){const r=this.game.getBoundingClientRect();this.width=r.width;this.height=r.height;const d=Math.min(devicePixelRatio||1,2);this.canvas.width=r.width*d;this.canvas.height=r.height*d;this.ctx.setTransform(d,0,0,d,0,0);}
  private wake(){if(!this.raf&&!this.disposed&&!document.hidden&&(this.particles.length||this.rainingUntil>performance.now())){this.last=0;this.raf=requestAnimationFrame(this.tick);}}
  private visibility=()=>{this.last=0;if(document.hidden){cancelAnimationFrame(this.raf);this.raf=0;this.particles.length=0;this.rainingUntil=0;this.ctx.clearRect(0,0,this.width,this.height);}else this.wake();};
  burstAt(x:number,y:number,strength=1){if(this.media.matches||this.disposed||document.hidden||!Number.isFinite(strength))return;const count=Math.min(TIGER_PARTICLE_LIMIT-this.particles.length,Math.max(0,Math.ceil(22*strength)));for(let i=0;i<count;i++){const a=Math.random()*Math.PI*2;const v=45+Math.random()*140*strength;this.particles.push({x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v-80,age:0,life:.5+Math.random()*.65,size:1+Math.random()*3,rotation:a,vr:4,type:'spark',color:i%3?'#ffd86d':'#fffce6'});}this.wake();}
  burstCells(indices:number[]){const g=this.game.getBoundingClientRect();indices.forEach(i=>{const r=this.game.querySelector(`[data-cell="${i}"]`)?.getBoundingClientRect();if(r)this.burstAt(r.x-g.x+r.width/2,r.y-g.y+r.height/2,.7);});}
  rain(duration=3000){if(this.media.matches||this.disposed||document.hidden)return;this.rainingUntil=performance.now()+duration;this.burstAt(this.width/2,this.height*.45,3);this.wake();}
  stopRain(){this.rainingUntil=0;}
  flash(strength=1){if(this.media.matches)return;this.game.animate([{filter:'brightness(1)'},{filter:`brightness(${1+strength*.45})`,offset:.22},{filter:'brightness(1)'}],{duration:450,easing:'ease-out'});}
  private tick=(now:number)=>{
    this.raf=0;
    if(this.disposed||document.hidden)return;
    const dt=this.last?Math.min((now-this.last)/1000,.04):.016;this.last=now;
    this.ctx.clearRect(0,0,this.width,this.height);
    if(now<this.rainingUntil){const count=Math.min(3,TIGER_PARTICLE_LIMIT-this.particles.length);for(let i=0;i<count;i++)this.particles.push({x:Math.random()*this.width,y:-25,vx:(Math.random()-.5)*90,vy:100+Math.random()*120,age:0,life:4,size:7+Math.random()*7,rotation:Math.random()*6.28,vr:2+Math.random()*5,type:'coin',color:'#ffd451'});}
    let alive=0;for(const p of this.particles)if(p.age<p.life&&p.y<this.height+40)this.particles[alive++]=p;this.particles.length=alive;
    for(const p of this.particles){p.age+=dt;p.vy+=dt*(p.type==='coin'?50:220);p.x+=p.vx*dt;p.y+=p.vy*dt;p.rotation+=p.vr*dt;
      const c=this.ctx;c.save();c.translate(p.x,p.y);c.rotate(p.rotation);c.globalAlpha=Math.min(1,(p.life-p.age)*2);
      if(p.type==='coin'){c.scale(Math.max(.18,Math.abs(Math.cos(p.rotation*1.3))),1);const g=c.createLinearGradient(-p.size,-p.size,p.size,p.size);g.addColorStop(0,'#fff6b2');g.addColorStop(.4,'#ffcd38');g.addColorStop(.7,'#b96b16');g.addColorStop(1,'#ffe487');c.fillStyle=g;c.strokeStyle='#fff0a3';c.lineWidth=1.3;c.beginPath();c.ellipse(0,0,p.size,p.size,0,0,Math.PI*2);c.fill();c.stroke();c.strokeStyle='#b97b20';c.strokeRect(-p.size*.22,-p.size*.22,p.size*.44,p.size*.44);}
      else {c.fillStyle=p.color;c.shadowColor=p.color;c.shadowBlur=7;c.fillRect(-p.size/2,-p.size/2,p.size,p.size*2);} c.restore();
    }
    if(this.particles.length||now<this.rainingUntil)this.raf=requestAnimationFrame(this.tick);
  };
  dispose(){this.disposed=true;cancelAnimationFrame(this.raf);this.raf=0;this.resize.disconnect();document.removeEventListener('visibilitychange',this.visibility);this.particles.length=0;this.rainingUntil=0;this.ctx.clearRect(0,0,this.width,this.height);}
}
