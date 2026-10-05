/** Single-finger cardinal swipe; shared by the two games, with no DOM listeners. */
export function createCardinalSwipe({threshold=16,tapSlop=6,axisRatio=1.3}={}){
 let current=null,suppressClick=false;
 const distance=(event,p)=>Math.hypot(event.clientX-p.x,event.clientY-p.y);
 return{
  start(event,meta){
   if(event.button!==0||event.isPrimary===false||current){current=null;suppressClick=true;return false;}
   current={id:event.pointerId,x:event.clientX,y:event.clientY,max:0,meta};suppressClick=false;return true;
  },
  move(event){if(current&&current.id===event.pointerId)current.max=Math.max(current.max,distance(event,current));},
  end(event){
   if(!current||current.id!==event.pointerId)return null;
   const p=current;current=null;const dx=event.clientX-p.x,dy=event.clientY-p.y,ax=Math.abs(dx),ay=Math.abs(dy),max=Math.max(p.max,distance(event,p));
   if(max<=tapSlop)return{kind:'tap',meta:p.meta};
   // Keep this blocked until the next actual pointerdown. A delayed touch click
   // may arrive after 180/300 ms; a timer must not turn a drag into a second move.
   suppressClick=true;
   if(Math.max(ax,ay)<threshold||Math.max(ax,ay)<Math.min(ax,ay)*axisRatio)return{kind:'cancel',meta:p.meta};
   return{kind:'swipe',direction:ax>ay?(dx<0?'left':'right'):(dy<0?'up':'down'),meta:p.meta};
  },
  cancel(event){if(!event||current?.id===event.pointerId){current=null;suppressClick=true;}},
  blocksClick(event){return suppressClick&&event.detail!==0;},
 };
}
