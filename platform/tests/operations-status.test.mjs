import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RELEASED_IDS} from '../shared/games.mjs';
import {monitorStatusPath,publicMonitorReport,publicCapacityReport,publicAndroidReport} from '../server/operations-status.mjs';
test('expired, future and invalid reports cannot show green component checks',()=>{
 const now=Date.now();for(const checked_at of [new Date(now-180001).toISOString(),new Date(now+1).toISOString(),'invalid']){
  const result=publicMonitorReport({checked_at,status:'ok',checks:[{name:'api',status:'ok',codes:[]}]},now);
  assert.equal(result.status,'stale');assert.equal(result.checks[0].status,'stale');
 }
});
function androidEvidence(){
 const actions={carrom:'shot',match:'swap',golf:'shot',towerlink:'link',darts:'throw',ludo:'roll',pool:'shot',bowling:'roll',jackaroo:'pass',domino:'play',run:'jump'};
 const games=Object.entries(actions).map(([game,actionType])=>({game,session_id:'ses_'+game,room_id:'room_'+game,launch_exchange:true,native_back_returned:true,action:{game,roomId:'room_'+game,actionType,sequenceBefore:0,sequenceAfter:1,httpStatus:200}}));
 for(const game of ['thunder','tiger'])games.push({game,session_id:'ses_'+game,launch_exchange:true,native_back_returned:true,spins:[{round_id:'round_'+game,cycle_id:'cycle_'+game,status:'SETTLED',request_status:200}],acks:1,ack_records:[{round_id:'round_'+game,request_status:200,pending_cleared:true,session_matches:true}]});
 const release={version:'20260920-04',activated_at:'2026-09-20T01:00:00.000Z'};
 return{tested_release:'20260920-04',release_verification:{before:{...release},after:{...release},unchanged:true},passed:true,full_catalog:true,requested_games:games.map(g=>g.game),games,started_at:'2026-09-20T02:00:00.000Z',finished_at:'2026-09-20T02:06:00.000Z',device:{model:'24053PY09C',android:'16'},page_errors:[],asset_failures:[]};
}
test('Android evidence requires the complete released-game report and this release',()=>{
 const d=androidEvidence();
 assert.equal(publicAndroidReport(d,'20260920-04').status,'passed');
 assert.equal(publicAndroidReport(d,'20260920-05').status,'unavailable');
 assert.equal(publicAndroidReport({...d,games_passed:0},'20260920-04').games_passed,RELEASED_IDS.length,'caller count is ignored');
 assert.equal(publicAndroidReport({...d,games_passed:RELEASED_IDS.length,games:d.games.slice(0,-1)},'20260920-04').status,'failed');
 const subset={...d,full_catalog:false,requested_games:['thunder','tiger'],games:d.games.slice(-2),games_passed:RELEASED_IDS.length};
 const result=publicAndroidReport(subset,'20260920-04');assert.equal(result.status,'failed');assert.equal(result.games_passed,2);
 assert.equal(publicAndroidReport({tested_release:'20260920-04',passed:true,games_passed:RELEASED_IDS.length},'20260920-04').status,'failed');
});
test('a previously passing twelve-game report cannot certify the expanded catalogue',()=>{
 const d=androidEvidence();d.games=d.games.filter(game=>game.game!=='towerlink');d.requested_games=d.requested_games.filter(game=>game!=='towerlink');
 assert.equal(publicAndroidReport(d,'20260920-04').status,'failed');
 assert.equal(publicAndroidReport(d,'20260920-04').games_passed,12);
});
test('duplicate, unknown or mismatched requested game sets cannot pass the full catalog gate',()=>{
 for(const mutate of [d=>d.requested_games.pop(),d=>d.requested_games[0]='tiger',d=>d.games[0]=d.games[1],d=>d.games.push(d.games[0]),d=>d.games[0].game='unknown',d=>d.full_catalog=false]){
  const d=androidEvidence();mutate(d);assert.equal(publicAndroidReport(d,'20260920-04').status,'failed');
 }
});
test('each arena game needs its own accepted sequence and matching response identity',()=>{
 for(const mutate of [g=>g.launch_exchange=false,g=>g.native_back_returned=false,g=>g.session_id=null,g=>g.action.httpStatus=409,g=>g.action.sequenceAfter=0,g=>g.action.sequenceBefore=-1,g=>g.action.sequenceAfter=1.5,g=>g.action.roomId='other_room',g=>g.action.game='golf',g=>g.action.actionType='invented',g=>g.action=null]){
  const d=androidEvidence();mutate(d.games[0]);const result=publicAndroidReport(d,'20260920-04');assert.equal(result.status,'failed');assert.equal(result.games_passed,RELEASED_IDS.length-1);
 }
});
test('Tower Link multi-route unlink is accepted as a real sequenced arena action',()=>{
 const d=androidEvidence(),tower=d.games.find(game=>game.game==='towerlink');tower.action.actionType='unlink';
 assert.equal(publicAndroidReport(d,'20260920-04').status,'passed');
 tower.action.sequenceAfter=0;assert.equal(publicAndroidReport(d,'20260920-04').status,'failed');
});
test('probability games require settled HTTP responses and a matching verified acknowledgement for each round',()=>{
 for(const mutate of [g=>g.spins=[],g=>g.spins[0].status='PENDING',g=>g.spins[0].request_status=500,g=>g.spins[0].round_id=null,g=>g.spins[0].cycle_id=null,g=>g.ack_records=[],g=>delete g.ack_records,g=>g.ack_records[0].round_id='another_round',g=>g.ack_records[0].request_status=500,g=>g.ack_records[0].pending_cleared=false,g=>g.ack_records[0].session_matches=false,g=>g.spins.push(g.spins[0]),g=>g.spins.push({...g.spins[0],round_id:'second_unacknowledged_round'})]){
  const d=androidEvidence();mutate(d.games.at(-1));const result=publicAndroidReport(d,'20260920-04');assert.equal(result.status,'failed');assert.equal(result.games_passed,RELEASED_IDS.length-1);
 }
 const d=androidEvidence();d.games.at(-1).acks=0;assert.equal(publicAndroidReport(d,'20260920-04').status,'passed','verified per-round ACKs, not a count, are the evidence');
});
test('release verification must prove the same deployed version and activation before and after testing',()=>{
 for(const mutate of [d=>delete d.release_verification,d=>d.release_verification.unchanged=false,d=>d.release_verification.before.version='20260920-03',d=>d.release_verification.after.version='20260920-05',d=>d.release_verification.after.activated_at='2026-09-20T01:01:00Z',d=>d.release_verification.before.activated_at='invalid']){
  const d=androidEvidence();mutate(d);assert.equal(publicAndroidReport(d,'20260920-04').status,'failed');
 }
});
test('errors, incomplete dates and failure flags cannot be turned green by a full count',()=>{
 for(const mutate of [d=>d.passed=false,d=>d.page_errors=['error'],d=>d.asset_failures=[{status:404}],d=>delete d.page_errors,d=>d.finished_at='invalid',d=>d.started_at='2026-09-21T00:00:00Z']){
  const d=androidEvidence();mutate(d);assert.equal(publicAndroidReport(d,'20260920-04').status,'failed');
 }
});
test('Android public projection exposes no raw identity, token, stack or arbitrary timestamp object',()=>{
 const d=androidEvidence();Object.assign(d,{token:'must_not_expose',failure:'must_not_expose',checked_at:{secret:'must_not_expose'}});d.games[0].guest='must_not_expose';d.device.serial='must_not_expose';
 const result=publicAndroidReport(d,'20260920-04');assert.equal(result.checked_at,d.finished_at);assert.equal(result.model,'24053PY09C');assert.equal(result.android,'16');assert.match(result.scope,/单台 Android/);
 assert.doesNotMatch(JSON.stringify(result),/must_not_expose|ses_carrom|room_carrom/);
 const bad=publicAndroidReport({...d,finished_at:{secret:'must_not_expose'}},'20260920-04');assert.equal(bad.checked_at,null);assert.doesNotMatch(JSON.stringify(bad),/must_not_expose/);
 assert.equal(publicAndroidReport({...d,tested_release:''},''),null);
});
test('capacity evidence from another release cannot mark this release passed',()=>{
 const report={tested_version:'20260920-02',users:100,duration_seconds:600,status:'passed',scope:'Isolated load'};
 assert.equal(publicCapacityReport(report,'20260920-02').status,'passed');
 assert.equal(publicCapacityReport(report,'20260920-03').status,'unavailable');
 assert.equal(publicCapacityReport({...report,tested_version:undefined},'20260920-03').status,'unavailable');
 assert.equal(publicCapacityReport({...report,users:'100'},'20260920-02'),null);
});
test('public monitor projection removes unknown text and corrupted report shapes',()=>{
 const now=Date.now(),result=publicMonitorReport({checked_at:new Date(now).toISOString(),status:'ok',checks:[{name:'api',status:'ok',codes:['PROBE_FAILED','secret=foo'],metrics:{queue:2,password:'secret'},password:'secret'}, {name:'secret=foo',status:'ok'}]},now);
 assert.equal(result.status,'ok');assert.equal(result.checks.length,1);assert.deepEqual(result.checks[0].metrics,{queue:2});assert.equal(JSON.stringify(result).includes('secret'),false);
 assert.equal(publicMonitorReport({checks:'broken'}).status,'unavailable');
});


