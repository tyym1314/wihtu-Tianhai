// Negotiated server/client contracts, never limits supplied by a caller.
// The original tuple deliberately has no profile id on its wire envelope.
const common={advanceTicks:120,batch:8,decisions:128,revisions:128,envelopeBytes:262144,admissions:1024,botDecisions:768,temporaryStates:12,commands:64,physicalSends:2};
export const RUN_PRACTICE_PROFILES=Object.freeze({
 v1:Object.freeze({...common,ruleVersion:'pvp-run-v2.3.0',protocol:'run-practice-inputs-v1',profileId:null,historyTicks:120,futureTicks:120,leaseMs:2000,serverMaxTick:6120,workTicks:240,clientWorkTicks:360,trajectoryFrames:241,pendingCommands:32,ownEventLimit:0,ownEventTicks:0}),
 v2:Object.freeze({...common,ruleVersion:'pvp-run-v2.4.0',protocol:'run-practice-inputs-v2',profileId:'free-bot-360-v1',historyTicks:360,futureTicks:360,leaseMs:6000,serverMaxTick:6360,workTicks:480,clientWorkTicks:1080,trajectoryFrames:721,pendingCommands:64,ownEventLimit:256,ownEventTicks:720}),
});
export function resolveRunPracticeProfile({ruleVersion,protocol,profileId}={}){
 return Object.values(RUN_PRACTICE_PROFILES).find(p=>p.ruleVersion===ruleVersion&&p.protocol===protocol&&(p.profileId===null?profileId==null:p.profileId===profileId))??null;
}
export const runPracticeProfileCapability=()=>Object.values(RUN_PRACTICE_PROFILES).map(({ruleVersion,protocol,profileId})=>({rule_version:ruleVersion,protocol,profile_id:profileId}));
