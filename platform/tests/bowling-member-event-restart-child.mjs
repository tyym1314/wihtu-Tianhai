// Run only as the isolated integration test's fresh-process child.
import assert from 'node:assert/strict';
const name=new URL(process.env.OASIS_DATABASE_URL).pathname.slice(1);
assert.match(name,/^oasis_pvp_test_\d+_[a-f0-9]{16}$/);
const{pool,closePools}=await import('../server/db.mjs');
const{routePvp}=await import('../server/pvp/index.mjs');
const{closeEnginePool}=await import('../server/pvp/engine-pool.mjs');
try{
  assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,name);
  const{session,roomId,body}=JSON.parse(process.argv[2]);
  const before=(await pool.query('SELECT game_state,players FROM pvp_rooms WHERE id=$1',[roomId])).rows[0];
  const stored=(await pool.query('SELECT response,response_status FROM pvp_requests WHERE app_id=$1 AND external_user_id=$2 AND request_id=$3',[session.app_id,session.external_user_id,body.request_id])).rows[0];
  const expected={status:stored.response_status,body:stored.response};
  assert.deepEqual(await routePvp(session,'POST',`/api/pvp/rooms/${roomId}/action`,body),expected);
  assert.deepEqual(await routePvp(session,'POST',`/api/pvp/rooms/${roomId}/action`,body),expected);
  assert.deepEqual((await pool.query('SELECT game_state,players FROM pvp_rooms WHERE id=$1',[roomId])).rows[0],before);
  const actions=(await pool.query('SELECT count(*)::int n FROM pvp_actions WHERE room_id=$1',[roomId])).rows[0].n;assert.equal(actions,1);
  process.stdout.write(JSON.stringify({replay:true,actions,unchanged:true}));
}finally{await closeEnginePool();await closePools();}
