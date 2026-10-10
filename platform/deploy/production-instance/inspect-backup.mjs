/** Pure restore inspection and AES-GCM proof. No API, credentials or rows on stdout. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {restoreInspectSQL,restoreAuditSQL,decryptCheck,REQUIRED_TABLES} from '../restore-drill.mjs';
import {ARENA_IDS,allowedCapacity} from '../../shared/games.mjs';
import {RUN_PRACTICE_PROFILES} from '../../shared/run-practice-profiles.mjs';
import {validateFirstpartyAdmission} from '../../server/production-admission.mjs';

export const PRODUCTION_EXTRA_TABLES=['gp_runtime_identity','gp_wallet_bindings','gp_players','gp_player_sessions','gp_player_app_ids','gp_launch_codes','gp_launch_intents','pvp_active_users','pvp_presence','pvp_requests','pvp_run_input_decisions','gp_production_admission'];
export const PRODUCTION_TABLES=[...REQUIRED_TABLES,...PRODUCTION_EXTRA_TABLES];
const policyFields=['app_id','profile','state','revision','scope','currency_scale','allowed_origins','game_ids','release','manifest_sha256','proof_sha256','approved_by','approved_at'];
const scopes=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value),sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=code=>{throw Error(code);};
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const terminalRoom=status=>['settled','cancelled','voided'].includes(status);
function normalizedPolicy(value){
 if(!value||Object.keys(value).sort().join(',')!==[...policyFields].sort().join(','))fail('PRODUCTION_POLICY_SNAPSHOT_INVALID');
 const revision=String(value.revision),at=new Date(value.approved_at);
 if(typeof value.revision!=='string'&&!Number.isSafeInteger(value.revision)||!/^[1-9][0-9]{0,18}$/.test(revision)||BigInt(revision)>9223372036854775807n||typeof value.approved_at!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(value.approved_at)||!Number.isFinite(at.getTime()))fail('PRODUCTION_POLICY_SNAPSHOT_INVALID');
 if(!Array.isArray(value.allowed_origins)||!Array.isArray(value.game_ids))fail('PRODUCTION_POLICY_SNAPSHOT_INVALID');
 return {...value,revision,approved_at:at.toISOString(),allowed_origins:[...value.allowed_origins].sort(),game_ids:[...value.game_ids].sort()};
}
export function validateExpectation(expected){
 if(!expected||expected.inspection_contract!=='production-free-v2'||!Array.isArray(expected.policy_approvals)||expected.policy_approvals.length>256)fail('PRODUCTION_INSPECTION_EXPECTATION_REQUIRED');
 const rawHistory=Object.hasOwn(expected,'historical_policy_approvals')?expected.historical_policy_approvals:[];
 if(!Array.isArray(rawHistory)||rawHistory.length>256)fail('PRODUCTION_POLICY_HISTORY_INVALID');
 const p=expected.runtime_profile;
 if(!p||Object.keys(p).sort().join(',')!=='app_id,manifest_sha256,profile,public_origin,release')fail('PRODUCTION_INSPECTION_PROFILE_INVALID');
 try{const url=new URL(p.public_origin);if(url.protocol!=='https:'||url.origin!==p.public_origin||url.username||url.password)fail('PRODUCTION_INSPECTION_PROFILE_INVALID');}catch{fail('PRODUCTION_INSPECTION_PROFILE_INVALID');}
 const approvals=expected.policy_approvals.map(normalizedPolicy);
 if(p.profile==='closed'){
  if(p.app_id!==null||p.release!==null||p.manifest_sha256!==null||approvals.length||rawHistory.length)fail('PRODUCTION_INSPECTION_PROFILE_INVALID');
 }else{
  if(p.profile!=='firstparty-free-v1'||!id(p.app_id)||!p.app_id.startsWith('app_')||!/^\/opt\/oasis\/releases\/\d{8}-\d{2}$/.test(p.release)||!sha(p.manifest_sha256)||!approvals.length)fail('PRODUCTION_INSPECTION_PROFILE_INVALID');
  for(const a of approvals){
   if(a.app_id!==p.app_id||a.profile!==p.profile||!['open','closed'].includes(a.state)||a.release!==p.release||a.manifest_sha256!==p.manifest_sha256||!sha(a.proof_sha256)||!id(a.approved_by)||!Number.isInteger(a.currency_scale)||a.currency_scale<0||a.currency_scale>6||!a.scope||Object.keys(a.scope).sort().join(',')!==[...scopes].sort().join(',')||scopes.some(k=>!id(a.scope[k]))||a.scope.app_id!==p.app_id||a.scope.environment!=='production'||a.scope.partner_id!=='partner_oasis_platform'||!a.allowed_origins.includes(p.public_origin)||a.game_ids.length!==ARENA_IDS.length||new Set(a.game_ids).size!==a.game_ids.length||a.game_ids.some(game=>!ARENA_IDS.includes(game)))fail('PRODUCTION_POLICY_SNAPSHOT_INVALID');
   if(new Set(a.allowed_origins).size!==a.allowed_origins.length||a.allowed_origins.some(origin=>{try{const u=new URL(origin);return u.protocol!=='https:'||u.origin!==origin||!!u.username||!!u.password;}catch{return true;}}))fail('PRODUCTION_POLICY_SNAPSHOT_INVALID');
  }
  if(new Set(approvals.map(canonical)).size!==approvals.length)fail('PRODUCTION_POLICY_APPROVAL_HISTORY_AMBIGUOUS');
 }
 // Only an independently validated marker supplies this history. Never derive
 // approvals from restored rows; current policy remains current-source-only.
 const history=rawHistory.map(normalizedPolicy);
 if(history.length){
  const binding=a=>canonical({app_id:a.app_id,profile:a.profile,scope:a.scope,currency_scale:a.currency_scale,allowed_origins:a.allowed_origins,game_ids:a.game_ids});
  const stable=binding(approvals[0]),firstRevision=approvals.reduce((min,a)=>BigInt(a.revision)<min?BigInt(a.revision):min,BigInt(approvals[0].revision));
  if(approvals.some(a=>binding(a)!==stable)||new Set([...approvals,...history].map(a=>a.revision)).size!==approvals.length+history.length)fail('PRODUCTION_POLICY_APPROVAL_HISTORY_AMBIGUOUS');
  for(const a of history){
   if(a.release===p.release||BigInt(a.revision)>=firstRevision||binding(a)!==stable)fail('PRODUCTION_POLICY_HISTORY_BINDING_CHANGED');
   // Reuse the strict policy/source-shape contract with this prior source, then
   // bind its stable App identity and revision range to the current approvals.
   validateExpectation({inspection_contract:expected.inspection_contract,runtime_profile:{...p,release:a.release,manifest_sha256:a.manifest_sha256},policy_approvals:[a]});
  }
 }
 return {...expected,policy_approvals:approvals,historical_policy_approvals:history};
}

export const PRODUCTION_AUDIT_KEYS=['player_session_orphans','player_app_identity_errors','player_arena_identity_errors','wallet_player_identity_errors','launch_scope_errors','active_user_scope_errors','request_scope_errors','run_decision_errors','run_profile_errors','admission_snapshot_errors','nonzero_financial_state','financial_rows','financial_obligations'];
const runProfiles=Object.values(RUN_PRACTICE_PROFILES).map(({ruleVersion,protocol,profileId})=>({ruleVersion,protocol,profileId}));
function extraAuditSQL(expected){
 const approved=quote(JSON.stringify([...expected.policy_approvals,...expected.historical_policy_approvals]));
 const currentRelease=expected.runtime_profile.release===null?'NULL':quote(expected.runtime_profile.release);
 return `WITH approved AS (SELECT value AS policy FROM jsonb_array_elements(${approved}::jsonb)), run_profiles AS (SELECT value AS profile FROM jsonb_array_elements(${quote(JSON.stringify(runProfiles))}::jsonb)),
 player_identity_errors AS (
 SELECT 1 FROM gp_player_app_ids m LEFT JOIN gp_players p ON p.id=m.player_id LEFT JOIN gp_apps a ON a.id=m.app_id WHERE p.id IS NULL OR a.id IS NULL
 UNION ALL SELECT 1 FROM gp_sessions s LEFT JOIN gp_player_app_ids m ON m.app_id=s.app_id AND m.player_id=s.player_id WHERE s.player_id IS NULL OR m.player_id IS NULL OR s.external_user_id IS DISTINCT FROM m.external_user_id
 UNION ALL SELECT 1 FROM pvp_rooms r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.players)='array' THEN r.players ELSE '[]'::jsonb END) member LEFT JOIN gp_player_app_ids m ON m.app_id=r.app_id AND m.external_user_id=member->>'external_user_id' WHERE member->'bot'='false'::jsonb AND m.player_id IS NULL
 ), snapshot_errors AS (
 SELECT 1 FROM gp_sessions s WHERE NOT EXISTS(SELECT 1 FROM approved a WHERE a.policy->>'state'='open' AND a.policy->>'app_id'=s.app_id AND a.policy->>'profile'=s.admission_profile AND a.policy->>'revision'=s.admission_revision::text AND a.policy->'game_ids' ? s.game_id AND a.policy->'allowed_origins' ? s.host_origin)
 UNION ALL SELECT 1 FROM pvp_rooms r WHERE NOT EXISTS(SELECT 1 FROM approved a WHERE a.policy->>'state'='open' AND a.policy->>'app_id'=r.app_id AND a.policy->>'profile'=r.terms->>'admission_profile' AND a.policy->>'revision'=r.terms->>'admission_revision' AND a.policy->>'release'=r.terms->>'admission_release' AND a.policy->>'manifest_sha256'=r.terms->>'admission_manifest_sha256' AND a.policy->>'proof_sha256'=r.terms->>'admission_proof_sha256' AND a.policy->'scope'=r.scope AND a.policy->'game_ids' ? r.game_id AND (a.policy->>'release'=${currentRelease} OR r.status IN ('settled','cancelled','voided')))
 ), run_errors AS (
 SELECT 1 FROM pvp_run_input_decisions d LEFT JOIN pvp_rooms r ON r.id=d.room_id WHERE r.id IS NULL OR r.game_id!='run' OR r.run_input_state IS NULL OR r.run_input_state->>'roomId' IS DISTINCT FROM r.id OR r.run_input_state->>'playerKey' IS DISTINCT FROM d.external_user_id OR d.decision->>'commandSeq' IS DISTINCT FROM d.command_seq::text OR d.decision->>'outcome' IS NULL OR d.decision->>'outcome' NOT IN ('accepted','rejected') OR jsonb_typeof(d.decision) IS DISTINCT FROM 'object' OR d.decision ? 'duplicate' OR NOT(d.decision ?& ARRAY['commandSeq','type','executeTick','clockEpoch','outcome','code','acceptedInputNo','decidedAtServerTick','revision']) OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(d.decision)='object' THEN d.decision ELSE '{}'::jsonb END))!=9 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.players)='array' THEN r.players ELSE '[]'::jsonb END) m WHERE m->>'external_user_id'=d.external_user_id AND m->'bot'='false'::jsonb)
 )
 SELECT json_build_object(
 'player_session_orphans',(SELECT count(*) FROM gp_player_sessions s LEFT JOIN gp_players p ON p.id=s.player_id WHERE p.id IS NULL),
 'player_app_identity_errors',(SELECT count(*) FROM gp_player_app_ids m LEFT JOIN gp_apps a ON a.id=m.app_id LEFT JOIN gp_players p ON p.id=m.player_id WHERE a.id IS NULL OR p.id IS NULL),
 'player_arena_identity_errors',(SELECT count(*) FROM player_identity_errors),
 'wallet_player_identity_errors',((SELECT count(*) FROM wallet_users u LEFT JOIN wallet_scopes s ON s.scope_id=u.scope_id LEFT JOIN gp_player_app_ids m ON m.app_id=s.app_id AND m.external_user_id=u.external_user_id WHERE s.scope_id IS NULL OR m.player_id IS NULL)+(SELECT count(*) FROM gp_player_app_ids m LEFT JOIN gp_apps a ON a.id=m.app_id LEFT JOIN wallet_scopes s ON s.app_id=a.id AND s.partner_id=a.partner_id AND s.environment=a.environment AND s.wallet_scope_id=a.wallet_scope_id AND s.currency_id=a.currency_id LEFT JOIN wallet_users u ON u.scope_id=s.scope_id AND u.external_user_id=m.external_user_id WHERE s.scope_id IS NULL OR u.external_user_id IS NULL)),
 'launch_scope_errors',((SELECT count(*) FROM gp_launch_codes c LEFT JOIN gp_sessions s ON s.id=c.session_id WHERE s.id IS NULL OR c.host_origin IS DISTINCT FROM s.host_origin)+(SELECT count(*) FROM gp_launch_intents i LEFT JOIN gp_apps a ON a.id=i.app_id WHERE a.id IS NULL)),
 'active_user_scope_errors',((SELECT count(*) FROM pvp_active_users u LEFT JOIN pvp_rooms r ON r.id=u.room_id WHERE r.id IS NULL OR r.app_id IS DISTINCT FROM u.app_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.players)='array' THEN r.players ELSE '[]'::jsonb END) member WHERE member->>'external_user_id'=u.external_user_id))+(SELECT count(*) FROM pvp_presence p LEFT JOIN pvp_rooms r ON r.id=p.room_id WHERE r.id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.players)='array' THEN r.players ELSE '[]'::jsonb END) member WHERE member->>'external_user_id'=p.external_user_id))),
 'request_scope_errors',(SELECT count(*) FROM pvp_requests q LEFT JOIN gp_apps a ON a.id=q.app_id LEFT JOIN gp_player_app_ids m ON m.app_id=q.app_id AND m.external_user_id=q.external_user_id LEFT JOIN pvp_rooms r ON r.id=q.room_id WHERE a.id IS NULL OR m.player_id IS NULL OR q.room_id IS NOT NULL AND (r.id IS NULL OR r.app_id IS DISTINCT FROM q.app_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.players)='array' THEN r.players ELSE '[]'::jsonb END) member WHERE member->>'external_user_id'=q.external_user_id AND member->'bot'='false'::jsonb))),
 'run_decision_errors',(SELECT count(*) FROM run_errors),
 'run_profile_errors',(SELECT count(*) FROM pvp_rooms r WHERE (r.terms ? 'run_input_protocol' OR r.run_input_state IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM run_profiles p WHERE r.game_id='run' AND r.practice AND r.entry_minor=0 AND r.fee_bps=0 AND p.profile->>'ruleVersion'=r.rule_version AND p.profile->>'protocol'=r.terms->>'run_input_protocol' AND coalesce(r.terms->'run_input_profile','null'::jsonb)=p.profile->'profileId' AND (r.run_input_state IS NULL AND r.status IN ('cancelled','voided') OR r.run_input_state->>'protocol'=p.profile->>'protocol' AND coalesce(r.run_input_state->'profileId','null'::jsonb)=p.profile->'profileId' AND r.run_input_state->>'roomId'=r.id AND r.run_input_state->>'entryMinor'='0' AND r.run_input_state->'practice'='true'::jsonb AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.players)='array' THEN r.players ELSE '[]'::jsonb END) member WHERE member->>'external_user_id'=r.run_input_state->>'playerKey' AND member->'bot'='false'::jsonb)))),
 'admission_snapshot_errors',(SELECT count(*) FROM snapshot_errors),
 'nonzero_financial_state',((SELECT count(*) FROM wallet_users WHERE available!=0 OR reserved!=0 OR credit_pending!=0)+(SELECT count(*) FROM wallet_scopes WHERE treasury_available!=0 OR treasury_reserved!=0 OR treasury_inbound!=0 OR fee_available!=0 OR fee_pending!=0 OR ledger_version!=0)+(SELECT count(*) FROM wallet_transfer_clearing WHERE net_minor!=0)),
 'financial_rows',((SELECT count(*) FROM wallet_ledger)+(SELECT count(*) FROM gp_cycles)+(SELECT count(*) FROM gp_plays)+(SELECT count(*) FROM gp_operations)+(SELECT count(*) FROM pvp_operations)+(SELECT count(*) FROM wallet_operations)+(SELECT count(*) FROM wallet_matches)+(SELECT count(*) FROM wallet_reservations)+(SELECT count(*) FROM wallet_probability)+(SELECT count(*) FROM gp_transfers)+(SELECT count(*) FROM gp_transfer_outbox)),
 'financial_obligations',((SELECT count(*) FROM wallet_reservations WHERE state='RESERVED')+(SELECT count(*) FROM wallet_matches WHERE state NOT IN ('SETTLED','VOIDED','CANCELLED'))+(SELECT count(*) FROM wallet_probability WHERE state NOT IN ('SETTLED','CANCELLED','EXPIRED'))+(SELECT count(*) FROM gp_integration_checks WHERE status IN ('QUEUED','RUNNING'))))`;
}

export function profileInspectSQL(expected){
 expected=validateExpectation(expected);
 const tables=PRODUCTION_TABLES.map(name=>`'${name}',(SELECT count(*) FROM ${name})`).join(','),audit=restoreAuditSQL().trim().replace(/;$/,'');
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL search_path=pg_catalog,public;\nSET LOCAL statement_timeout='30s';
 SELECT count(c.oid)=${PRODUCTION_TABLES.length} AND bool_and(c.relkind='r') AS production_schema_present FROM (VALUES ${PRODUCTION_TABLES.map(name=>`('${name}')`).join(',')}) t(name) LEFT JOIN pg_namespace n ON n.nspname='public' LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=t.name
 \\gset
 \\if :production_schema_present
 SELECT json_build_object('inspection_contract','production-free-v2','transfer_schema','present',
 'rows',json_build_object(${tables}), 'audit',((${audit})::jsonb || (${extraAuditSQL(expected)})::jsonb),
 'keys',(SELECT COALESCE(json_agg(secret_enc),'[]'::json) FROM gp_keys),
 'profiles',json_build_object(
 'apps',(SELECT COALESCE(json_agg(json_build_object('id',id,'partner_id',partner_id,'environment',environment,'wallet_scope_id',wallet_scope_id,'currency_id',currency_id,'currency_scale',currency_scale,'wallet_url',wallet_url,'status',status,'allowed_origins',allowed_origins,'game_ids',game_ids)),'[]'::json) FROM gp_apps),
 'policies',(SELECT COALESCE(json_agg(json_build_object(${policyFields.map(key=>`'${key}',${key==='revision'?'revision::text':key}`).join(',')})),'[]'::json) FROM gp_production_admission),
 'bindings',(SELECT COALESCE(json_agg(json_build_object('app_id',app_id,'provider',provider,'wallet_url',wallet_url,'wallet_key_id',wallet_key_id,'scope',scope)),'[]'::json) FROM gp_wallet_bindings),
 'wallet_scopes',(SELECT COALESCE(json_agg(json_build_object(${['scope_id',...scopes,'currency_scale','treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version'].map(key=>`'${key}',${key.includes('available')||key.includes('reserved')||key.includes('inbound')||key.includes('pending')||key==='ledger_version'?key+'::text':key}`).join(',')})),'[]'::json) FROM wallet_scopes),
 'rooms',(SELECT COALESCE(json_agg(json_build_object('game_id',game_id,'status',status,'capacity',capacity,'practice',practice,'entry_minor',entry_minor::text,'fee_bps',fee_bps,'terms',terms,'scope',scope,'players',players)),'[]'::json) FROM pvp_rooms)));
 SELECT json_build_object('environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),'sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment!='production'),'reference_keys',(SELECT count(*) FROM gp_keys WHERE direction='platform-to-wallet'),'database',current_database()) AS identity;
 \\else
 DO $production_guard$ BEGIN RAISE EXCEPTION 'PRODUCTION_RESTORE_SCHEMA_INVALID'; END $production_guard$;
 \\endif
 COMMIT;`;
}

export function validateProfileInspection(value,identity,master,expected){
 expected=validateExpectation(expected);
 if(value?.inspection_contract!=='production-free-v2'||value.transfer_schema!=='present'||identity?.environment!=='production'||identity.sandbox_apps!==0||identity.reference_keys!==0||!Array.isArray(value.keys)||!value.keys.length||value.rows?.gp_keys!==value.keys.length)fail('PRODUCTION_RESTORE_IDENTITY_INVALID');
 if(Object.keys(value.rows||{}).length!==PRODUCTION_TABLES.length||PRODUCTION_TABLES.some(k=>!Number.isSafeInteger(value.rows[k])||value.rows[k]<0))fail('PRODUCTION_RESTORE_SCHEMA_INVALID');
 if(value.rows.gp_runtime_identity!==1)fail('PRODUCTION_RESTORE_IDENTITY_INVALID');
 const keys=[...Object.keys(legacyAudit()),...PRODUCTION_AUDIT_KEYS];
 if(Object.keys(value.audit||{}).length!==keys.length||keys.some(k=>!Number.isSafeInteger(value.audit[k])||value.audit[k]<0))fail('PRODUCTION_RESTORE_AUDIT_INVALID');
 if(keys.some(k=>value.audit[k]!==0))fail('PRODUCTION_RESTORE_OBLIGATION_OR_INTEGRITY_INVALID');
 const profiles=value.profiles,p=expected.runtime_profile;
 if(!profiles||!['apps','policies','bindings','wallet_scopes','rooms'].every(k=>Array.isArray(profiles[k])))fail('PRODUCTION_RESTORE_PROFILE_INVALID');
 for(const key of ['apps','policies','bindings','wallet_scopes','rooms'])if(profiles[key].length!==value.rows[{apps:'gp_apps',policies:'gp_production_admission',bindings:'gp_wallet_bindings',wallet_scopes:'wallet_scopes',rooms:'pvp_rooms'}[key]])fail('PRODUCTION_RESTORE_PROFILE_COUNT_INVALID');
 let policy=null;
 if(p.profile==='closed'){
  if(profiles.policies.length||profiles.rooms.length||value.rows.gp_sessions||profiles.apps.some(app=>app.status!=='paused'))fail('PRODUCTION_RESTORE_CLOSED_ACTIVITY_INVALID');
  if(profiles.apps.length!==1||profiles.bindings.length!==1||profiles.wallet_scopes.length!==1)fail('PRODUCTION_RESTORE_PROFILE_SCOPE_INVALID');
  const app=profiles.apps[0],binding=profiles.bindings[0],wallet=profiles.wallet_scopes[0],scope={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id};
  if(app.partner_id!=='partner_oasis_platform'||app.environment!=='production'||app.wallet_url!==''||!Array.isArray(app.allowed_origins)||!app.allowed_origins.includes(p.public_origin)||!Array.isArray(app.game_ids)||app.game_ids.length!==ARENA_IDS.length||new Set(app.game_ids).size!==ARENA_IDS.length||app.game_ids.some(game=>!ARENA_IDS.includes(game))||binding.app_id!==app.id||binding.provider!=='platform'||binding.wallet_url!==null||binding.wallet_key_id!==null||!binding.scope||scopes.some(key=>binding.scope[key]!==scope[key]||wallet[key]!==scope[key])||wallet.scope_id!==scopes.map(key=>scope[key]).join(':')||wallet.currency_scale!==app.currency_scale)fail('PRODUCTION_RESTORE_PROFILE_SCOPE_INVALID');
 }else{
  if(profiles.apps.length!==1||profiles.policies.length!==1||profiles.bindings.length!==1||profiles.wallet_scopes.length!==1)fail('PRODUCTION_RESTORE_PROFILE_SCOPE_INVALID');
  const app=profiles.apps[0];policy=normalizedPolicy(profiles.policies[0]);
  if(!expected.policy_approvals.some(approved=>canonical(approved)===canonical(policy)))fail('PRODUCTION_POLICY_NOT_INDEPENDENTLY_APPROVED');
  validateFirstpartyAdmission({config:{production:true,admissionEnabled:false,admissionProfile:p.profile,firstpartyAppId:p.app_id,admissionRelease:p.release,admissionManifest:p.manifest_sha256,publicOrigin:p.public_origin},app,policy,binding:profiles.bindings[0],walletScope:profiles.wallet_scopes[0],intent:'metadata'});
  if(policy.state==='closed'&&app.status!=='paused'||policy.state==='open'&&app.status!=='active')fail('PRODUCTION_RESTORE_APP_POLICY_STATE_CHANGED');
  for(const room of profiles.rooms){
   if(!ARENA_IDS.includes(room.game_id)||!allowedCapacity(room.game_id,room.capacity)||room.practice!==true||room.entry_minor!=='0'||room.fee_bps!==0||room.terms?.entry_minor!=='0'||room.terms?.fee_bps!==0||!Array.isArray(room.players)||room.players.length!==room.capacity||room.players.filter(player=>player.bot===false).length!==1||room.players.filter(player=>player.bot===true).length!==room.capacity-1||new Set(room.players.map(player=>player.external_user_id)).size!==room.capacity)fail('PRODUCTION_RESTORE_ROOM_PROFILE_INVALID');
   const accepted=approved=>approved.state==='open'&&room.terms.admission_profile===approved.profile&&String(room.terms.admission_revision)===approved.revision&&room.terms.admission_release===approved.release&&room.terms.admission_manifest_sha256===approved.manifest_sha256&&room.terms.admission_proof_sha256===approved.proof_sha256&&approved.game_ids.includes(room.game_id)&&canonical(room.scope)===canonical(approved.scope);
   if(!expected.policy_approvals.some(accepted)&&!(terminalRoom(room.status)&&expected.historical_policy_approvals.some(accepted)))fail('PRODUCTION_RESTORE_ROOM_SNAPSHOT_NOT_APPROVED');
  }
 }
 for(const key of value.keys)decryptCheck(master,key);
 const snapshot={runtime_profile:p,policy,run_profiles:runProfiles};
 if(expected.historical_policy_approvals.length){
  const ordered=[...expected.historical_policy_approvals].sort((a,b)=>BigInt(a.revision)<BigInt(b.revision)?-1:1);
  snapshot.approved_history_sha256=createHash('sha256').update(canonical(ordered)).digest('hex');
 }
 return {environment:'production',inspection_contract:expected.inspection_contract,master_key_sha256:createHash('sha256').update(master).digest('hex'),decrypted_keys:value.keys.length,row_counts:value.rows,audit:value.audit,profile_snapshot:snapshot,profile_snapshot_sha256:createHash('sha256').update(canonical(snapshot)).digest('hex')};
}
function legacyAudit(){return Object.fromEntries(['balance_mismatches','scope_mismatches','unbalanced_transactions','ledger_version_mismatches','orphan_records','invalid_constraints','pending_cycles','pending_probability_operations','pending_pvp_operations','active_rooms','pending_wallet_operations','clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches','pending_transfers'].map(key=>[key,0]));}

export function inspectSQL(){return restoreInspectSQL().replace(/COMMIT;$/,`SELECT json_build_object(
 'environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),
 'sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment!='production'),
 'reference_keys',(SELECT count(*) FROM gp_keys WHERE direction='platform-to-wallet'),
 'database',current_database()) AS identity;\nCOMMIT;`);}
export function validateInspection(value,identity,master){
 if(value?.transfer_schema!=='present'||!Array.isArray(value?.keys)||value.keys.length<1||value.rows?.gp_keys!==value.keys.length||identity?.environment!=='production'||identity.sandbox_apps!==0||identity.reference_keys!==0)throw Error('PRODUCTION_RESTORE_IDENTITY_INVALID');
 if(Object.keys(value.rows||{}).length!==REQUIRED_TABLES.length||REQUIRED_TABLES.some(k=>!Number.isSafeInteger(value.rows[k])||value.rows[k]<0))throw Error('PRODUCTION_RESTORE_SCHEMA_INVALID');
 if(Object.keys(value.audit||{}).length!==15||Object.values(value.audit).some(x=>!Number.isSafeInteger(x)||x<0))throw Error('PRODUCTION_RESTORE_AUDIT_INVALID');
 const pending=['pending_cycles','pending_probability_operations','pending_pvp_operations','active_rooms','pending_wallet_operations','pending_transfers'];
 for(const [key,count] of Object.entries(value.audit))if(!pending.includes(key)&&count!==0)throw Error('PRODUCTION_RESTORE_LEDGER_INVALID');
 for(const secret of value.keys)decryptCheck(master,secret);
 return {environment:identity.environment,master_key_sha256:createHash('sha256').update(master).digest('hex'),decrypted_keys:value.keys.length,row_counts:value.rows,audit:value.audit};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{
  const readInput=async()=>{const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>8388608)throw Error('PRODUCTION_RESTORE_INPUT_TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks));};
  if(process.argv[2]==='sql'&&process.argv.length===3){const {expected}=await readInput();process.stdout.write(profileInspectSQL(expected));}
  else if(process.argv[2]==='verify'&&process.argv.length===4){
   const {data,identity,expected}=await readInput(),master=await readFile(process.argv[3]);
   try{process.stdout.write(JSON.stringify(validateProfileInspection(data,identity,master,expected))+'\n');}finally{master.fill(0);}
  }else throw Error('PRODUCTION_RESTORE_ARGUMENT_INVALID');
 }catch(error){process.stderr.write((/^[A-Z0-9_]+$/.test(error.message)?error.message:'PRODUCTION_RESTORE_VERIFY_FAILED')+'\n');process.exitCode=2;}
}
