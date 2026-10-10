import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,createCipheriv} from 'node:crypto';
import {ARENA_IDS} from '../../shared/games.mjs';
import {PRODUCTION_TABLES,PRODUCTION_AUDIT_KEYS,validateExpectation,profileInspectSQL,validateProfileInspection} from './inspect-backup.mjs';

const legacyKeys=['balance_mismatches','scope_mismatches','unbalanced_transactions','ledger_version_mismatches','orphan_records','invalid_constraints','pending_cycles','pending_probability_operations','pending_pvp_operations','active_rooms','pending_wallet_operations','clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches','pending_transfers'];
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
function fixture(){
 const master=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);
 const body=Buffer.concat([cipher.update(JSON.stringify(randomBytes(32).toString('base64'))),cipher.final()]);
 const key=Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
 const runtime_profile={profile:'firstparty-free-v1',public_origin:'https://player.example.test',app_id:'app_history',release:'/opt/oasis/releases/20261010-05',manifest_sha256:'a'.repeat(64)};
 const scope={partner_id:'partner_oasis_platform',app_id:runtime_profile.app_id,environment:'production',wallet_scope_id:'wallet_history',currency_id:'COIN'};
 const current={app_id:scope.app_id,profile:runtime_profile.profile,state:'open',revision:'3',scope,currency_scale:0,allowed_origins:[runtime_profile.public_origin],game_ids:[...ARENA_IDS],release:runtime_profile.release,manifest_sha256:runtime_profile.manifest_sha256,proof_sha256:'b'.repeat(64),approved_by:'admin_history',approved_at:'2026-10-10T03:15:00Z'};
 const previous={...structuredClone(current),revision:'2',release:'/opt/oasis/releases/20261010-04',manifest_sha256:'c'.repeat(64),proof_sha256:'d'.repeat(64),approved_at:'2026-10-10T00:00:00Z'};
 const closed={...structuredClone(previous),revision:'1',state:'closed'};
 const expected={inspection_contract:'production-free-v2',runtime_profile,policy_approvals:[current],historical_policy_approvals:[closed,previous]};
 const app={id:scope.app_id,...scope,wallet_url:'',status:'active',allowed_origins:[runtime_profile.public_origin],game_ids:[...ARENA_IDS],currency_scale:0};
 const binding={app_id:app.id,provider:'platform',wallet_url:null,wallet_key_id:null,scope};
 const walletScope={...scope,scope_id:Object.values(scope).join(':'),currency_scale:0,...Object.fromEntries(['treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version'].map(name=>[name,'0']))};
 const room={game_id:'run',status:'voided',capacity:2,practice:true,entry_minor:'0',fee_bps:0,scope,
  terms:{entry_minor:'0',fee_bps:0,admission_profile:previous.profile,admission_revision:previous.revision,admission_release:previous.release,admission_manifest_sha256:previous.manifest_sha256,admission_proof_sha256:previous.proof_sha256},
  players:[{external_user_id:'human_history',bot:false},{external_user_id:'bot_history',bot:true}]};
 const rows=Object.fromEntries(PRODUCTION_TABLES.map(name=>[name,0]));
 for(const name of ['gp_admins','gp_apps','gp_keys','gp_runtime_identity','gp_wallet_bindings','gp_players','gp_player_sessions','gp_player_app_ids','gp_sessions','gp_launch_codes','gp_launch_intents','wallet_scopes','wallet_users','pvp_rooms','gp_production_admission'])rows[name]=1;
 const value={inspection_contract:'production-free-v2',transfer_schema:'present',rows,audit:Object.fromEntries([...legacyKeys,...PRODUCTION_AUDIT_KEYS].map(name=>[name,0])),keys:[key],profiles:{apps:[app],policies:[structuredClone(current)],bindings:[binding],wallet_scopes:[walletScope],rooms:[room]}};
 const identity={database:'oasis_prod_restore_20261010_'+ 'e'.repeat(16),environment:'production',sandbox_apps:0,reference_keys:0};
 return {master,expected,value,identity,current,previous};
}
const verify=f=>validateProfileInspection(f.value,f.identity,f.master,f.expected);

