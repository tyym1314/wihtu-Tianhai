export function dartFlightPose(event,now){
 const duration=Math.max(1,event.busyUntil-event.at),t=Math.max(0,Math.min(1,(now-event.at)/duration)),ease=1-(1-t)**2;
 return {t,x:.38+(event.hit.x-.38)*ease,y:1.85+(event.hit.y-1.85)*ease,scale:2.4-1.72*ease,rotation:-22+10*ease};
}
