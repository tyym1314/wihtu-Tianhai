import test from 'node:test';
import assert from 'node:assert/strict';
import {RELEASED_IDS,ARENA_IDS} from '../shared/games.mjs';
import {runtimeConfiguration} from '../server/runtime-mode.mjs';
import {FIRSTPARTY_INTERNAL_PROFILE as PROFILE,validateFirstpartyAdmission,readProductionAdmission,publicAdmissionCapability,unitsPerCoin,assertExternalFinancialRouteAllowed} from '../server/production-admission.mjs';
function fixture(){
 const config=runtimeConfiguration({OASIS_ENVIRONMENT:'production',OASIS_PUBLIC_ORIGIN:'https://internal.example.invalid',OASIS_DATABASE_URL:'postgres://fixture@127.0.0.1/isolated',OASIS_LOCAL_DIR:'/private/fixture',OASIS_START_WALLET:'0',OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_ADMISSION_PROFILE:PROFILE,OASIS_FIRSTPARTY_APP_ID:'app_internal_fixture',OASIS_ADMISSION_RELEASE:'/opt/oasis/releases/20990101-99',OASIS_ADMISSION_MANIFEST_SHA256:'a'.repeat(64)});
 const app={id:config.firstpartyAppId,partner_id:'partner_oasis_platform',environment:'production',wallet_scope_id:'wallet_internal_fixture',currency_id:'COIN',currency_scale:0,status:'active',wallet_url:'',allowed_origins:[config.publicOrigin],game_ids:[...RELEASED_IDS]};
 const scope={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id};
 const policy={app_id:app.id,profile:PROFILE,state:'open',revision:'1',scope,currency_scale:app.currency_scale,allowed_origins:app.allowed_origins,game_ids:app.game_ids,release:config.admissionRelease,manifest_sha256:config.admissionManifest,proof_sha256:'b'.repeat(64),approved_by:'isolated_fixture',approved_at:'2026-10-13T00:00:00Z'};
 return{config,app,policy,binding:{provider:'platform',wallet_url:null,wallet_key_id:null,scope},walletScope:{...scope,scope_id:Object.values(scope).join(':'),currency_scale:0,treasury_available:'1000000000',treasury_reserved:'0',treasury_inbound:'0',fee_available:'0',fee_pending:'0',ledger_version:'4'}};
}
test('reviewed internal profile has exact thirteen games, real internal financial capability and no cash gateways',()=>{
 const f=fixture(),info=validateFirstpartyAdmission(f),cap=publicAdmissionCapability(info);
 assert.deepEqual(info.game_ids,RELEASED_IDS);assert.equal(cap.financial_admission_enabled,true);assert.equal(cap.probability_admission_enabled,true);
 for(const key of ['external_financial_admission_enabled','thirdparty_financial_admission_enabled','deposit_enabled','withdrawal_enabled'])assert.equal(cap[key],false);
 assert.equal(cap.coin_scope,'internal-nonredeemable');assert.equal(cap.initial_player_coins,'10000');assert.deepEqual(cap.allowed_room_modes,['bot-practice']);
 for(const gameId of ['thunder','tiger'])assert.equal(validateFirstpartyAdmission({...f,gameId}).open,true);
});
test('catalog, reviewed source, external wallet and financial state drift remain refused',()=>{
 for(const mutate of [f=>f.app.game_ids=[...ARENA_IDS],f=>f.policy.game_ids=[...ARENA_IDS],f=>f.policy.manifest_sha256='c'.repeat(64),f=>f.binding.provider='external',f=>f.walletScope.treasury_available='-1',f=>f.policy.state='closed']){const f=fixture();mutate(f);assert.throws(()=>validateFirstpartyAdmission(f));}
});
test('internal coins do not admit paid arena, social or arbitrary game rooms',()=>{
 const f=fixture();for(const request of [{gameId:'match',practice:false,entryMinor:'1000'},{gameId:'towerlink',practice:false,entryMinor:'0'},{gameId:'other',practice:true}])assert.throws(()=>validateFirstpartyAdmission({...f,intent:'room',...request}));
 assert.equal(validateFirstpartyAdmission({...f,intent:'room',gameId:'match',practice:true,entryMinor:'0'}).open,true);
});
test('cash and third-party route guards refuse real protocol paths independent of body or metadata',()=>{
 const {config}=fixture();for(const path of ['/v1/transfers','/v1/transfers/external_id','/v1/transfer-ledger/gateway/0/latest','/api/player/deposit','/api/player/withdraw','/api/recharge'])assert.throws(()=>assertExternalFinancialRouteAllowed(config,path),{code:'EXTERNAL_FINANCIAL_ADMISSION_DISABLED'});
 for(const path of ['/api/player/app','/api/play/thunder/spin','/api/play/tiger/ack'])assert.doesNotThrow(()=>assertExternalFinancialRouteAllowed(config,path));
});
test('coin precision uses the approved real scope, never a hardcoded hundred',()=>{assert.equal(unitsPerCoin(0),1);assert.equal(unitsPerCoin(2),100);assert.equal(unitsPerCoin(6),1000000);for(const scale of [-1,7,NaN,'2'])assert.throws(()=>unitsPerCoin(scale));});

test('transactional internal approval uses the same advisory-before-wallet order as ledger spending',async()=>{const f=fixture(),calls=[];const db={release(){},async query(sql,args){calls.push([sql,args]);const row=sql.includes('FROM gp_apps')?f.app:sql.includes('FROM gp_production_admission')?f.policy:sql.includes('FROM gp_wallet_bindings')?f.binding:sql.includes('FROM wallet_scopes')?f.walletScope:null;return{rows:row?[row]:[]};}};await readProductionAdmission(db,f.app,{runtimeConfig:f.config});const advisory=calls.findIndex(([sql])=>sql.includes('pg_advisory_xact_lock')),wallet=calls.findIndex(([sql])=>sql.includes('FROM wallet_scopes'));assert.ok(advisory>=0&&wallet>advisory);assert.equal(calls[advisory][1][0],f.walletScope.scope_id);assert.match(calls[wallet][0],/FOR UPDATE$/);});
