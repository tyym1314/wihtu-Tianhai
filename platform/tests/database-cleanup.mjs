import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

// Explicit fixture families only: no working DB names and no arbitrary SQL identifiers.
const ownedName=/^oasis_(?:test_\d+_\d{13}|portal_test_[a-f0-9]{16}|(?:pvp|clock|enginepool|recovery)_test_\d+_[a-f0-9]{16}|credentials_\d+_[a-f0-9]{12}|self_test_\d+_[a-f0-9]{10}|binding_(?:wallet_)?\d+_[a-f0-9]{12}|runtime_(?:prod|sandbox|legacy)_\d+_[a-f0-9]{12}|release_test_\d+_[a-f0-9]{12})$/;

export async function dropOwnedTestDatabase(admin,name,{created=false,timeoutMs=3000}={}){
 assert.equal(created,true,'Only a database successfully created by this fixture may be deleted');
 assert.equal(typeof name,'string');assert(ownedName.test(name)&&Buffer.byteLength(name)<=63,'UNSAFE_TEST_DATABASE_NAME');
 assert(Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=3000,'INVALID_CLEANUP_TIMEOUT');
 const current=(await admin.query('SELECT current_database() AS name')).rows[0].name;
 assert.notEqual(current,name,'Cleanup requires a separate administrative connection');
 // pg-pool removes idle clients from its array before client.end() callbacks fire.
 // Its end() Promise alone therefore does not prove PostgreSQL has closed them.
 // Callers must first stop servers/children and end every owned pool. Never FORCE:
 // a leaking connection is a test failure, not something cleanup should conceal.
 const deadline=performance.now()+timeoutMs;let connections;
 do{
  connections=(await admin.query('SELECT pid,state,backend_type FROM pg_stat_activity WHERE datname=$1',[name])).rows;
  if(!connections.length)break;
  if(performance.now()>=deadline)break;
  await delay(Math.min(20,Math.max(1,deadline-performance.now())));
 }while(true);
 assert.equal(connections.length,0,`Owned test database ${name} still has connections: ${JSON.stringify(connections)}`);
 await admin.query(`DROP DATABASE "${name}"`);
 assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0,'ISOLATED_DATABASE_NOT_REMOVED');
}
