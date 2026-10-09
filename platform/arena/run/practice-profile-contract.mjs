import {resolveRunPracticeProfile} from '../../shared/run-practice-profiles.mjs';

const exactTuple=value=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).length===3&&['rule_version','protocol','profile_id'].every(key=>Object.hasOwn(value,key));
export const runInputRule=version=>version==='pvp-run-v2.3.0'||version==='pvp-run-v2.4.0';
export function readRunPracticeTuple(value){
 return exactTuple(value)?resolveRunPracticeProfile({ruleVersion:value.rule_version,protocol:value.protocol,profileId:value.profile_id}):null;
}
export function selectRunPracticeInputRequest(context){
 const profiles=context?.run_practice_input_profiles;
 const v2=Array.isArray(profiles)&&profiles.some(tuple=>readRunPracticeTuple(tuple)?.profileId==='free-bot-360-v1');
 if(v2)return Object.freeze({run_input_protocol:'run-practice-inputs-v2',run_input_profile:'free-bot-360-v1'});
 return context?.run_practice_input_protocol==='run-practice-inputs-v1'?Object.freeze({run_input_protocol:'run-practice-inputs-v1'}):Object.freeze({});
}
// Restore by the room's immutable tuple, never the latest session preference.
// Old servers/rooms may omit the v1 confirmation; v2 always confirms it.
export function readRunPracticeRoomProfile(room){
 const tuple=room?.run_input_profile,a=room?.run_inputs,g=room?.game;
 let profile=tuple?readRunPracticeTuple(tuple):resolveRunPracticeProfile({ruleVersion:g?.ruleVersion,protocol:a?.protocol,profileId:a?.profileId});
 if(!profile||room?.game_id!=='run'||room.practice!==true||room.entry_minor!=='0')return null;
 if(profile.profileId!==null&&(!tuple||room.fee_bps!==0||!Number.isSafeInteger(room.capacity)||room.capacity<2||room.capacity>4))return null;
 if(g&&g.ruleVersion!==profile.ruleVersion||a&&(a.ruleVersion!==profile.ruleVersion||a.protocol!==profile.protocol||(a.profileId??null)!==profile.profileId))return null;
 return profile;
}
export function matchesRunPracticeRequest(room,request){
 const profile=readRunPracticeRoomProfile(room);
 return !!profile&&profile.protocol===request.run_input_protocol&&(profile.profileId??undefined)===request.run_input_profile;
}
