// Child process used only by recovery-fairness.test.mjs. Never permit this
// fault-injection helper to attach to a development or deployed database.
import assert from 'node:assert/strict';
const name=new URL(process.env.OASIS_DATABASE_URL).pathname.slice(1);
assert.match(name,/^oasis_recovery_test_[0-9]+_[a-f0-9]{16}$/);
assert.ok(process.env.OASIS_LOCAL_DIR?.includes('oasis-recovery-test-'));
const {pool,closePools}=await import('../server/db.mjs');
const {advanceCycle,recoverPending}=await import('../server/cycles.mjs');
try{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
  if(process.argv[2])await advanceCycle(process.argv[2]);else await recoverPending();
}finally{await closePools();}