test('independent prior approval preserves terminal 04 terms while current policy and runtime remain 05',()=>{
 const f=fixture(),before=structuredClone(f.value.profiles.rooms[0]),proof=verify(f);
 assert.equal(proof.profile_snapshot.policy.release,'/opt/oasis/releases/20261010-05');
 assert.equal(proof.profile_snapshot.runtime_profile.manifest_sha256,'a'.repeat(64));
 assert.deepEqual(f.value.profiles.rooms[0],before,'immutable room terms are not rewritten');
 const normalized=validateExpectation(f.expected).historical_policy_approvals;
 assert.equal(proof.profile_snapshot.approved_history_sha256,createHash('sha256').update(canonical(normalized)).digest('hex'));
 assert.doesNotMatch(JSON.stringify(proof),/human_history|bot_history/);
});

test('prior approval cannot masquerade as the current database policy or runtime source',()=>{
 const f=fixture();f.value.profiles.policies=[structuredClone(f.previous)];
 assert.throws(()=>verify(f),/PRODUCTION_POLICY_NOT_INDEPENDENTLY_APPROVED/);
 const g=fixture();g.expected.policy_approvals=[structuredClone(g.previous)];
 assert.throws(()=>validateExpectation(g.expected),/PRODUCTION_POLICY_SNAPSHOT_INVALID/);
});

test('prior room approval is usable only for explicit terminal status',()=>{
 for(const status of [undefined,'waiting','active','unknown']){
  const f=fixture();f.value.profiles.rooms[0].status=status;
  assert.throws(()=>verify(f),/PRODUCTION_RESTORE_ROOM_SNAPSHOT_NOT_APPROVED/);
 }
 for(const status of ['settled','cancelled','voided']){
  const f=fixture();f.value.profiles.rooms[0].status=status;assert.equal(verify(f).row_counts.pvp_rooms,1);
 }
});

test('historical room release, manifest, proof, revision and semantic scope must match the independent entry',()=>{
 for(const change of [r=>r.terms.admission_release='/opt/oasis/releases/20261010-03',r=>r.terms.admission_manifest_sha256='f'.repeat(64),r=>r.terms.admission_proof_sha256='f'.repeat(64),r=>r.terms.admission_revision='1',r=>r.scope={...r.scope,wallet_scope_id:'foreign_wallet'}]){
  const f=fixture();change(f.value.profiles.rooms[0]);assert.throws(()=>verify(f),/PRODUCTION_RESTORE_ROOM_SNAPSHOT_NOT_APPROVED/);
 }
 const missing=fixture();delete missing.expected.historical_policy_approvals;
 assert.throws(()=>verify(missing),/PRODUCTION_RESTORE_ROOM_SNAPSHOT_NOT_APPROVED/);
});

test('history revisions precede every current approval and are unique across both lists',()=>{
 for(const change of [f=>f.expected.historical_policy_approvals[1].revision='3',f=>f.expected.historical_policy_approvals[1].revision='4',f=>f.expected.historical_policy_approvals[1].revision='1',f=>f.expected.policy_approvals.push({...structuredClone(f.current),state:'closed'}),f=>f.expected.policy_approvals.push({...structuredClone(f.current),revision:'2',state:'closed'})]){
  const f=fixture();change(f);assert.throws(()=>validateExpectation(f.expected),/PRODUCTION_POLICY_(?:APPROVAL_HISTORY_AMBIGUOUS|HISTORY_BINDING_CHANGED)/);
 }
});

test('history preserves App, scope, currency, origins and full game-set, and validates source/proof shapes',()=>{
 for(const change of [a=>a.app_id='app_foreign',a=>a.profile='closed',a=>a.scope={...a.scope,currency_id:'OTHER'},a=>a.currency_scale=1,a=>a.allowed_origins.push('https://foreign.example.test'),a=>a.game_ids=['run'],a=>a.release='/opt/oasis/releases/20261010-05',a=>a.release='/tmp/unapproved',a=>a.manifest_sha256='short',a=>a.proof_sha256='short',a=>a.approved_by='',a=>a.approved_at='invalid',a=>a.extra='unknown']){
  const f=fixture();change(f.expected.historical_policy_approvals[1]);assert.throws(()=>validateExpectation(f.expected));
 }
 const sameManifest=fixture();sameManifest.expected.historical_policy_approvals[1].manifest_sha256=sameManifest.current.manifest_sha256;
 assert.doesNotThrow(()=>validateExpectation(sameManifest.expected),'distinct releases may have the same independently bound content manifest');
});

