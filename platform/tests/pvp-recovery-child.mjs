// Test-only worker: refuse the demo DB before importing modules that create connection pools.
import assert from 'node:assert/strict';
const expected=process.env.OASIS_EXPECT_TEST_DATABASE;
assert.match(expected||'',/^oasis_pvp_test_[0-9]+_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.OASIS_DATABASE_URL).pathname,'/'+expected);
const {pool,closePools}=await import('../server/db.mjs');
const {migratePvp,routePvp,tickPvp}=await import('../server/pvp/index.mjs');
const {session,room_id,advance}=JSON.parse(process.argv[2]);
try{assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,expected);await migratePvp();if(advance)await tickPvp({roomIds:[room_id]});const result=await routePvp(session,'GET','/api/pvp/rooms/'+room_id);process.stdout.write(JSON.stringify(result.body));}finally{await closePools();}
