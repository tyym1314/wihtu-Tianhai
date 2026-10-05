import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';

const evidence=JSON.parse(fs.readFileSync(new URL('../review/phase-e/ui-validation.json',import.meta.url)));
assert(!evidence.failure,'UI run must pass before wallet readback');
assert.equal(evidence.multiplayer.length,3);
const partialPath=new URL('../review/phase-e/ui-validation-partial.json',import.meta.url);
const extra=fs.existsSync(partialPath)?JSON.parse(fs.readFileSync(partialPath)):null;
if(extra)assert(!extra.failure,'partial UI run must pass');
const practice=[...new Map([...evidence.games,...(extra?.games||[])].map(g=>[g.roomId,g])).values()];
const db=new pg.Pool({connectionString:process.env.OASIS_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/oasis_platform'});
const report={at:new Date().toISOString(),matches:[],practice:[]};
try{
 for(const sample of evidence.multiplayer){
  const rows=(await db.query('SELECT m.* FROM wallet_matches m JOIN wallet_scopes s USING(scope_id) JOIN pvp_rooms r ON r.id=m.match_id AND r.app_id=s.app_id WHERE m.match_id=$1',[sample.roomId])).rows;
  assert.equal(rows.length,1,'one wallet match for this App');
  const m=rows[0];assert.equal(m.state,'SETTLED');assert.equal(m.pool_minor,'0');
  assert.equal(m.captured_minor,sample.frozenTerms.poolMinor);assert.equal(m.fee_minor,sample.feeMinor);
  assert.equal(m.payouts.reduce((n,p)=>n+BigInt(p.payout_minor),0n)+BigInt(m.fee_minor),BigInt(m.captured_minor));
  const room=(await db.query('SELECT result_hash,result FROM pvp_rooms WHERE id=$1',[sample.roomId])).rows[0];
  assert.equal(m.result_hash,room.result_hash);assert.deepEqual(m.payouts,room.result.payouts);
  const ledger=(await db.query('SELECT operation_id,account,delta_available,delta_reserved FROM wallet_ledger WHERE scope_id=$1 AND operation_id=ANY($2) ORDER BY id',[m.scope_id,[m.capture_operation_id,m.settlement_operation_id]])).rows;
  for(const op of [m.capture_operation_id,m.settlement_operation_id]){
   const entries=ledger.filter(l=>l.operation_id===op);assert(entries.length>0);
   assert.equal(entries.reduce((n,l)=>n+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n),0n,'ledger balances per operation');
  }
  const paid=ledger.filter(l=>l.operation_id===m.settlement_operation_id);
  assert.equal(paid.filter(l=>l.account==='fee').reduce((n,l)=>n+BigInt(l.delta_available),0n),BigInt(m.fee_minor));
  for(const p of m.payouts)assert.equal(paid.filter(l=>l.account==='user:'+p.external_user_id).reduce((n,l)=>n+BigInt(l.delta_available),0n),BigInt(p.payout_minor));
  report.matches.push({game:sample.game,match_id:sample.roomId,state:m.state,captured_minor:m.captured_minor,fee_minor:m.fee_minor,payouts:m.payouts,result_hash:m.result_hash,capture_operation_id:m.capture_operation_id,settlement_operation_id:m.settlement_operation_id,ledger,ledgerConserved:true});
 }
 for(const sample of practice){
  const matches=(await db.query('SELECT count(*)::int AS n FROM wallet_matches WHERE match_id=$1',[sample.roomId])).rows[0].n;
  const ops=(await db.query('SELECT count(*)::int AS n FROM pvp_operations WHERE room_id=$1',[sample.roomId])).rows[0].n;
  assert.equal(matches,0,'practice must not create a wallet match');assert.equal(ops,0,'practice must not issue wallet commands');
  report.practice.push({game:sample.game,roomId:sample.roomId,walletMatches:matches,walletOperations:ops});
 }
 report.remainingActiveRooms=(await db.query("SELECT id,game_id,practice,status FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')")).rows;
 assert.equal(report.remainingActiveRooms.length,0,'no test room left active');
}catch(e){report.failure=e.stack;throw e;}
finally{fs.writeFileSync(new URL('../review/phase-e/wallet-readback.json',import.meta.url),JSON.stringify(report,null,2));await db.end();}
console.log(JSON.stringify({matches:report.matches.length,practice:report.practice.length,ledgerConserved:true,remainingActiveRooms:report.remainingActiveRooms.length}));