test('no history fields are self approved from backup rows, and empty history keeps prior snapshot bytes',()=>{
 const f=fixture();f.value.profiles.rooms=[];f.value.rows.pvp_rooms=0;
 delete f.expected.historical_policy_approvals;
 const old=verify(f);assert.deepEqual(Object.keys(old.profile_snapshot).sort(),['policy','run_profiles','runtime_profile']);
 f.expected.historical_policy_approvals=[];
 assert.equal(verify(f).profile_snapshot_sha256,old.profile_snapshot_sha256);
 f.value.historical_policy_approvals=[f.previous];f.value.profiles.rooms=[fixture().value.profiles.rooms[0]];f.value.rows.pvp_rooms=1;
 assert.throws(()=>verify(f),/PRODUCTION_RESTORE_ROOM_SNAPSHOT_NOT_APPROVED/);
});

test('history digest canonicalizes order but binds every approved historical field',()=>{
 const f=fixture(),first=verify(f);
 f.expected.historical_policy_approvals.reverse();assert.equal(verify(f).profile_snapshot_sha256,first.profile_snapshot_sha256);
 f.expected.historical_policy_approvals.find(a=>a.state==='closed').proof_sha256='f'.repeat(64);
 assert.notEqual(verify(f).profile_snapshot.approved_history_sha256,first.profile_snapshot.approved_history_sha256);
});

test('historical approval never relaxes financial, pending, identity, or replay integrity audits',()=>{
 for(const key of [...legacyKeys,...PRODUCTION_AUDIT_KEYS]){
  const f=fixture();f.value.audit[key]=1;assert.throws(()=>verify(f),/PRODUCTION_RESTORE_OBLIGATION_OR_INTEGRITY_INVALID/);
 }
 const f=fixture();assert.throws(()=>validateProfileInspection(f.value,f.identity,randomBytes(32),f.expected),'historical approval does not replace the actual master key');
});

test('SQL keeps the read-only transaction and zero audits while observing prior session membership and terminal room status',()=>{
 const f=fixture(),sql=profileInspectSQL(f.expected);
 assert.match(sql,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
 assert.match(sql,/s\.admission_revision::text/);assert.match(sql,/s\.host_origin/);
 assert.ok(sql.includes("r.status IN ('settled','cancelled','voided')"));
 assert.ok(sql.includes("'status',status"));assert.ok(sql.includes('/opt/oasis/releases/20261010-04'));
 for(const key of PRODUCTION_AUDIT_KEYS)assert.ok(sql.includes("'"+key+"'"));
 assert.ok(sql.includes("a.policy->>'proof_sha256'=r.terms->>'admission_proof_sha256'"));
 assert.doesNotMatch(sql,/UPDATE\s|DELETE\s|TRUNCATE\s|CREATE\sTABLE/i);assert.ok(sql.trim().endsWith('COMMIT;'));
});

test('history field is an optional bounded list and closed bootstrap profile cannot accept it',()=>{
 for(const history of [null,undefined,{},Array(257).fill({})]){
  const f=fixture();f.expected.historical_policy_approvals=history;assert.throws(()=>validateExpectation(f.expected),/PRODUCTION_POLICY_HISTORY_INVALID/);
 }
 const f=fixture();f.expected.runtime_profile={profile:'closed',public_origin:f.expected.runtime_profile.public_origin,app_id:null,release:null,manifest_sha256:null};f.expected.policy_approvals=[];
 assert.throws(()=>validateExpectation(f.expected),/PRODUCTION_INSPECTION_PROFILE_INVALID/);
});
