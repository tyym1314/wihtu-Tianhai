import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {ARENA_IDS} from '../shared/games.mjs';
import {runtimeConfiguration} from '../server/runtime-mode.mjs';
import {FIRSTPARTY_FREE_PROFILE as PROFILE,validateFirstpartyAdmission as validate,readProductionAdmission,publicAdmissionCapability,productionAdmissionSnapshot,assertNewFinancialAdmission} from '../server/production-admission.mjs';

const env={OASIS_ENVIRONMENT:'production',OASIS_PUBLIC_ORIGIN:'https://free.example.invalid',OASIS_DATABASE_URL:'postgres://fixture@127.0.0.1/isolated',OASIS_LOCAL_DIR:'/private/fixture',OASIS_START_WALLET:'0',OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_ADMISSION_PROFILE:PROFILE,OASIS_FIRSTPARTY_APP_ID:'app_firstparty_fixture',OASIS_ADMISSION_RELEASE:'/opt/oasis/releases/20261010-99',OASIS_ADMISSION_MANIFEST_SHA256:'a'.repeat(64)};
function fixture(){
 const config=runtimeConfiguration(env),app={id:env.OASIS_FIRSTPARTY_APP_ID,partner_id:'partner_oasis_platform',environment:'production',wallet_scope_id:'wallet_fixture',currency_id:'COIN',currency_scale:2,status:'active',wallet_url:'',allowed_origins:[env.OASIS_PUBLIC_ORIGIN],game_ids:[...ARENA_IDS]};
 const scope={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id};
 const policy={app_id:app.id,profile:PROFILE,state:'open',revision:'1',scope,currency_scale:2,allowed_origins:[...app.allowed_origins],game_ids:[...app.game_ids],release:config.admissionRelease,manifest_sha256:config.admissionManifest,proof_sha256:'b'.repeat(64),approved_by:'reviewed_fixture_operator',approved_at:'2026-10-10T00:00:00.000Z'};
 const binding={provider:'platform',wallet_url:null,wallet_key_id:null,scope};
 const walletScope={...scope,scope_id:Object.values(scope).join(':'),currency_scale:2,treasury_available:'0',treasury_reserved:'0',treasury_inbound:'0',fee_available:'0',fee_pending:'0',ledger_version:'0'};
 return{config,app,policy,binding,walletScope};
}
function room(info){return{game_id:'match',capacity:2,practice:true,entry_minor:'0',fee_bps:0,scope:info.policy.scope,players:[{external_user_id:'real_human',bot:false},{external_user_id:'bot_a',bot:true}],terms:{entry_minor:'0',fee_bps:0,...productionAdmissionSnapshot(validate(info))}};}
const rejects=(f,code)=>assert.throws(f,error=>error.code===code);

