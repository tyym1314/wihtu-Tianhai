import {readRunPracticeRoomProfile} from './practice-profile-contract.mjs';
import {resolveRunPracticeProfile} from '../../shared/run-practice-profiles.mjs';
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function readRunPracticeOwnEvents(room){
 const a=room?.run_inputs,g=room?.game,tuple=resolveRunPracticeProfile(a),profile=tuple?.profileId===null?tuple:readRunPracticeRoomProfile(room);
 if(!profile||!Array.isArray(g?.events)||g.events.length>48)return null;
 if(profile.profileId===null)return {profile,events:g.events};
 const own=a.committedOwnEvents,anchor=a.selfReplay?.anchorTick;
 if(!integer(anchor)||anchor>a.headTick||anchor>a.committedThroughTick||!Array.isArray(own)||own.length>profile.ownEventLimit||own.some(e=>!e||e.playerKey!==room.me
  ||!integer(e.tick)||e.tick>a.committedThroughTick||e.tick<Math.max(0,anchor-profile.ownEventTicks)))return null;
 return {profile,anchorTick:anchor,events:[...g.events,...own]};
}
