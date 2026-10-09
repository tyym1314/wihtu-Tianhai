/** Secondary visual captures, never authoritative simulation or input cadence.
 * Camera cuts, resize and resume must not reuse a texture from the old view.
 */
export function createVisualCaptureCadence({activeHz=30,idleHz=8}={}){
 let last=-Infinity,force=true,view=null;
 return{
  invalidate(){force=true;},
  shouldCapture(now,{active=false,pose=[]}={}){
   const cut=view&&pose.some((value,index)=>Math.abs(value-view[index])>(index===7?.75:index<3?.12:.025));
   const due=force||cut||now<last||now-last+0.1>=1000/(active?activeHz:idleHz);
   if(due){last=now;view=pose.slice();force=false;}
   return due;
  }
 };
}
