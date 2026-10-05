export const PHYSICS_VERSION='bowling-rigid-v1.1.0';
export const LANE=Object.freeze({halfWidth:1.35,startZ:1.2,deckZ:-12.6,backZ:-15.1,ballRadius:.23,pinHeight:.803,pinCOM:.32});
// Spread the simplified rack so head-on shots do not collapse all ten by default.
// Equilateral spacing is shared with the renderer; this is an arcade calibration, not a certified lane.
export const PIN_LAYOUT=Object.freeze(Array.from({length:4},(_,row)=>Array.from({length:row+1},(_,col)=>Object.freeze({id:row*(row+1)/2+col+1,x:(col-row/2)*.55,z:LANE.deckZ-row*(.55*Math.sqrt(3)/2)}))).flat());
export const PHYSICS=Object.freeze({dt:1/60,maxMs:15000,sampleEvery:3,sleepSpeed:.085,sleepSeconds:.4,maxAngle:.20,minPower:.25,maxOffset:.85});
