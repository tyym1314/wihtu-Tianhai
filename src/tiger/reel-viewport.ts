/** Fixed visible DOM surface for the original logical reel and WAAPI clock.
 * Two rows above and at least one below retain the blur/shadow halo, including
 * the original nine-pixel landing overshoot. No symbols or timing are skipped.
 */
export class TigerReelViewport {
  private strip:HTMLElement;
  readonly clock:HTMLElement;
  private cells:HTMLElement[];
  private symbols:(string|undefined)[]=Array(7).fill(undefined);
  private pitch:number;
  private raf=0;
  private disposed=false;
  private blur:Animation|undefined;
  private animation:Animation|undefined;
  constructor(window:HTMLElement,private sequence:string[],cellH:number,cell:(symbol:string)=>string){
    window.innerHTML=`<div class="reel-strip moving">${Array.from({length:7},()=>cell('tiger')).join('')}</div>`;
    this.strip=window.firstElementChild as HTMLElement;
    this.strip.style.setProperty('--cell-h',`${cellH}px`);
    this.cells=Array.from(this.strip.children) as HTMLElement[];
    // CSS layout quantizes fractional cell heights; use the same actual pitch
    // as the full original strip rather than accumulating ideal-height drift.
    this.pitch=parseFloat(getComputedStyle(this.cells[0]).height);
    this.clock=document.createElement('i');
    this.clock.style.cssText='position:absolute;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none';
    this.clock.setAttribute('aria-hidden','true');window.append(this.clock);
    this.draw();
  }
  draw(){
    if(this.disposed)return;
    const computed=getComputedStyle(this.clock),matrix=new DOMMatrixReadOnly(computed.transform==='none'?undefined:computed.transform);
    const y=matrix.m42,first=Math.floor(-y/this.pitch)-2;
    for(let row=0;row<this.cells.length;row++){
      const symbol=this.sequence[first+row],cell=this.cells[row];
      cell.style.visibility=symbol===undefined?'hidden':'visible';
      if(symbol!==undefined&&symbol!==this.symbols[row]){
        const art=cell.querySelector<HTMLElement>('.symbol-art')!;
        art.className=`symbol-art symbol-${symbol}`;
        art.querySelector<HTMLElement>('b')!.hidden=symbol!=='tiger';
      }
      this.symbols[row]=symbol;
    }
    this.strip.style.transform=`translate3d(0,${y+first*this.pitch}px,0)`;
    if(this.blur&&this.animation)this.blur.currentTime=this.animation.currentTime;
    else this.strip.style.filter=computed.filter;
  }
  start(animation:Animation){
    if(this.disposed||this.raf)return;
    this.animation=animation;
    // Use the original filter keyframes, not a serialized/rounded CSS filter,
    // so the bounded surface retains the same compositor blur interpolation.
    const effect=animation.effect as KeyframeEffect;
    this.blur=this.strip.animate(effect.getKeyframes().map(({filter,offset})=>({filter,offset})),effect.getTiming());
    this.blur.pause();
    const tick=()=>{this.raf=0;if(this.disposed)return;this.draw();this.raf=requestAnimationFrame(tick);};
    this.draw();this.raf=requestAnimationFrame(tick);
  }
  dispose(){this.disposed=true;cancelAnimationFrame(this.raf);this.raf=0;this.blur?.cancel();this.clock.remove();}
}
