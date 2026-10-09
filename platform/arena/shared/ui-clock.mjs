/** Only visible seconds and time-dependent control/effect boundaries commit UI.
 * Gesture submission must still read its live authority clock directly.
 */
export function uiClockChanged(previous,next,{deadlines=[],boundaries=[]}={}){
 for(const deadline of deadlines)if(Number.isFinite(deadline)&&Math.max(0,Math.ceil((deadline-previous)/1000))!==Math.max(0,Math.ceil((deadline-next)/1000)))return true;
 for(const boundary of boundaries)if(Number.isFinite(boundary)&&(previous<boundary)!==(next<boundary))return true;
 return false;
}