test('production generic enable flags cannot unlock any admission',()=>{
 for(const value of ['1','true','yes','',true])assert.throws(()=>runtimeConfiguration({...env,OASIS_PRODUCTION_ADMISSION_ENABLED:value}),/GENERIC_PRODUCTION_ADMISSION_FORBIDDEN/);
 assert.equal(runtimeConfiguration(env).admissionEnabled,false);assert(Object.isFrozen(runtimeConfiguration(env)));
});
test('scoped configuration requires each explicit public identity and immutable source',()=>{
 for(const key of ['OASIS_FIRSTPARTY_APP_ID','OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256']){const value={...env};delete value[key];assert.throws(()=>runtimeConfiguration(value),/FIRSTPARTY_ADMISSION_CONFIG_REQUIRED/);}
 for(const [key,value] of [['OASIS_ADMISSION_PROFILE','full'],['OASIS_FIRSTPARTY_APP_ID','demo'],['OASIS_ADMISSION_RELEASE','/opt/oasis/production-current'],['OASIS_ADMISSION_MANIFEST_SHA256','B'.repeat(64)]])assert.throws(()=>runtimeConfiguration({...env,[key]:value}));
 assert.throws(()=>runtimeConfiguration({...env,OASIS_ADMISSION_PROFILE:'closed'}),/CLOSED_ADMISSION_CONFIG_AMBIGUOUS/);
});
test('matching review opens exactly eleven BOT training games without financial admission',()=>{
 const value=fixture(),info=validate(value),cap=publicAdmissionCapability(info);
 assert.equal(info.open,true);assert.equal(info.game_ids.length,11);assert.deepEqual(cap.allowed_room_modes,['bot-practice']);assert.equal(cap.financial_admission_enabled,false);assert.equal(cap.free_training_only,true);
 assert(!JSON.stringify(cap).includes('proof_sha256'));assert(!JSON.stringify(cap).includes('approved_by'));
});
test('missing, closed or unknown policy never admits new players or sessions',()=>{
 for(const policy of [null,{...fixture().policy,state:'closed'},{...fixture().policy,profile:'partner-full-v1'}])rejects(()=>validate({...fixture(),policy}),policy?.state==='closed'?'PRODUCTION_ACCEPTANCE_REQUIRED':'FIRSTPARTY_POLICY_REQUIRED');
});
test('paused candidate is legal only for explicit activation and metadata',()=>{
 const value=fixture();value.app.status='paused';
 rejects(()=>validate(value),'APP_PAUSED');assert.equal(validate({...value,intent:'activate'}).open,false);assert.equal(validate({...value,intent:'metadata'}).open,false);
});
test('App identity and frozen five-field wallet scope cannot be substituted',()=>{
 for(const mutate of [v=>v.app.id='app_other',v=>v.app.partner_id='partner_thirdparty',v=>v.policy.scope={...v.policy.scope,currency_id:'OTHER'},v=>v.policy.currency_scale=3,v=>v.binding.scope={...v.binding.scope,app_id:'app_other'},v=>v.walletScope.scope_id='wrong_scope']){
  const value=fixture();mutate(value);assert.throws(()=>validate(value));
 }
});
test('HTTPS origins, complete catalog and reviewed source/proof are exact',()=>{
 for(const mutate of [v=>v.policy.allowed_origins=['http://free.example.invalid'],v=>v.app.allowed_origins.push('https://other.example.invalid'),v=>v.policy.game_ids=ARENA_IDS.slice(1),v=>v.app.game_ids.push('tiger'),v=>v.policy.release='/opt/oasis/releases/20261010-98',v=>v.policy.manifest_sha256='c'.repeat(64),v=>v.policy.proof_sha256='invalid',v=>v.policy.approved_by='bad operator',v=>v.policy.approved_at=true,v=>v.policy.revision=true]){
  const value=fixture();mutate(value);assert.throws(()=>validate(value));
 }
 const reversed=fixture();reversed.policy.game_ids.reverse();assert.equal(validate(reversed).game_ids.length,11);
});
test('real first-party ledger must stay zero and cannot use an external/reference wallet',()=>{
 for(const field of ['treasury_available','treasury_reserved','treasury_inbound','fee_available','fee_pending','ledger_version']){const value=fixture();value.walletScope[field]='1';rejects(()=>validate(value),'FIRSTPARTY_FINANCIAL_STATE_NOT_EMPTY');}
 for(const mutate of [v=>v.binding.provider='external',v=>v.app.wallet_url='http://127.0.0.1:8798',v=>v.binding.wallet_key_id='reference_key']){const value=fixture();mutate(value);rejects(()=>validate(value),'PRODUCTION_WALLET_REQUIRED');}
});
test('new room rejects paid, social and nonzero practice requests before server coercion',()=>{
 for(const practice of [false,undefined,'true'])rejects(()=>validate({...fixture(),intent:'room',gameId:'match',practice,entryMinor:'0'}),'FIRSTPARTY_FREE_PRACTICE_ONLY');
 for(const entryMinor of ['1000',0,1,null,'00'])rejects(()=>validate({...fixture(),intent:'room',gameId:'match',practice:true,entryMinor}),'FIRSTPARTY_FREE_PRACTICE_ONLY');
 for(const entryMinor of [undefined,'0'])assert.equal(validate({...fixture(),intent:'room',gameId:'match',practice:true,entryMinor}).open,true);
});
test('closed policy keeps only previously accepted exact free ready obligations',()=>{
 const value=fixture(),accepted=room(value);value.policy.state='closed';value.policy.revision='2';value.app.status='paused';
 assert.equal(validate({...value,intent:'existing-ready',room:accepted}).open,false);
 for(const mutate of [r=>r.practice=false,r=>r.fee_bps=500,r=>r.players[1].bot=false,r=>r.terms.admission_proof_sha256='c'.repeat(64),r=>r.terms.admission_revision='3',r=>r.scope={...r.scope,app_id:'app_other'},r=>r.game_id='tiger']){const broken=structuredClone(accepted);mutate(broken);assert.throws(()=>validate({...value,intent:'existing-ready',room:broken}));}
 rejects(()=>validate({...value,intent:'room',practice:true,entryMinor:'0'}),'PRODUCTION_ACCEPTANCE_REQUIRED');
});
test('transactional read orders current App then policy locks and rejects stale config',async()=>{
 const value=fixture(),queries=[];
 const db={async query(sql){queries.push(sql);return{rows:[sql.includes('gp_apps')?value.app:sql.includes('gp_production_admission')?value.policy:sql.includes('gp_wallet_bindings')?value.binding:value.walletScope]};}};
 assert.equal((await readProductionAdmission(db,value.app,{runtimeConfig:value.config})).open,true);
 assert.match(queries[0],/gp_apps.*FOR SHARE/);assert.match(queries[1],/gp_production_admission.*FOR SHARE/);
 await assert.rejects(readProductionAdmission(db,{...value.app,game_ids:['run']},{runtimeConfig:value.config}),{code:'FIRSTPARTY_APP_CONFIG_CHANGED'});
});
test('production financial admission remains closed independently of matching free approval',async()=>{
 await assert.rejects(assertNewFinancialAdmission(null,fixture().app),{code:'PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED'});
 await assertNewFinancialAdmission(null,{environment:'sandbox'});
});
test('production helper can be imported before runtime without circular initialization',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',"await import('./server/production-admission.mjs');const {runtime}=await import('./server/runtime-mode.mjs');if(runtime.admissionEnabled)process.exit(2)"],{cwd:new URL('../',import.meta.url),env:{...process.env,...env},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
