import assert from 'node:assert/strict';
const name=new URL(process.env.OASIS_DATABASE_URL).pathname.slice(1);
assert.match(name,/^oasis_enginepool_test_\d+_[a-f0-9]{16}$/);
const{pool,closePools}=await import('../server/db.mjs');
const{routePvp,tickPvp}=await import('../server/pvp/index.mjs');
const{closeEnginePool}=await import('../server/pvp/engine-pool.mjs');
try{
  assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,name);
  const{sessions,roomId,body}=JSON.parse(process.argv[2]);
  const first=await routePvp(sessions[0],'POST',`/api/pvp/rooms/${roomId}/action`,body);
  const repeat=await routePvp(sessions[0],'POST',`/api/pvp/rooms/${roomId}/action`,body);assert.deepEqual(first,repeat);
  await routePvp(sessions[1],'POST',`/api/pvp/rooms/${roomId}/leave`,{request_id:'end_engine_pool_fixture'});await tickPvp({roomIds:[roomId]});
  process.stdout.write(JSON.stringify({status:first.status,seq:first.body.me_last_seq}));
}finally{await closeEnginePool();await closePools();}
