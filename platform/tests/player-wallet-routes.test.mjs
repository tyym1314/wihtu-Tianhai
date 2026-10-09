import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerFixture} from './player-hosted-fixture.mjs';

let fixture,serial=0,owner,other;
const password='Wallet-player-fixture-2026!';
const request=(path,options={})=>fixture.request(path,{...options,headers:{'x-real-ip':`198.19.6.${++serial}`,...options.headers}});
const path=()=>'/api/player/wallet?app_id='+fixture.app.id;
async function account(username){
 const body={app_id:fixture.app.id,username,password};const registered=await request('/api/player/register',{body});assert.equal(registered.status,201);
 const login=await request('/api/player/login',{body});assert.equal(login.status,200);return{...registered.body,login};
}
before(async()=>{fixture=await createPlayerFixture();owner=await account('wallet_owner');other=await account('wallet_other');});
after(async()=>{await fixture?.close();});

test('wallet GET requires live cookie identity and returns scoped, exact zero MoneyBalance without writes',async()=>{
 assert.equal((await request(path())).body.error.code,'LOGIN_REQUIRED');
 assert.equal((await request(path(),{headers:{cookie:'__Host-oasis_player=forged'}})).status,401);
 const before=(await fixture.pool.query('SELECT count(*)::int count FROM wallet_ledger')).rows[0].count;
 const result=await request(path(),{cookie:owner.login.cookie});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
 assert.equal(result.body.app_id,fixture.app.id);assert.equal(result.body.environment,'production');assert.equal(result.body.currency_id,'COIN');
 assert.deepEqual(result.body.balance,{external_user_id:owner.login.body.external_user_id,available_minor:'0',reserved_minor:'0',currency_scale:2,ledger_version:'0'});
 assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM wallet_ledger')).rows[0].count,before);
 assert.equal((await request(path(),{body:{},cookie:owner.login.cookie})).status,405);
});

test('wallet identity is derived from cookie and existing App mapping; forged user and wrong App cannot open accounts',async()=>{
 const otherResult=await request(path(),{cookie:other.login.cookie});assert.equal(otherResult.body.balance.external_user_id,other.login.body.external_user_id);
 assert.notEqual(otherResult.body.balance.external_user_id,owner.login.body.external_user_id);
 for(const query of ['&external_user_id='+other.login.body.external_user_id,'&app_id='+fixture.app.id,'&return_url=https://evil.invalid'])assert.equal((await request(path()+query,{cookie:owner.login.cookie})).status,400);
 const platform=await import('../server/platform.mjs'),unjoined=(await platform.createApp('Unjoined real App',{partnerId:'wallet_other_partner'})).app;
 const before=(await fixture.pool.query('SELECT count(*)::int count FROM wallet_users')).rows[0].count;
 const denied=await request('/api/player/wallet?app_id='+unjoined.id,{cookie:owner.login.cookie});assert.equal(denied.status,403);assert.equal(denied.body.error.code,'SCOPE_FORBIDDEN');
 assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM wallet_users')).rows[0].count,before);
 assert.equal((await fixture.pool.query('SELECT 1 FROM gp_player_app_ids WHERE app_id=$1',[unjoined.id])).rowCount,0);
 assert.equal((await request('/api/player/wallet?app_id=unknown',{cookie:owner.login.cookie})).status,404);
});

test('closed production admission retains a read-only own-wallet view for previously mapped players',async()=>{
 fixture.runtime.admissionEnabled=false;await fixture.pool.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[fixture.app.id]);
 try{const result=await request(path(),{cookie:owner.login.cookie});assert.equal(result.status,200);assert.equal(result.body.balance.available_minor,'0');}
 finally{fixture.runtime.admissionEnabled=true;await fixture.pool.query("UPDATE gp_apps SET status='active' WHERE id=$1",[fixture.app.id]);}
});

test('real wallet response preserves minor strings and scale six without rounding to zero',async()=>{
 const user=owner.login.body.external_user_id,db=fixture.pool;
 // Only this newly created, isolated fixture is changed to exercise display precision.
 await db.query('UPDATE gp_apps SET currency_scale=6 WHERE id=$1',[fixture.app.id]);
 await db.query('UPDATE wallet_scopes SET currency_scale=6 WHERE app_id=$1',[fixture.app.id]);
 await db.query('UPDATE wallet_users SET available=1,reserved=2 WHERE external_user_id=$1',[user]);
 try{const result=await request(path(),{cookie:owner.login.cookie});assert.equal(result.status,200);assert.equal(result.body.balance.available_minor,'1');assert.equal(result.body.balance.reserved_minor,'2');assert.equal(result.body.balance.currency_scale,6);}
 finally{
  await db.query('UPDATE wallet_users SET available=0,reserved=0 WHERE external_user_id=$1',[user]);
  await db.query('UPDATE wallet_scopes SET currency_scale=2 WHERE app_id=$1',[fixture.app.id]);
  await db.query('UPDATE gp_apps SET currency_scale=2 WHERE id=$1',[fixture.app.id]);
 }
});

test('missing account and broken wallet binding fail explicitly and never fabricate a balance',async()=>{
 const user=owner.login.body.external_user_id,db=fixture.pool;
 await db.query('DELETE FROM wallet_users WHERE external_user_id=$1',[user]);
 try{const result=await request(path(),{cookie:owner.login.cookie});assert.equal(result.status,404);assert.equal(result.body.balance,undefined);}
 finally{await (await import('../server/platform-wallet.mjs')).ensurePlatformWalletAccount(db,fixture.app.id,owner.player.id,user);}
 await db.query("UPDATE gp_apps SET wallet_url='https://broken.example.invalid' WHERE id=$1",[fixture.app.id]);
 try{const result=await request(path(),{cookie:owner.login.cookie});assert.equal(result.status,503);assert.equal(result.body.error.code,'WALLET_BINDING_CHANGED');assert.equal(result.body.balance,undefined);}
 finally{await db.query("UPDATE gp_apps SET wallet_url='' WHERE id=$1",[fixture.app.id]);}
});

test('revoked login cannot read its retained wallet account',async()=>{
 await fixture.pool.query('DELETE FROM gp_player_sessions WHERE player_id=$1',[other.player.id]);
 assert.equal((await request(path(),{cookie:other.login.cookie})).status,401);
 assert.equal((await fixture.pool.query('SELECT 1 FROM wallet_users WHERE external_user_id=$1',[other.login.body.external_user_id])).rowCount,1);
});