test('production monitor consumer rejects sandbox, missing runtime, partial and contradictory reports',()=>{
 const now=Date.now(),checks=['database','api','wallet','ingress','systemd','backup','disks','certificate'].map(name=>({name,status:'ok',codes:[],metrics:{}}));
 const valid={environment:'production',checked_at:new Date(now).toISOString(),status:'ok',checks};
 assert.equal(publicMonitorReport(valid,now,'production').status,'ok');
 for(const report of [{...valid,environment:'sandbox'},{...valid,environment:undefined},{...valid,checks:[]},{...valid,checks:checks.slice(1)},{...valid,checks:[...checks,checks[0]]},{...valid,checks:checks.map(c=>c.name==='wallet'?{...c,status:'failed'}:c)}])assert.deepEqual(publicMonitorReport(report,now,'production'),{status:'unavailable',checks:[]});
 assert.equal(publicMonitorReport({...valid,status:'failed',checks:checks.map(c=>c.name==='wallet'?{...c,status:'failed'}:c)},now,'production').status,'failed');
 assert.equal(publicMonitorReport({...valid,environment:undefined},now,'sandbox').status,'ok','existing sandbox-only reports retain compatibility');
 assert.equal(publicMonitorReport(valid,now,'sandbox').status,'unavailable');
});
test('production report path must be explicit and independent; no silent sandbox report fallback',()=>{
 for(const value of [undefined,'','relative.json','/opt/oasis/private/monitor/status.json','/opt/oasis/private/production/../monitor/status.json'])assert.equal(monitorStatusPath({OASIS_MONITOR_STATUS_FILE:value},'production'),null);
 assert.equal(monitorStatusPath({},'sandbox'),'/opt/oasis/private/monitor/status.json');
 assert.equal(monitorStatusPath({OASIS_MONITOR_STATUS_FILE:'/opt/oasis/private/production/monitor/status.json'},'production'),'/opt/oasis/private/production/monitor/status.json');
});
